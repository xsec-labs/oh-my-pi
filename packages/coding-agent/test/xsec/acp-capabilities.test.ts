import { afterEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AcpAgent } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { type AgentSideConnection, RequestError } from "@oh-my-pi/pi-utils/acp";

const CAPABILITIES_METHOD = "_xsec/session/capabilities";
const INVALID_PARAMS_CODE = -32602;
const RESOURCE_NOT_FOUND_CODE = -32002;

interface ToolCapability {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	source: string;
}

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

/** A real session with `read` and `bash` registered, where only `read` is enabled. */
function createSession(): AgentSession {
	const read = createTool("read");
	const bash = createTool("bash");
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: TEST_MODEL, systemPrompt: ["initial"], tools: [read], messages: [] },
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
		builtInToolNames: ["read"],
		rebuildSystemPrompt: async () => ({ systemPrompt: ["initial"] }),
	});
}

const agents: AcpAgent[] = [];

afterEach(async () => {
	for (const agent of agents.splice(0)) {
		await agent.dispose();
	}
});

/** Opens an ACP session over a fresh test session, the way a client's `session/new` does. */
async function openSession(): Promise<{ agent: AcpAgent; session: AgentSession; sessionId: string }> {
	const session = createSession();
	const connection = {
		sessionUpdate: async () => {},
		extNotification: async () => {},
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
	return { agent, session, sessionId: created.sessionId };
}

/** The error a rejected request carries, so its JSON-RPC code can be checked. */
async function rejectionOf(request: Promise<unknown>): Promise<unknown> {
	try {
		await request;
	} catch (error) {
		return error;
	}
	throw new Error("expected the request to reject");
}

describe("_xsec/session/capabilities", () => {
	// Desktop's capability inventory reads these fields. A missing schema or source leaves the tool unclassified.
	it("lists an enabled tool with its JSON Schema input and its source", async () => {
		const { agent, sessionId } = await openSession();

		const result = await agent.extMethod(CAPABILITIES_METHOD, { sessionId });
		const tools = result.tools as ToolCapability[];

		expect(tools.find(tool => tool.name === "read")).toMatchObject({
			name: "read",
			description: "read tool",
			source: "builtin",
			inputSchema: { type: "object", properties: { value: { type: "string" } } },
		});
	});

	// Without the enabled-set filter, Desktop would offer a tool the session cannot call.
	it("leaves out a registered tool that the session has not enabled", async () => {
		const { agent, session, sessionId } = await openSession();
		expect(session.getAllToolInfos().map(tool => tool.name)).toContain("bash");

		const result = await agent.extMethod(CAPABILITIES_METHOD, { sessionId });
		const tools = result.tools as ToolCapability[];

		expect(tools.map(tool => tool.name)).toEqual(["read"]);
	});

	// A client that sends a bad request must get invalid params, not a lookup of a session id that was never given.
	it("rejects params without a usable session id as invalid params", async () => {
		const { agent } = await openSession();

		for (const params of [{}, { sessionId: 42 }, { sessionId: "" }, null]) {
			const error = await rejectionOf(
				agent.extMethod(CAPABILITIES_METHOD, params as unknown as Record<string, unknown>),
			);
			expect(error).toBeInstanceOf(RequestError);
			expect((error as RequestError).code).toBe(INVALID_PARAMS_CODE);
		}
	});

	// A stale or unknown session must read as not-found, so a client can tell it apart from a malformed request.
	it("reports an unknown session as resource not found, not as invalid params", async () => {
		const { agent } = await openSession();

		const error = await rejectionOf(agent.extMethod(CAPABILITIES_METHOD, { sessionId: "no-such-session" }));

		expect(error).toBeInstanceOf(RequestError);
		expect((error as RequestError).code).toBe(RESOURCE_NOT_FOUND_CODE);
	});

	// An `_xsec/` method the fork does not implement is method-not-found, so a client can probe for it.
	it("answers method-not-found for an _xsec method it does not implement", async () => {
		const { agent } = await openSession();

		const error = await rejectionOf(agent.extMethod("_xsec/session/unknown", {}));

		expect(error).toBeInstanceOf(RequestError);
		expect(error).toMatchObject({ code: -32601 });
	});
});
