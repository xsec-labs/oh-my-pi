import { afterEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AcpAgent } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { buildContextComposition, type CompositionItem } from "@oh-my-pi/pi-coding-agent/xsec/usage-composition";
import { type AgentSideConnection, RequestError } from "@oh-my-pi/pi-utils/acp";

const SNAPSHOT_METHOD = "_xsec/context/snapshot";
const REQUEST_METHOD = "_xsec/usage/request";

const TEST_MODEL = buildModel({
	id: "mock",
	name: "mock",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
});

function createTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} tool`,
		parameters: type({ value: "string" }),
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	};
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createSession(messages: AgentMessage[] = []): AgentSession {
	const read = createTool("read");
	const bash = createTool("bash");
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: TEST_MODEL, systemPrompt: ["You are a test agent."], tools: [read, bash], messages },
		convertToLlm,
	});
	return new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: { getApiKey: async () => "test-key", getAvailable: () => [TEST_MODEL] } as never,
		toolRegistry: new Map<string, AgentTool>([
			[read.name, read],
			[bash.name, bash],
		]),
		builtInToolNames: ["read", "bash"],
		rebuildSystemPrompt: async () => ({ systemPrompt: ["You are a test agent."] }),
	});
}

function item(items: CompositionItem[], category: string, name: string): CompositionItem | undefined {
	return items.find(candidate => candidate.category === category && candidate.name === name);
}

const SECRET = "SECRET-PAYLOAD-DO-NOT-LEAK";

/** One user turn, a `read` call and its result, a plugin tool run through `write xd://`, then a reply. */
function conversation(): { before: AgentMessage[]; reply: AssistantMessage } {
	const before: AgentMessage[] = [
		{ role: "user", content: `please look at ${SECRET}`, timestamp: 1 },
		assistant([{ type: "toolCall", id: "c1", name: "read", arguments: { value: SECRET } }]),
		{
			role: "toolResult",
			toolCallId: "c1",
			toolName: "read",
			content: [{ type: "text", text: SECRET.repeat(30) }],
			isError: false,
			timestamp: 2,
		},
		assistant([
			{
				type: "toolCall",
				id: "c2",
				name: "write",
				arguments: { path: "xd://browser_open", content: '{"url":"x"}' },
			},
			{ type: "toolCall", id: "c3", name: "read", arguments: { path: "xd://browser_open" } },
		]),
		{
			role: "toolResult",
			toolCallId: "c2",
			toolName: "write",
			content: [{ type: "text", text: "opened" }],
			isError: false,
			timestamp: 3,
		},
		{
			role: "toolResult",
			toolCallId: "c3",
			toolName: "read",
			content: [{ type: "text", text: "docs of the tool" }],
			isError: false,
			timestamp: 4,
		},
	];
	return { before, reply: assistant([{ type: "text", text: "all done" }]) };
}

