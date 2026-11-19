import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

describe("AgentSession.withdrawQueuedCustomMessages", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-withdraw-queued-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("openai", "openai-test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		authStorage.close();
		tempDir.removeSync();
		AsyncJobManager.resetForTests();
	});

	it("takes back a queued steer by its details before the model reads it, and leaves the rest", async () => {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const modelRegistry = new ModelRegistry(authStorage);
		const contexts: Context[] = [];
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const slowTool: AgentTool = {
			name: "slow",
			label: "Slow",
			description: "Blocks until released",
			parameters: type({}),
			execute: async () => {
				started.resolve();
				await release.promise;
				return { content: [{ type: "text", text: "SLOW_DONE" }] };
			},
		};
		let callCount = 0;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [slowTool], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				contexts.push(context);
				const first = callCount++ === 0;
				const message: AssistantMessage = {
					role: "assistant",
					content: first
						? [{ type: "toolCall", id: "tc-0", name: "slow", arguments: {} }]
						: [{ type: "text", text: "Done." }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: zeroUsage,
					stopReason: first ? "toolUse" : "stop",
					timestamp: Date.now(),
				};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: first ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry,
			toolRegistry: new Map([[slowTool.name, slowTool]]),
		});

		const run = session.prompt("go");
		await started.promise;
		for (const id of ["a", "b"]) {
			await session.sendCustomMessage(
				{ customType: "xsec-guidance", content: `STEER_${id}`, display: false, details: { guidanceId: id } },
				{ deliverAs: "steer" },
			);
		}
		expect(session.agent.peekSteeringQueue()).toHaveLength(2);

		const sameId = (id: string) => (details: unknown) =>
			(details as { guidanceId?: string } | undefined)?.guidanceId === id;
		expect(session.withdrawQueuedCustomMessages("other-type", sameId("a"))).toBe(0);
		expect(session.withdrawQueuedCustomMessages("xsec-guidance", sameId("a"))).toBe(1);
		expect(session.withdrawQueuedCustomMessages("xsec-guidance", sameId("a"))).toBe(0);
		expect(session.agent.peekSteeringQueue()).toHaveLength(1);

		release.resolve();
		await run;
		await session.waitForIdle();

		const seen = JSON.stringify(contexts.flatMap(context => context.messages));
		expect(seen).toContain("STEER_b");
		expect(seen).not.toContain("STEER_a");
		// Once the loop has taken it, withdrawing answers 0: it counts as delivered.
		expect(session.withdrawQueuedCustomMessages("xsec-guidance", sameId("b"))).toBe(0);
	});
});
