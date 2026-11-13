/**
 * A local OpenAI-compatible chat completions endpoint: the only model provider a contract test
 * configures. It answers from a script and records every request it receives. A reply can be held
 * open until the client disconnects, so a test can cancel a turn that is still running.
 */

/** One scripted answer: `content` is streamed as text deltas, or `hold` keeps the response open instead. */
export interface ScriptedReply {
	content: string[];
	hold?: boolean;
}

export interface FakeModelServer {
	/** Base URL for the provider in `models.yml`, ending in `/v1`. */
	readonly baseUrl: string;
	/** The body of every chat completions request received so far, in order. */
	readonly requests: unknown[];
	/** Queues the answer to the next request. A request with nothing queued is answered with `ok`. */
	enqueue(reply: ScriptedReply): void;
	/** Resolves once at least `count` requests have been received. */
	waitForRequests(count: number): Promise<void>;
	stop(): void;
}

interface Waiter {
	count: number;
	resolve: () => void;
}

const FALLBACK_REPLY: ScriptedReply = { content: ["ok"] };

export function startFakeModelServer(): FakeModelServer {
	const requests: unknown[] = [];
	const queue: ScriptedReply[] = [];
	let waiters: Waiter[] = [];

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const { pathname } = new URL(request.url);
			if (request.method !== "POST" || !pathname.endsWith("/chat/completions")) {
				return new Response("not found", { status: 404 });
			}
			const body: unknown = await request.json();
			requests.push(body);
			const ready = waiters.filter(waiter => requests.length >= waiter.count);
			waiters = waiters.filter(waiter => requests.length < waiter.count);
			for (const waiter of ready) waiter.resolve();
			return streamReply(queue.shift() ?? FALLBACK_REPLY);
		},
	});

	return {
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
		requests,
		enqueue(reply) {
			queue.push(reply);
		},
		waitForRequests(count) {
			if (requests.length >= count) return Promise.resolve();
			return new Promise<void>(resolve => {
				waiters.push({ count, resolve });
			});
		},
		stop() {
			server.stop(true);
		},
	};
}

function streamReply(reply: ScriptedReply): Response {
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
			for (const text of reply.content) controller.enqueue(event(chunk({ content: text }, null)));
			controller.enqueue(event(chunk({}, "stop")));
			controller.enqueue(encoder.encode("data: [DONE]\n\n"));
			controller.close();
		},
	});
	return new Response(body, { headers: { "content-type": "text/event-stream" } });
}
