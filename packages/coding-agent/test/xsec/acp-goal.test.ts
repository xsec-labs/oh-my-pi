import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AcpAgent } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { type AgentSideConnection, RequestError } from "@oh-my-pi/pi-utils/acp";

const GOAL_GET_METHOD = "_xsec/session/goal/get";
const GOAL_CONTROL_METHOD = "_xsec/session/goal/control";
const INVALID_REQUEST_CODE = -32600;
const INVALID_PARAMS_CODE = -32602;
const INTERNAL_ERROR_CODE = -32603;
const RESOURCE_NOT_FOUND_CODE = -32002;
const SESSION_BUSY_CODE = -32003;

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

interface SessionOptions {
	sessionManager?: SessionManager;
	goalEnabled?: boolean;
}

/** A real session with `read`, `bash` and `goal` registered; only `read` starts enabled. */
function createSession({
	sessionManager = SessionManager.inMemory(),
	goalEnabled = true,
}: SessionOptions = {}): AgentSession {
	const read = createTool("read");
	const bash = createTool("bash");
	const goal = createTool("goal");
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: TEST_MODEL, systemPrompt: ["initial"], tools: [read], messages: [] },
		convertToLlm,
	});
	return new AgentSession({
		agent,
		sessionManager,
		settings: Settings.isolated({ "compaction.enabled": false, "goal.enabled": goalEnabled }),
		modelRegistry: { getApiKey: async () => "test-key", getAvailable: () => [TEST_MODEL] } as never,
		toolRegistry: new Map<string, AgentTool>([
			[read.name, read],
			[bash.name, bash],
			[goal.name, goal],
		]),
		builtInToolNames: ["read"],
		rebuildSystemPrompt: async () => ({ systemPrompt: ["initial"] }),
	});
}

let root = "";
const agents: AcpAgent[] = [];

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "xsec-goal-"));
});

afterEach(async () => {
	for (const agent of agents.splice(0)) {
		await agent.dispose();
	}
	await fs.rm(root, { recursive: true, force: true });
});

/** Opens an ACP session over `session`, the way a client's `session/new` does. */
async function openSession(
	session: AgentSession = createSession(),
): Promise<{ agent: AcpAgent; session: AgentSession; sessionId: string }> {
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
	const created = await agent.newSession({ cwd: root, mcpServers: [] });
	return { agent, session, sessionId: created.sessionId };
}

/** The error a rejected request carries, so its JSON-RPC code can be checked. */
async function rejectionOf(request: Promise<unknown>): Promise<RequestError> {
	try {
		await request;
	} catch (error) {
		if (error instanceof RequestError) return error;
		throw error;
	}
	throw new Error("expected the request to reject");
}

/** A transcript under `root`, persisted to disk so a session can switch to it later. */
async function persistedTranscript(name: string): Promise<SessionManager> {
	const manager = SessionManager.create(root, path.join(root, name));
	manager.appendModeChange("none");
	await manager.ensureOnDisk();
	return manager;
}

function fileOf(manager: SessionManager): string {
	const file = manager.getSessionFile();
	if (!file) throw new Error("expected a persisted transcript file");
	return file;
}