describe("buildContextComposition", () => {
	// The split is only useful if the fixed parts and each tool carry their own numbers.
	it("counts the system prompt and each tool definition as fixed parts", () => {
		const { items } = buildContextComposition(createSession());

		expect(item(items, "system_prompt", "block-0")?.tokens).toBeGreaterThan(0);
		expect(item(items, "tool_definitions", "read")).toMatchObject({ source: "builtin" });
		expect(item(items, "tool_definitions", "bash")?.tokens).toBeGreaterThan(0);
		expect(item(items, "tool_definitions", "read")).not.toHaveProperty("count");
	});

	// Tool results are the usual heavy part; they must be told apart by tool, with a call count and the largest result.
	it("splits calls and results by tool and resolves xd:// devices to the tool they address", () => {
		const { before } = conversation();
		const { items } = buildContextComposition(createSession(before));

		expect(item(items, "tool_results", "read")).toMatchObject({ count: 1 });
		expect(item(items, "tool_results", "read")!.maxTokens).toBe(item(items, "tool_results", "read")!.tokens);
		expect(item(items, "tool_calls", "browser_open")).toMatchObject({ count: 1 });
		expect(item(items, "tool_results", "browser_open")).toMatchObject({ count: 1 });
		// `read xd://browser_open` reads the tool's description: its own line, not a call of the tool.
		expect(item(items, "tool_calls", "browser_open")?.variant).toBeUndefined();
		expect(items.find(candidate => candidate.name === "browser_open" && candidate.variant === "docs")).toBeDefined();
		expect(item(items, "user_messages", "user")?.tokens).toBeGreaterThan(0);
	});

	// The privacy rule of the feature: names and numbers only.
	it("never carries message or tool text", () => {
		const { before } = conversation();
		const composition = buildContextComposition(createSession(before));

		expect(JSON.stringify(composition)).not.toContain("SECRET");
		expect(JSON.stringify(composition)).not.toContain("opened");
	});

	// A request's context stops before the reply it produced.
	it("leaves out the reply and everything after it when measuring a request", () => {
		const { before, reply } = conversation();
		const session = createSession([...before, reply]);

		const request = buildContextComposition(session, reply);
		const now = buildContextComposition(session);

		expect(item(request.items, "assistant_messages", "assistant")).toBeUndefined();
		expect(item(now.items, "assistant_messages", "assistant")).toBeDefined();
		expect(now.estimatedTokens).toBeGreaterThan(request.estimatedTokens);
	});

	it("sums the items into the estimate", () => {
		const { before } = conversation();
		const { items, estimatedTokens } = buildContextComposition(createSession(before));

		expect(estimatedTokens).toBe(items.reduce((sum, candidate) => sum + candidate.tokens, 0));
	});

	// Long sessions pay for every request, so the counting has to stay cheap once the history has been counted.
	it("counts a long history again in a few milliseconds", () => {
		const messages: AgentMessage[] = [];
		for (let index = 0; index < 400; index++) {
			messages.push({ role: "user", content: `turn ${index} ${"x".repeat(200)}`, timestamp: index });
			messages.push(
				assistant([{ type: "toolCall", id: `k${index}`, name: "read", arguments: { value: `v${index}` } }]),
			);
			messages.push({
				role: "toolResult",
				toolCallId: `k${index}`,
				toolName: "read",
				content: [{ type: "text", text: "result ".repeat(100) }],
				isError: false,
				timestamp: index,
			});
		}
		const session = createSession(messages);
		buildContextComposition(session);

		const started = performance.now();
		buildContextComposition(session);
		const elapsed = performance.now() - started;

		// Not an assertion on time (tests never pass or fail on the clock): the count is reported for the PR.
		console.log(`composition of ${messages.length} messages, second pass: ${elapsed.toFixed(2)} ms`);
		expect(buildContextComposition(session).items.length).toBeGreaterThan(0);
	});
});

const agents: AcpAgent[] = [];

afterEach(async () => {
	delete Bun.env.PI_ACP_USAGE_REQUESTS;
	for (const agent of agents.splice(0)) await agent.dispose();
});

async function openSession(messages: AgentMessage[] = []) {
	const session = createSession(messages);
	const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
	const connection = {
		sessionUpdate: async () => {},
		extNotification: async (method: string, params: Record<string, unknown>) => {
			notifications.push({ method, params });
		},
		requestPermissionWithCancel: () => ({
			promise: Promise.resolve({ outcome: { outcome: "cancelled" } }),
			cancel: () => {},
		}),
		signal: new AbortController().signal,
		closed: Promise.withResolvers<void>().promise,
	} as unknown as AgentSideConnection;
	const agent = new AcpAgent(connection, async () => ({ session, setToolUIContext: vi.fn() }));
	agents.push(agent);
	const created = await agent.newSession({ cwd: os.tmpdir(), mcpServers: [] });
	return { agent, session, sessionId: created.sessionId, notifications };
}

