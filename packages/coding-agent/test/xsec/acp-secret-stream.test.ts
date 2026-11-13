import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { mapAgentSessionEventToAcpSessionUpdates } from "@oh-my-pi/pi-coding-agent/modes/acp/acp-event-mapper";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { type AcpSecretOwner, restoreAcpSessionEvents } from "@oh-my-pi/pi-coding-agent/xsec/acp-secret-stream";

/** Made-up values only: the fork is public. */
const SECRET = "Quill-Harbor-4471-Synthetic";

function obfuscatorWithSecret(): SecretObfuscator {
	return new SecretObfuscator(
		[{ type: "plain", content: SECRET, mode: "obfuscate", friendlyName: "ACME" }],
		"acp-secret-stream-unit-key",
	);
}

const message = { role: "assistant", content: [], timestamp: 0 } as unknown as AssistantMessage;

/**
 * One text or thinking block streamed delta by delta, and the text the ACP client receives for it: the
 * restorer's events go through the real mapper, so this is what the client is sent.
 */
function clientTextOf(obfuscator: SecretObfuscator, kind: "text" | "thinking", deltas: string[]): string {
	const owner: AcpSecretOwner = { obfuscator };
	const progress = { textEmitted: false, thoughtEmitted: false };
	const start = kind === "text" ? "text_start" : "thinking_start";
	const delta = kind === "text" ? "text_delta" : "thinking_delta";
	const end = kind === "text" ? "text_end" : "thinking_end";
	const update = (assistantMessageEvent: unknown): AgentSessionEvent =>
		({ type: "message_update", message, assistantMessageEvent }) as unknown as AgentSessionEvent;
	const events: AgentSessionEvent[] = [
		{ type: "message_start", message } as unknown as AgentSessionEvent,
		update({ type: start, contentIndex: 0, partial: message }),
		...deltas.map(text => update({ type: delta, contentIndex: 0, delta: text, partial: message })),
		update({ type: end, contentIndex: 0, content: deltas.join(""), partial: message }),
		{ type: "message_end", message } as unknown as AgentSessionEvent,
	];
	let text = "";
	for (const event of events.flatMap(next => restoreAcpSessionEvents(owner, next))) {
		for (const { update: chunk } of mapAgentSessionEventToAcpSessionUpdates(event, "session", {
			getMessageProgress: () => progress,
		})) {
			if (kind === "text" && chunk.sessionUpdate === "agent_message_chunk" && chunk.content.type === "text") {
				text += chunk.content.text;
			}
			if (kind === "thinking" && chunk.sessionUpdate === "agent_thought_chunk" && chunk.content.type === "text") {
				text += chunk.content.text;
			}
		}
	}
	return text;
}

describe("restoreAcpSessionEvents", () => {
	it("sends the same text whatever the cut points of the placeholders, in text and in thinking", () => {
		const obfuscator = obfuscatorWithSecret();
		const placeholder = obfuscator.obfuscate(SECRET);
		const reply = `a ${placeholder} b ${placeholder}$ c $$ d $$AB`;
		const whole = obfuscator.deobfuscate(reply);
		expect(whole).toContain(SECRET);

		for (let cut = 0; cut <= reply.length; cut++) {
			expect(clientTextOf(obfuscator, "text", [reply.slice(0, cut), reply.slice(cut)])).toBe(whole);
			expect(clientTextOf(obfuscator, "thinking", [reply.slice(0, cut), reply.slice(cut)])).toBe(whole);
		}
		expect(clientTextOf(obfuscator, "text", Array.from(reply))).toBe(whole);
		expect(clientTextOf(obfuscator, "thinking", Array.from(reply))).toBe(whole);
	});

	it("keeps a $$ that is not a placeholder, and sends a partial placeholder when its block ends", () => {
		const obfuscator = obfuscatorWithSecret();
		expect(clientTextOf(obfuscator, "text", ["cost $$", " and $$AB"])).toBe("cost $$ and $$AB");
	});

	it("sends a delta at once when the session has no secrets, and holds back a possible placeholder when it has some", () => {
		const event = {
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "cost $$AB", partial: message },
		} as unknown as AgentSessionEvent;
		const [unmasked] = restoreAcpSessionEvents({ obfuscator: undefined }, event);
		const [masked] = restoreAcpSessionEvents({ obfuscator: obfuscatorWithSecret() }, event);
		expect(unmasked).toMatchObject({ assistantMessageEvent: { delta: "cost $$AB" } });
		expect(masked).toMatchObject({ assistantMessageEvent: { delta: "cost " } });
	});

	it("restores the arguments and the intent of a tool call, which the client shows", () => {
		const obfuscator = obfuscatorWithSecret();
		const placeholder = obfuscator.obfuscate(SECRET);
		const event = {
			type: "tool_execution_start",
			toolCallId: "call_1",
			toolName: "write",
			args: { path: "note.txt", content: `token ${placeholder}` },
			intent: `save ${placeholder}`,
		} as AgentSessionEvent;
		const [restored] = restoreAcpSessionEvents({ obfuscator }, event);
		expect(restored).toMatchObject({
			args: { path: "note.txt", content: `token ${SECRET}` },
			intent: `save ${SECRET}`,
		});
	});
});