describe("_xsec/session/goal", () => {
	// Desktop reads `objective`, `status` and `startedAt`. The transcript must hold the same goal,
	// or a reopened session would lose it.
	it("creates an active goal, persists it to the transcript, and enables the goal tool", async () => {
		const { agent, session, sessionId } = await openSession();
		expect(await agent.extMethod(GOAL_GET_METHOD, { sessionId })).toEqual({ goal: null });

		const created = await agent.extMethod(GOAL_CONTROL_METHOD, {
			sessionId,
			action: "create",
			objective: "  ship the parser ",
		});

		const startedAt = session.getGoalModeState()?.goal.createdAt;
		expect(created).toEqual({ goal: { objective: "ship the parser", status: "active", startedAt } });
		expect(session.sessionManager.buildSessionContext().mode).toBe("goal");
		expect(session.getActiveToolNames()).toContain("goal");
		expect(await agent.extMethod(GOAL_GET_METHOD, { sessionId })).toEqual(created);
	});

	it("pauses and resumes a goal, moving the goal tool and the persisted mode with it", async () => {
		const { agent, session, sessionId } = await openSession();
		await agent.extMethod(GOAL_CONTROL_METHOD, { sessionId, action: "create", objective: "reach the goal" });
		const startedAt = session.getGoalModeState()?.goal.createdAt;

		const paused = await agent.extMethod(GOAL_CONTROL_METHOD, { sessionId, action: "pause" });
		expect(paused).toEqual({ goal: { objective: "reach the goal", status: "paused", startedAt } });
		expect(session.sessionManager.buildSessionContext().mode).toBe("goal_paused");
		expect(session.getActiveToolNames()).not.toContain("goal");

		const resumed = await agent.extMethod(GOAL_CONTROL_METHOD, { sessionId, action: "resume" });
		expect(resumed).toEqual({ goal: { objective: "reach the goal", status: "active", startedAt } });
		expect(session.getActiveToolNames()).toContain("goal");
	});

	// Editing replaces the goal (a new goal record), so the new goal's start time is the one reported.
	it("edits the objective of an active goal, starting a new goal record", async () => {
		const { agent, session, sessionId } = await openSession();
		await agent.extMethod(GOAL_CONTROL_METHOD, { sessionId, action: "create", objective: "first wording" });

		const edited = await agent.extMethod(GOAL_CONTROL_METHOD, {
			sessionId,
			action: "edit",
			objective: "narrower wording",
		});

		expect(edited).toEqual({
			goal: {
				objective: "narrower wording",
				status: "active",
				startedAt: session.getGoalModeState()?.goal.createdAt,
			},
		});
		expect(session.getActiveToolNames()).toContain("goal");
	});

	it("drops the goal, clears the transcript mode and the state, and disables the goal tool", async () => {
		const { agent, session, sessionId } = await openSession();
		await agent.extMethod(GOAL_CONTROL_METHOD, { sessionId, action: "create", objective: "abandon me" });

		expect(await agent.extMethod(GOAL_CONTROL_METHOD, { sessionId, action: "drop" })).toEqual({ goal: null });

		expect(await agent.extMethod(GOAL_GET_METHOD, { sessionId })).toEqual({ goal: null });
		expect(session.getGoalModeState()).toBeUndefined();
		expect(session.sessionManager.buildSessionContext().mode).toBe("none");
		expect(session.getActiveToolNames()).not.toContain("goal");
	});

	// Each row is a different state the action cannot apply to; the goal stays as it was.
	it("refuses an action that does not fit the goal's current state, and leaves the goal unchanged", async () => {
		const { agent, sessionId } = await openSession();
		const noGoal = [
			{ action: "pause" },
			{ action: "resume" },
			{ action: "drop" },
			{ action: "edit", objective: "no goal yet" },
		];
		for (const params of noGoal) {
			const error = await rejectionOf(agent.extMethod(GOAL_CONTROL_METHOD, { sessionId, ...params }));
			expect(error.code).toBe(INVALID_REQUEST_CODE);
		}

		await agent.extMethod(GOAL_CONTROL_METHOD, { sessionId, action: "create", objective: "first" });
		const activeGoal = await rejectionOf(
			agent.extMethod(GOAL_CONTROL_METHOD, { sessionId, action: "create", objective: "second" }),
		);
		expect(activeGoal.code).toBe(INVALID_REQUEST_CODE);
		const activeResume = await rejectionOf(agent.extMethod(GOAL_CONTROL_METHOD, { sessionId, action: "resume" }));
		expect(activeResume.code).toBe(INVALID_REQUEST_CODE);

		await agent.extMethod(GOAL_CONTROL_METHOD, { sessionId, action: "pause" });
		const pausedEdit = await rejectionOf(
			agent.extMethod(GOAL_CONTROL_METHOD, { sessionId, action: "edit", objective: "while paused" }),
		);
		expect(pausedEdit.code).toBe(INVALID_REQUEST_CODE);
		const pausedPause = await rejectionOf(agent.extMethod(GOAL_CONTROL_METHOD, { sessionId, action: "pause" }));
		expect(pausedPause.code).toBe(INVALID_REQUEST_CODE);

		expect(await agent.extMethod(GOAL_GET_METHOD, { sessionId })).toEqual({
			goal: expect.objectContaining({ objective: "first", status: "paused" }),
		});
	});

	it("refuses to start a goal while plan mode is on", async () => {
		const { agent, session, sessionId } = await openSession();
		session.setPlanModeState({ enabled: true, planFilePath: path.join(root, "plan.md") });

		const error = await rejectionOf(
			agent.extMethod(GOAL_CONTROL_METHOD, { sessionId, action: "create", objective: "later" }),
		);

		expect(error.code).toBe(INVALID_REQUEST_CODE);
		expect(await agent.extMethod(GOAL_GET_METHOD, { sessionId })).toEqual({ goal: null });
	});

	// `drop` is the wire name for abandoning a goal. `abandon` is not an action, so it must be refused.
	it("rejects control params that do not name a valid action or objective as invalid params", async () => {
		const { agent, sessionId } = await openSession();
		const invalidControl = [
			{ sessionId, action: "abandon" },
			{ sessionId, action: 7 },
			{ sessionId },
			{ sessionId, action: "create" },
			{ sessionId, action: "create", objective: "   " },
			{ sessionId, action: "edit", objective: 5 },
			{ sessionId, action: "pause", objective: "not now" },
			null,
		];
		for (const params of invalidControl) {
			const error = await rejectionOf(
				agent.extMethod(GOAL_CONTROL_METHOD, params as unknown as Record<string, unknown>),
			);
			expect(error.code).toBe(INVALID_PARAMS_CODE);
		}

		const invalidGet = [{}, { sessionId: 42 }, { sessionId: "" }, null];
		for (const params of invalidGet) {
			const error = await rejectionOf(
				agent.extMethod(GOAL_GET_METHOD, params as unknown as Record<string, unknown>),
			);
			expect(error.code).toBe(INVALID_PARAMS_CODE);
		}
	});

	it("reports an unknown session as resource not found for get and control", async () => {
		const { agent } = await openSession();

		const read = await rejectionOf(agent.extMethod(GOAL_GET_METHOD, { sessionId: "no-such-session" }));
		expect(read.code).toBe(RESOURCE_NOT_FOUND_CODE);

		const control = await rejectionOf(
			agent.extMethod(GOAL_CONTROL_METHOD, { sessionId: "no-such-session", action: "create", objective: "x" }),
		);
		expect(control.code).toBe(RESOURCE_NOT_FOUND_CODE);
	});

	// The session keeps its goal state across a transcript switch, so the goal is rebuilt from the
	// transcript on the next read. Switching away must show no goal; switching back must restore it.
	it("restores an active goal, and its goal tool, after the session switches away and back", async () => {
		const goalTranscript = await persistedTranscript("with-goal");
		const goalFile = fileOf(goalTranscript);
		const empty = await persistedTranscript("empty");
		const emptyFile = fileOf(empty);
		await empty.close();
		const session = createSession({ sessionManager: goalTranscript });
		const { agent, sessionId } = await openSession(session);
		await agent.extMethod(GOAL_CONTROL_METHOD, { sessionId, action: "create", objective: "survive the switch" });
		const goal = await agent.extMethod(GOAL_GET_METHOD, { sessionId });
		await session.sessionManager.flush();

		expect(await session.switchSession(emptyFile)).toBe(true);
		expect(await agent.extMethod(GOAL_GET_METHOD, { sessionId })).toEqual({ goal: null });
		expect(session.getActiveToolNames()).not.toContain("goal");

		expect(await session.switchSession(goalFile)).toBe(true);
		expect(await agent.extMethod(GOAL_GET_METHOD, { sessionId })).toEqual(goal);
		expect(session.getActiveToolNames()).toContain("goal");
	});

	it("restores a paused goal as paused, with the goal tool off, after the session switches away and back", async () => {
		const goalTranscript = await persistedTranscript("paused-goal");
		const goalFile = fileOf(goalTranscript);
		const empty = await persistedTranscript("empty-paused");
		const emptyFile = fileOf(empty);
		await empty.close();
		const session = createSession({ sessionManager: goalTranscript });
		const { agent, sessionId } = await openSession(session);
		await agent.extMethod(GOAL_CONTROL_METHOD, { sessionId, action: "create", objective: "wait for me" });
		await agent.extMethod(GOAL_CONTROL_METHOD, { sessionId, action: "pause" });
		const goal = await agent.extMethod(GOAL_GET_METHOD, { sessionId });
		await session.sessionManager.flush();

		expect(await session.switchSession(emptyFile)).toBe(true);
		expect(await agent.extMethod(GOAL_GET_METHOD, { sessionId })).toEqual({ goal: null });

		expect(await session.switchSession(goalFile)).toBe(true);
		expect(await agent.extMethod(GOAL_GET_METHOD, { sessionId })).toEqual(goal);
		expect(session.getActiveToolNames()).not.toContain("goal");
	});

	it("keeps each session's goal to that session", async () => {
		const first = await openSession();
		const second = await openSession();
		await first.agent.extMethod(GOAL_CONTROL_METHOD, {
			sessionId: first.sessionId,
			action: "create",
			objective: "first session only",
		});

		expect(await second.agent.extMethod(GOAL_GET_METHOD, { sessionId: second.sessionId })).toEqual({ goal: null });
	});

	// A turn that is still running may write to the transcript, so control waits for it to finish.
	// Reads stay available, and they report the goal the running turn left behind.
	it("refuses control while the session is busy, and still reads the goal", async () => {
		const { agent, session, sessionId } = await openSession();
		await agent.extMethod(GOAL_CONTROL_METHOD, { sessionId, action: "create", objective: "busy goal" });
		Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });

		const error = await rejectionOf(agent.extMethod(GOAL_CONTROL_METHOD, { sessionId, action: "pause" }));
		expect(error.code).toBe(SESSION_BUSY_CODE);
		expect(await agent.extMethod(GOAL_GET_METHOD, { sessionId })).toEqual({
			goal: expect.objectContaining({ objective: "busy goal", status: "active" }),
		});

		Reflect.deleteProperty(session, "isStreaming");
		expect(await agent.extMethod(GOAL_CONTROL_METHOD, { sessionId, action: "pause" })).toEqual({
			goal: expect.objectContaining({ objective: "busy goal", status: "paused" }),
		});
	});

	it("refuses to start a goal when goal mode is disabled in settings", async () => {
		const { agent, sessionId } = await openSession(createSession({ goalEnabled: false }));

		const error = await rejectionOf(
			agent.extMethod(GOAL_CONTROL_METHOD, { sessionId, action: "create", objective: "blocked" }),
		);

		expect(error.code).toBe(INVALID_REQUEST_CODE);
		expect(await agent.extMethod(GOAL_GET_METHOD, { sessionId })).toEqual({ goal: null });
	});

	it("does not restore a goal from the transcript while goal mode is disabled in settings", async () => {
		const goalTranscript = await persistedTranscript("disabled-restore");
		const { agent, sessionId } = await openSession(createSession({ sessionManager: goalTranscript }));
		await agent.extMethod(GOAL_CONTROL_METHOD, { sessionId, action: "create", objective: "stored goal" });
		await goalTranscript.flush();
		const file = fileOf(goalTranscript);

		const reopened = await openSession(
			createSession({ sessionManager: await SessionManager.open(file), goalEnabled: false }),
		);

		expect(await reopened.agent.extMethod(GOAL_GET_METHOD, { sessionId: reopened.sessionId })).toEqual({
			goal: null,
		});
		expect(reopened.session.getActiveToolNames()).not.toContain("goal");
	});

	it("reports a malformed goal in the transcript as an internal error", async () => {
		const { agent, session, sessionId } = await openSession();
		session.sessionManager.appendModeChange("goal", { goal: { id: 1 } });

		const error = await rejectionOf(agent.extMethod(GOAL_GET_METHOD, { sessionId }));

		expect(error.code).toBe(INTERNAL_ERROR_CODE);
	});
});
