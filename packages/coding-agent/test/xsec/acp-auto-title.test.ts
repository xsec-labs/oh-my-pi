import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { cfgTitleGenerator } from "@oh-my-pi/pi-coding-agent/utils/title-settings";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { clearOmpExtensionCliRoots } from "@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots";
import { AcpAgent } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AgentSideConnection } from "@oh-my-pi/pi-utils/acp";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";

const STOP = "stop test ACP mode";

const MODEL = buildModel({
	id: "title-model",
	name: "title-model",
	api: "openai-completions",
	provider: "deepseek",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
});

// `runRootCommand` registers the CLI's extension roots process-wide.
afterEach(() => {
	clearOmpExtensionCliRoots();
});

type Startup = { noTitleEnv: string | undefined; autoTitle: boolean | undefined; generator: string };

/** Boots `omp --mode acp` up to the first `session/new` and reports what the host asked for. */
async function startAcp(env: { PI_ACP_AUTO_TITLE?: string; noTitle?: boolean }): Promise<Startup> {
	const { runRootCommand } = await import("@oh-my-pi/pi-coding-agent/main");
	const dir = TempDir.createSync("@omp-acp-auto-title-");
	const authStorage = createInMemoryAuthStorage();
	const previousNoTitle = Bun.env.PI_NO_TITLE;
	const previousAuto = Bun.env.PI_ACP_AUTO_TITLE;
	delete Bun.env.PI_NO_TITLE;
	if (env.PI_ACP_AUTO_TITLE === undefined) delete Bun.env.PI_ACP_AUTO_TITLE;
	else Bun.env.PI_ACP_AUTO_TITLE = env.PI_ACP_AUTO_TITLE;
	const settings = Settings.isolated({ "marketplace.autoUpdate": "off" });
	let observed: Startup | undefined;
	try {
		await runRootCommand(
			{
				mode: "acp",
				noTitle: env.noTitle,
				messages: [],
				fileArgs: [],
				unknownFlags: new Map(),
				unrecognizedFlags: [],
				invalidFlagValues: [],
				noSkills: true,
				noRules: true,
				noTools: true,
				noLsp: true,
				noExtensions: true,
				sessionDir: dir.path(),
			},
			[],
			{
				discoverAuthStorage: async () => authStorage,
				settings,
				createAgentSession: async options => {
					observed = {
						noTitleEnv: Bun.env.PI_NO_TITLE,
						autoTitle: options?.autoTitle,
						generator: cfgTitleGenerator.get(settings),
					};
					throw new Error(STOP);
				},
				runAcpMode: async createAcpSession => {
					await createAcpSession(dir.path());
					throw new Error(STOP);
				},
			},
		);
	} catch (error) {
		if (!(error instanceof Error) || error.message !== STOP) throw error;
	} finally {
		if (previousNoTitle === undefined) delete Bun.env.PI_NO_TITLE;
		else Bun.env.PI_NO_TITLE = previousNoTitle;
		if (previousAuto === undefined) delete Bun.env.PI_ACP_AUTO_TITLE;
		else Bun.env.PI_ACP_AUTO_TITLE = previousAuto;
		authStorage.close();
		await dir.remove();
	}
	if (!observed) throw new Error("Expected ACP mode to create a session");
	return observed;
}

describe("PI_ACP_AUTO_TITLE", () => {
	it("keeps ACP untitled by default", async () => {
		const observed = await startAcp({});
		expect(observed.noTitleEnv).toBe("1");
		expect(observed.autoTitle).not.toBe(true);
	});

	it("names ACP sessions with plain titles when the host opts in", async () => {
		const observed = await startAcp({ PI_ACP_AUTO_TITLE: "1" });
		expect(observed.noTitleEnv).toBeUndefined();
		expect(observed.autoTitle).toBe(true);
		expect(observed.generator).toBe("tiny");
	});

	it("lets --no-title win over the opt-in", async () => {
		const observed = await startAcp({ PI_ACP_AUTO_TITLE: "1", noTitle: true });
		expect(observed.noTitleEnv).toBe("1");
		expect(observed.autoTitle).not.toBe(true);
	});
});

let root = "";
const agents: AcpAgent[] = [];

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "xsec-auto-title-"));
});

afterEach(async () => {
	for (const agent of agents.splice(0)) await agent.dispose();
	await fs.rm(root, { recursive: true, force: true });
});

function createSession(): AgentSession {
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: MODEL, systemPrompt: ["initial"], tools: [], messages: [] },
		convertToLlm,
	});
	return new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: {
			getApiKey: async () => "test-key",
			getAvailable: () => [MODEL],
			hasConfiguredAuth: () => true,
			refreshSelectedModelMetadata: async (model: unknown) => model,
			clearSuppressedSelector: () => {},
		} as never,
		toolRegistry: new Map(),
		builtInToolNames: [],
		rebuildSystemPrompt: async () => ({ systemPrompt: ["initial"] }),
	});
}

/** Polls `condition` until it holds; the bound only turns a hang into a failure. */
async function until(condition: () => boolean, what: string): Promise<void> {
	for (let attempt = 0; attempt < 500; attempt++) {
		if (condition()) return;
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for ${what}`);
}

type InfoUpdate = { sessionUpdate: string; title?: string };

async function openSession(session: AgentSession): Promise<InfoUpdate[]> {
	const updates: InfoUpdate[] = [];
	const connection = {
		sessionUpdate: async (params: { update: InfoUpdate }) => {
			updates.push(params.update);
		},
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
	await agent.newSession({ cwd: root, mcpServers: [] });
	// The bootstrap guard opens lifetime delivery; its available-commands update marks that it ran.
	await until(
		() => updates.some(update => update.sessionUpdate === "available_commands_update"),
		"the bootstrap updates",
	);
	return updates;
}

describe("ACP session title push", () => {
	it("pushes a generated title that lands after the session was opened", async () => {
		const session = createSession();
		const updates = await openSession(session);

		await session.sessionManager.setSessionName("Fix login redirect", "auto");

		await until(
			() =>
				updates.some(
					update => update.sessionUpdate === "session_info_update" && update.title === "Fix login redirect",
				),
			"the title update",
		);
	});

	it("leaves a user rename to the slash command, which notifies the client itself", async () => {
		const session = createSession();
		const updates = await openSession(session);
		const before = updates.length;

		await session.sessionManager.setSessionName("Mine", "user");

		expect(updates.slice(before).filter(update => update.sessionUpdate === "session_info_update")).toEqual([]);
	});
});
