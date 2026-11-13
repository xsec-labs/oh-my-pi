import { afterEach, describe, expect, it, vi } from "bun:test";
import { Agent, type AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Context } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "../../src/config/settings";
import { SecretObfuscator } from "../../src/secrets";
import { AgentSession } from "../../src/session/agent-session";
import { SessionManager } from "../../src/session/session-manager";
import { createAssistantMessage } from "../helpers/agent-session-setup";

/** A made-up value of the kind a secret rule matches. It reaches a side request only if masking misses it. */
const SECRET = "SIDE-TURN-KEY-5520";
/** A placeholder as the session writes it: a key, an optional hint, and `$$` on both sides. */
const PLACEHOLDER = /\$\$(?:[A-Z0-9]+_)?[A-Z0-9]{4,}(?::[ULCM])?\$\$/;

const sessions: AgentSession[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const session of sessions.splice(0)) await session.dispose();
});

function createModelRegistryStub(key = "key") {
	return {
		getApiKey: vi.fn(async () => key),
		resolver: vi.fn(() => async () => key),
		authStorage: { usage: { ingestHeaders: vi.fn() }, oauth: { identity: vi.fn() } },
		hasLazyRuntimeMetadata: vi.fn(() => false),
	};
}

/**
 * Runs one side turn (`/btw`, the completion probe and idle maintenance all take this path) and returns the context
 * its request carried. The system prompt names the key, and the history holds a reminder the harness wrote, the
 * kind an async job leaves behind (`attribution: "agent"`). The side request is captured where it leaves the session.
 */
async function sideTurnContext(
	obfuscator: SecretObfuscator | undefined,
): Promise<{ context: Context; replyText: string }> {
	let captured: Context | undefined;
	const messages: AgentMessage[] = [
		{
			role: "custom",
			customType: "async-result",
			content: `Reminder: the key is ${SECRET}.`,
			display: true,
			attribution: "agent",
			timestamp: 1,
		},
	];
	const session = new AgentSession({
		agent: new Agent({
			initialState: {
				model: getBundledModel("openai", "gpt-4o-mini"),
				systemPrompt: [`Project folder: ${SECRET}.`],
				messages,
				tools: [],
			},
		}),
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: createModelRegistryStub() as never,
		obfuscator,
		sideStreamFn: (_model, context) => {
			captured = context;
			const stream = new AssistantMessageEventStream();
			const message = createAssistantMessage("noted");
			stream.push({ type: "text_delta", contentIndex: 0, delta: "noted", partial: message });
			stream.push({ type: "done", reason: "stop", message });
			return stream;
		},
	});
	sessions.push(session);
	const { replyText } = await session.runEphemeralTurn({ promptText: `the key is ${SECRET}` });
	if (captured === undefined) throw new Error("the side turn sent no request");
	return { context: captured, replyText };
}

describe("side turn requests with secrets on", () => {
	it("send the system prompt and the harness-written reminder masked, and the reply still reads back", async () => {
		const { context, replyText } = await sideTurnContext(new SecretObfuscator([{ type: "plain", content: SECRET }]));

		expect(replyText).toBe("noted");
		// The provider receives no copy of the value in any part of the request, and sees the session's placeholder.
		expect(JSON.stringify(context)).not.toContain(SECRET);
		expect(context.systemPrompt?.join("\n")).toMatch(PLACEHOLDER);
		expect(JSON.stringify(context.messages.filter(message => message.role === "developer"))).toMatch(PLACEHOLDER);
	});
});

describe("side turn requests with secrets off", () => {
	it("control: the system prompt and the reminder carry the real value", async () => {
		const { context } = await sideTurnContext(undefined);

		// Without this control, the case above could pass because the request never carried the value.
		expect(context.systemPrompt?.join("\n")).toContain(SECRET);
		expect(JSON.stringify(context.messages)).toContain(SECRET);
	});
});
