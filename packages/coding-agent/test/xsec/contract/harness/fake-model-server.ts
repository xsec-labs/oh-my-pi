/**
 * A local OpenAI-compatible chat completions endpoint: the only model provider a contract test
 * configures. It answers from a script and records every request it receives. A reply can be held
 * open until the client disconnects, so a test can cancel a turn that is still running.
 */
import { isRecord } from "@oh-my-pi/pi-utils";

/**
 * One scripted answer: `content` is streamed as text deltas, or `hold` keeps the response open instead.
 * `content` may be a function of the request body, for an answer that depends on what the test has already
 * seen (a placeholder the client sent). `thinking` is streamed first as reasoning deltas. `toolCall` streams a
 * tool call in place of the text, so the client runs that tool with `arguments`.
 */
export interface ScriptedReply {
	content: string[] | ((request: unknown) => string[]);
	thinking?: string[];
	hold?: boolean;
	toolCall?: { name: string; arguments: string };
}

export interface FakeModelServer {
	/** Base URL for the provider in `models.yml`, ending in `/v1`. */
	readonly baseUrl: string;
	/** The body of every chat completions request received so far, in order. */
	readonly requests: unknown[];
	/** The exact bytes of every request body, in the order received: what a provider's wire carries. */
	readonly rawRequests: string[];
	/** Queues the answer to the next request that no route claims. A request with nothing queued is answered with `ok`. */
	enqueue(reply: ScriptedReply): void;
	/** Answers every request whose user messages contain `userText` with `reply`, without taking from the queue. */
	route(userText: string, reply: ScriptedReply): void;
	/** Resolves once at least `count` requests have been received. */
	waitForRequests(count: number): Promise<void>;
	/** Resolves once at least `count` requests whose user messages contain `userText` have been received. */
	waitForUserText(userText: string, count: number): Promise<void>;
	/** Resolves once at least `count` requests whose body contains `text` in any message, of any role, have been received. */
	waitForText(text: string, count: number): Promise<void>;
	stop(): void;
}

interface Waiter {
	satisfied: () => boolean;
	resolve: () => void;
}

const FALLBACK_REPLY: ScriptedReply = { content: ["ok"] };

export function startFakeModelServer(): FakeModelServer {
	const requests: unknown[] = [];
	const rawRequests: string[] = [];
	const queue: ScriptedReply[] = [];
	const routes: { userText: string; reply: ScriptedReply }[] = [];
	let waiters: Waiter[] = [];

	function until(satisfied: () => boolean): Promise<void> {
		if (satisfied()) return Promise.resolve();
		return new Promise<void>(resolve => {
			waiters.push({ satisfied, resolve });
		});
	}

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const { pathname } = new URL(request.url);
			if (request.method !== "POST" || !pathname.endsWith("/chat/completions")) {
				return new Response("not found", { status: 404 });
			}
			const raw = await request.text();
			const body: unknown = JSON.parse(raw);
			requests.push(body);
			rawRequests.push(raw);
			// A route answers without taking from the queue, so the queued replies keep the order they were queued in.
			const text = userTextOf(body);
			const route = routes.find(candidate => text.includes(candidate.userText));
			const reply = route?.reply ?? queue.shift() ?? FALLBACK_REPLY;
			const ready = waiters.filter(waiter => waiter.satisfied());
			waiters = waiters.filter(waiter => !ready.includes(waiter));
			for (const waiter of ready) waiter.resolve();
			return streamReply(reply, body);
		},
	});

	return {
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
		requests,
		rawRequests,
		enqueue(reply) {
			queue.push(reply);
		},
		route(userText, reply) {
			routes.push({ userText, reply });
		},
		waitForRequests(count) {
			return until(() => requests.length >= count);
		},
		waitForUserText(userText, count) {
			return until(() => requests.filter(body => userTextOf(body).includes(userText)).length >= count);
		},
		waitForText(text, count) {
			return until(() => requests.filter(body => JSON.stringify(body).includes(text)).length >= count);
		},
		stop() {
			server.stop(true);
		},
	};
}

/** The text of every user message in a chat completions request body, as JSON, so a marker is found in any part. */
function userTextOf(body: unknown): string {
	if (!isRecord(body) || !Array.isArray(body.messages)) return "";
	return body.messages
		.filter((message: unknown) => isRecord(message) && message.role === "user")
		.map((message: unknown) => JSON.stringify(isRecord(message) ? message.content : ""))
		.join("\n");
}

function streamReply(reply: ScriptedReply, request: unknown): Response {
	const encoder = new TextEncoder();
	const event = (payload: unknown): Uint8Array => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
	const chunk = (delta: Record<string, unknown>, finishReason: string | null): unknown => ({
		id: "chatcmpl-contract",
		object: "chat.completion.chunk",
		created: 0,
		model: "fake-model",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	});
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(event(chunk({ role: "assistant", content: "" }, null)));
			// A held reply stays open; the client's disconnect is what ends it.
			if (reply.hold) return;
			for (const text of reply.thinking ?? []) controller.enqueue(event(chunk({ reasoning_content: text }, null)));
			if (reply.toolCall) {
				const { name, arguments: args } = reply.toolCall;
				const call = { index: 0, id: "call_contract", type: "function", function: { name, arguments: args } };
				controller.enqueue(event(chunk({ tool_calls: [call] }, null)));
				controller.enqueue(event(chunk({}, "tool_calls")));
				controller.enqueue(encoder.encode("data: [DONE]\n\n"));
				controller.close();
				return;
			}
			const content = typeof reply.content === "function" ? reply.content(request) : reply.content;
			for (const text of content) controller.enqueue(event(chunk({ content: text }, null)));
			controller.enqueue(event(chunk({}, "stop")));
			controller.enqueue(encoder.encode("data: [DONE]\n\n"));
			controller.close();
		},
	});
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
