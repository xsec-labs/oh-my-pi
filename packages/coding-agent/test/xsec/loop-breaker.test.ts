import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const bashTool: AgentTool = {
	name: "bash",
	label: "Bash",
	description: "Mock bash tool",
	parameters: type({ "command?": "string" }),
	execute: async () => ({ content: [{ type: "text" as const, text: "same output" }] }),
};

const bash = (command: string, text?: string) => ({
	content: [...(text ? [text] : []), { type: "toolCall" as const, name: "bash", arguments: { command } }],
});

describe("loop breaker", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-loop-breaker-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("openai", "openai-test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
	});

	async function run(responses: ReturnType<typeof bash>[], overrides: Record<string, unknown>) {
		const mock = createMockModel({
			provider: "openai",
			responses: [...responses, { content: ["unexpected extra model call"] }],
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"model.toolCallLoopGuard.enabled": true,
			"model.toolCallLoopGuard.threshold": 2,
			"model.toolCallLoopGuard.exemptTools": [],
			...overrides,
		});
		settings.setModelRole("default", `${mock.provider}/${mock.id}`);
		session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model: mock, systemPrompt: ["Test"], tools: [bashTool], messages: [] },
				convertToLlm,
				streamFn: mock.stream,
			}),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map([[bashTool.name, bashTool]]),
		});
		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice") notices.push(event.message);
		});
		await session.prompt("keep going");
		await session.waitForIdle();
		return { mock, notices, messages: session.agent.state.messages };
	}

	function closingText(messages: readonly { role: string }[]): string | undefined {
		const last = messages.at(-1) as
			| { role: string; stopReason?: string; content?: Array<{ type: string; text?: string }> }
			| undefined;
		if (last?.role !== "assistant" || last.stopReason !== "stop") return undefined;
		return last.content?.map(part => part.text ?? "").join("");
	}

	it("ends the run with an explanation once identical calls outlive the redirect", async () => {
		const { mock, notices, messages } = await run(Array.from({ length: 8 }, () => bash("ls")), {
			"model.toolCallLoopGuard.hardLimit": 2,
		});
		// threshold 2 + hardLimit 2: the fourth identical turn ends the run before a fifth model call.
		expect(mock.calls).toHaveLength(4);
		expect(closingText(messages)).toContain("重复");
		expect(messages.filter(m => m.role === "custom" && m.customType === "tool-call-loop-redirect")).toHaveLength(2);
		expect(notices).toEqual([]);
	});

	it("never stops the run when hardLimit is 0", async () => {
		const { mock, messages } = await run(Array.from({ length: 6 }, () => bash("ls")), {
			"model.toolCallLoopGuard.hardLimit": 0,
		});
		expect(mock.calls).toHaveLength(7);
		expect(closingText(messages)).toBe("unexpected extra model call");
	});

	it("redirects an alternating cycle after three cycles and stops it after the hard limit", async () => {
		const responses = Array.from({ length: 20 }, (_, i) => bash(i % 2 === 0 ? "make" : "cat build.log"));
		const { mock, messages } = await run(responses, { "model.toolCallLoopGuard.hardLimit": 2 });
		// threshold 2 gives a cycle floor of 3 cycles (6 turns); hardLimit 2 adds one cycle (2 turns): stop on turn 8.
		expect(mock.calls).toHaveLength(8);
		expect(closingText(messages)).toContain("同一组 2 个工具调用");
		expect(messages.filter(m => m.role === "custom" && m.customType === "loop-breaker-redirect")).toHaveLength(2);
	});

	it("stops identical prose across tool-calling turns even when the calls differ", async () => {
		const prose = "Let me check the configuration file once more to make sure the values are exactly what we expect.";
		const responses = Array.from({ length: 10 }, (_, i) => bash(`cmd-${i}`, prose));
		const { mock, messages } = await run(responses, { "model.toolCallLoopGuard.hardLimit": 1 });
		expect(mock.calls).toHaveLength(3);
		expect(closingText(messages)).toContain("相同的内容");
	});

	it("leaves varied work alone", async () => {
		const { mock, messages } = await run(Array.from({ length: 12 }, (_, i) => bash(`cmd-${i}`)), {
			"model.toolCallLoopGuard.hardLimit": 1,
		});
		expect(mock.calls).toHaveLength(13);
		expect(closingText(messages)).toBe("unexpected extra model call");
	});
});
