import { afterEach, describe, expect, it, vi } from "bun:test";
import * as os from "node:os";
import type { UserMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AcpAgent } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { type AgentSideConnection } from "@oh-my-pi/pi-utils/acp";
import { isRecord } from "@oh-my-pi/pi-utils";

const CONTINUE_META = { xsec: { continue: true } };

type ScriptedStream = MockModel["stream"];

interface SentUpdate {
	sessionId: string;
	update: { sessionUpdate: string };
}

interface OpenedSession {
	agent: AcpAgent;
	sessionId: string;
	updates: SentUpdate[];
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

const agents: AcpAgent[] = [];

afterEach(async () => {
	for (const agent of agents.splice(0)) {
		await agent.dispose();
	}
});

/** A real session whose model calls go to `streamFn`, holding `messages` as its conversation so far. */
async function openSession(streamFn: ScriptedStream, messages: UserMessage[]): Promise<OpenedSession> {
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: TEST_MODEL, systemPrompt: ["initial"], tools: [], messages },
		convertToLlm,
		streamFn,
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: { getApiKey: async () => "test-key", getAvailable: () => [TEST_MODEL] } as never,
		toolRegistry: new Map(),
		builtInToolNames: [],
		rebuildSystemPrompt: async () => ({ systemPrompt: ["initial"] }),
	});
	const updates: SentUpdate[] = [];
	const connection = {
		sessionUpdate: async (notification: SentUpdate) => {
			updates.push(notification);
		},
		extNotification: async () => {},
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
	return { agent: acp, sessionId: created.sessionId, updates };
}

function userMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: 0 };
}

/** The text of each user message in a model request, in order. */
function userTexts(messages: ReadonlyArray<{ role: string; content: unknown }>): string[] {
	return messages.flatMap(message => {
		if (message.role !== "user") return [];
		if (typeof message.content === "string") return [message.content];
		if (!Array.isArray(message.content)) return [];
		return message.content.flatMap(block => (isRecord(block) && typeof block.text === "string" ? [block.text] : []));
	});
}

/** The error a rejected request carries. */
async function rejectionOf(request: Promise<unknown>): Promise<unknown> {
	try {
		await request;
	} catch (error) {
		return error;
	}
	throw new Error("expected the request to reject");
}

describe("session/prompt with _meta.xsec.continue", () => {
	// Desktop sends no text of its own on a continue, so the stored conversation must be resumed, not the request text sent.
	it("resumes the unfinished turn, streams it to the client, and does not send the request text", async () => {
		const mock = createMockModel({ responses: [{ content: ["picked up where it stopped"] }] });
		const { agent, sessionId, updates } = await openSession(mock.stream, [userMessage("write the parser")]);

		const response = await agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "not sent" }],
			_meta: CONTINUE_META,
		});

		expect(response.stopReason).toBe("end_turn");
		expect(mock.calls).toHaveLength(1);
		const sent = userTexts(mock.calls[0]?.context.messages ?? []);
		expect(sent).toContain("write the parser");
		expect(sent).not.toContain("not sent");
		expect(updates.some(update => update.update.sessionUpdate === "agent_message_chunk")).toBe(true);
	});

	// A continue with nothing to resume must fail the request; running a turn with no conversation would send the model an empty prompt.
	it("rejects a continue on a session with nothing to resume, without calling the model", async () => {
		const mock = createMockModel({ responses: [{ content: ["unused"] }] });
		const { agent, sessionId } = await openSession(mock.stream, []);

		const error = await rejectionOf(
			agent.prompt({ sessionId, prompt: [{ type: "text", text: "not sent" }], _meta: CONTINUE_META }),
		);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("Nothing to resume");
		expect(mock.calls).toHaveLength(0);
	});

	// Without the flag, the request text is what the model receives, and a value other than the boolean true is not a continue.
	it("sends the request text as an ordinary prompt when the flag is absent or not the boolean true", async () => {
		for (const meta of [undefined, { xsec: { continue: false } }, { xsec: { continue: "true" } }]) {
			const mock = createMockModel({ responses: [{ content: ["done"] }] });
			const { agent, sessionId } = await openSession(mock.stream, [userMessage("write the parser")]);

			const response = await agent.prompt({
				sessionId,
				prompt: [{ type: "text", text: "ordinary text" }],
				_meta: meta,
			});

			expect(response.stopReason).toBe("end_turn");
			expect(mock.calls).toHaveLength(1);
			expect(userTexts(mock.calls[0]?.context.messages ?? [])).toContain("ordinary text");
		}
	});

	// A cancel during a resumed turn must settle the request as cancelled, as it does for an ordinary turn.
	it("settles a continued turn that is cancelled with a cancelled stop reason", async () => {
		const started = Promise.withResolvers<void>();
		const mock = createMockModel({ responses: [{ content: ["never finishes"], delayMs: 60_000 }] });
		const streamFn: ScriptedStream = (model, context, options) => {
			started.resolve();
			return mock.stream(model, context, options);
		};
		const { agent, sessionId } = await openSession(streamFn, [userMessage("write the parser")]);

		const pending = agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "not sent" }],
			_meta: CONTINUE_META,
		});
		await started.promise;
		await agent.cancel({ sessionId });

		expect((await pending).stopReason).toBe("cancelled");
	});
});