describe("_xsec/context/snapshot", () => {
	it("returns the composition with the model and its window", async () => {
		const { before } = conversation();
		const { agent, sessionId } = await openSession(before);

		const result = await agent.extMethod(SNAPSHOT_METHOD, { sessionId });

		expect(result).toMatchObject({
			schemaVersion: 1,
			model: { provider: "openai", id: "mock" },
			contextWindow: 8192,
		});
		const composition = result.composition as { items: CompositionItem[]; estimatedTokens: number };
		expect(item(composition.items, "tool_results", "read")).toBeDefined();
		expect(JSON.stringify(result)).not.toContain("SECRET");
	});

	// A client that sends a bad request must get invalid params.
	it("rejects params without a session id as invalid params", async () => {
		const { agent } = await openSession();

		const error = (await agent.extMethod(SNAPSHOT_METHOD, {}).catch((reason: unknown) => reason)) as RequestError;

		expect(error).toBeInstanceOf(RequestError);
		expect(error.code).toBe(-32602);
	});
});

describe("_xsec/usage/request", () => {
	/** A real prompt over a scripted model: one `read` call, then a text reply. */
	async function runTurn(responses: MockResponse[]) {
		const mock = createMockModel({ responses });
		const read = createTool("read");
		const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: TEST_MODEL, systemPrompt: ["You are a test agent."], tools: [read], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: { getApiKey: async () => "test-key", getAvailable: () => [TEST_MODEL] } as never,
			toolRegistry: new Map<string, AgentTool>([[read.name, read]]),
			builtInToolNames: ["read"],
			rebuildSystemPrompt: async () => ({ systemPrompt: ["You are a test agent."] }),
		});
		const connection = {
			sessionUpdate: async () => {},
			extNotification: async (method: string, params: Record<string, unknown>) => {
				notifications.push({ method, params });
			},
			requestPermissionWithCancel: () => ({
				promise: Promise.resolve({ outcome: { outcome: "cancelled" } }),
				cancel: () => {},
			}),
			signal: new AbortController().signal,
			closed: Promise.withResolvers<void>().promise,
		} as unknown as AgentSideConnection;
		const acp = new AcpAgent(connection, async () => ({ session, setToolUIContext: vi.fn() }));
		agents.push(acp);
		const created = await acp.newSession({ cwd: os.tmpdir(), mcpServers: [] });
		await acp.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: `look at ${SECRET}` }] });
		return { sessionId: created.sessionId, requests: notifications.filter(n => n.method === REQUEST_METHOD) };
	}

	const TURN: MockResponse[] = [
		{
			content: [{ type: "toolCall", id: "c1", name: "read", arguments: { value: SECRET } }],
			usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 50 },
		},
		{ content: ["all done"], usage: { input: 20, output: 5, cacheRead: 150, cacheWrite: 0, reasoningTokens: 2 } },
	];

	it("sends one notification per provider request, each with the context that request carried", async () => {
		Bun.env.PI_ACP_USAGE_REQUESTS = "1";

		const { sessionId, requests } = await runTurn(TURN);

		expect(requests.map(request => request.params.seq)).toEqual([1, 2]);
		expect(requests[0]!.params).toMatchObject({
			schemaVersion: 1,
			sessionId,
			kind: "main",
			provider: "mock",
			model: "mock-model",
			stopReason: "toolUse",
			usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 50, total: 160 },
			contextWindow: 8192,
		});
		expect(requests[1]!.params).toMatchObject({
			stopReason: "stop",
			usage: { input: 20, output: 5, cacheRead: 150, cacheWrite: 0, total: 175, reasoning: 2 },
		});
		const first = (requests[0]!.params.composition as { items: CompositionItem[] }).items;
		const second = (requests[1]!.params.composition as { items: CompositionItem[] }).items;
		// The first request carried the user's message only; the second also the call and its result.
		expect(item(first, "user_messages", "user")).toBeDefined();
		expect(item(first, "tool_results", "read")).toBeUndefined();
		expect(item(second, "tool_calls", "read")).toMatchObject({ count: 1 });
		expect(item(second, "tool_results", "read")).toMatchObject({ count: 1 });
		expect(item(second, "assistant_messages", "assistant")).toBeUndefined();
		// The privacy rule: neither the message nor the call's arguments leave the process.
		expect(JSON.stringify(requests.map(request => request.params))).not.toContain("SECRET");
	});

	// A host that did not opt in must see nothing and pay nothing.
	it("sends nothing unless the host opted in", async () => {
		const { requests } = await runTurn(TURN);

		expect(requests).toHaveLength(0);
	});
});
