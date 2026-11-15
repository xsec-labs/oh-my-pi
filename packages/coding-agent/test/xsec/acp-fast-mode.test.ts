import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AcpAgent } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-agent";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { modelSupportsFastMode } from "@oh-my-pi/pi-coding-agent/xsec/acp-fast-mode";
import type { AgentSideConnection, SessionConfigOption } from "@oh-my-pi/pi-utils/acp";

function model(provider: string, api: Api, id: string): Model {
	return buildModel({
		id,
		name: id,
		api,
		provider,
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	});
}

const openai = model("openai", "openai-responses", "gpt-5");
const codex = model("openai-codex", "openai-codex-responses", "gpt-5.5");
const anthropic = model("anthropic", "anthropic-messages", "claude-opus-4-6");
const gemini = model("google", "google-generative-ai", "gemini-3-flash");
const deepseek = model("deepseek", "openai-completions", "deepseek-v4-pro");

describe("modelSupportsFastMode", () => {
	it("accepts models whose service-tier family takes the priority tier", () => {
		expect(modelSupportsFastMode(openai)).toBe(true);
		expect(modelSupportsFastMode(anthropic)).toBe(true);
		expect(modelSupportsFastMode(gemini)).toBe(true);
	});

	it("rejects a model with no service-tier family", () => {
		expect(modelSupportsFastMode(deepseek)).toBe(false);
	});

	it("rejects an OpenAI-family model whose advertised tiers omit priority", () => {
		expect(modelSupportsFastMode({ ...codex, serviceTiers: ["ultrafast" as const] })).toBe(false);
	});
});

const FAST_MODEL = anthropic;
const PLAIN_MODEL = deepseek;

let root = "";
const agents: AcpAgent[] = [];

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "xsec-fast-mode-"));
});

afterEach(async () => {
	for (const agent of agents.splice(0)) {
		await agent.dispose();
	}
	await fs.rm(root, { recursive: true, force: true });
});

/** A real session on `current`, with the two test models available to choose from. */
function createSession(current: Model): AgentSession {
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: current, systemPrompt: ["initial"], tools: [], messages: [] },
		convertToLlm,
	});
	return new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: {
			getApiKey: async () => "test-key",
			getAvailable: () => [FAST_MODEL, PLAIN_MODEL],
		} as never,
		toolRegistry: new Map(),
		builtInToolNames: [],
		rebuildSystemPrompt: async () => ({ systemPrompt: ["initial"] }),
	});
}

/** Opens an ACP session over `session`, the way a client's `session/new` does. */
async function openSession(
	session: AgentSession,
): Promise<{ agent: AcpAgent; sessionId: string; configOptions: SessionConfigOption[] }> {
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
	return { agent, sessionId: created.sessionId, configOptions: created.configOptions ?? [] };
}

describe("ACP Fast option", () => {
	it("is offered on a model that takes the priority tier, and each model choice says which ones do", async () => {
		const { configOptions } = await openSession(createSession(FAST_MODEL));

		expect(configOptions.find(option => option.id === "fast")).toMatchObject({
			type: "select",
			currentValue: "off",
			options: [{ value: "off" }, { value: "on" }],
		});
		const modelOption = configOptions.find(option => option.id === "model");
		const choices = modelOption?.type === "select" ? modelOption.options : [];
		expect(choices.find(choice => choice.value === "anthropic/claude-opus-4-6")?._meta).toEqual({ fastMode: true });
		expect(choices.find(choice => choice.value === "deepseek/deepseek-v4-pro")?._meta).toEqual({ fastMode: false });
	});

	it("applies on and off through setSessionConfigOption, and rejects an unknown value", async () => {
		const { agent, sessionId } = await openSession(createSession(FAST_MODEL));

		const enabled = await agent.setSessionConfigOption({ sessionId, configId: "fast", value: "on" });
		expect(enabled.configOptions.find(option => option.id === "fast")).toMatchObject({ currentValue: "on" });

		const disabled = await agent.setSessionConfigOption({ sessionId, configId: "fast", value: "off" });
		expect(disabled.configOptions.find(option => option.id === "fast")).toMatchObject({ currentValue: "off" });

		await expect(agent.setSessionConfigOption({ sessionId, configId: "fast", value: "ultra" })).rejects.toThrow(
			"Unknown ACP fast mode: ultra",
		);
	});

	it("is not offered on a model without the priority tier, and turning it on there is an error", async () => {
		const { agent, sessionId, configOptions } = await openSession(createSession(PLAIN_MODEL));

		expect(configOptions.find(option => option.id === "fast")).toBeUndefined();
		await expect(agent.setSessionConfigOption({ sessionId, configId: "fast", value: "on" })).rejects.toThrow(
			"Fast mode is unavailable for the current model.",
		);
	});
});
