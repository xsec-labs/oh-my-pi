import { describe, expect, it } from "bun:test";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import { restoreJournalSecrets } from "@oh-my-pi/pi-coding-agent/xsec/session-restore-secrets";

const SECRET = "hunter2hunter2";
const TOKEN = "tok_abcd1234efgh";

function plain(key = "key-one"): SecretObfuscator {
	return new SecretObfuscator([{ type: "plain", content: SECRET, mode: "obfuscate" }], key);
}

function line(entry: unknown): string {
	return JSON.stringify(entry);
}

function assistant(content: unknown[]) {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "m",
		stopReason: "stop",
	};
}

function journal(...entries: unknown[]): string {
	return `${[line({ type: "session", id: "a", cwd: "/x" }), ...entries.map(line)].join("\n")}\n`;
}

describe("restoreJournalSecrets", () => {
	it("restores assistant text, thinking, tool-call arguments and intent, and the summaries", () => {
		const o = plain();
		const ph = o.obfuscate(SECRET);
		const text = journal(
			{
				type: "message",
				id: "1",
				message: assistant([
					{ type: "thinking", thinking: `use ${ph}`, thinkingSignature: "sig" },
					{ type: "text", text: `login with ${ph}` },
					{
						type: "toolCall",
						id: "t",
						name: "bash",
						arguments: { command: `pw ${ph}`, n: 1 },
						intent: `use ${ph}`,
					},
				]),
			},
			{ type: "branch_summary", id: "2", fromId: "1", summary: `tried ${ph}` },
			{
				type: "compaction",
				id: "3",
				summary: `used ${ph}`,
				shortSummary: `short ${ph}`,
				firstKeptEntryId: "1",
				tokensBefore: 1,
			},
		);
		const result = restoreJournalSecrets(text, o);
		expect(result.text).not.toContain(ph);
		for (const want of [
			`use ${SECRET}`,
			`login with ${SECRET}`,
			`pw ${SECRET}`,
			`tried ${SECRET}`,
			`used ${SECRET}`,
			`short ${SECRET}`,
		]) {
			expect(result.text).toContain(want);
		}
		expect(result.text).toContain('"thinkingSignature":"sig"');
		expect(result.report).toEqual({ restored: 7, unrestored: 0 });
	});

	it("never rewrites user, developer or tool-result messages, and keeps lines that did not change byte for byte", () => {
		const o = plain();
		const ph = o.obfuscate(SECRET);
		const user = line({
			type: "message",
			id: "1",
			message: { role: "user", content: `literal ${ph} typed by a person`, timestamp: 1 },
		});
		const tool = line({
			type: "message",
			id: "2",
			message: { role: "toolResult", content: [{ type: "text", text: `out ${ph}` }] },
		});
		const other = '{"type":"label","id":"3",  "targetId":"1","label":"spaced   out"}';
		const text = `${line({ type: "session", id: "a", cwd: "/x" })}\n${user}\n${tool}\n${other}\n`;
		const result = restoreJournalSecrets(text, o);
		expect(result.text).toBe(text);
		expect(result.report).toEqual({ restored: 0, unrestored: 0 });
	});

	it("leaves placeholders it cannot resolve and counts them", () => {
		const sender = plain("key-one");
		const ph = sender.obfuscate(SECRET);
		const receiver = new SecretObfuscator(
			[{ type: "plain", content: "another-secret-1", mode: "obfuscate" }],
			"key-two",
		);
		const text = journal({ type: "message", id: "1", message: assistant([{ type: "text", text: `a ${ph} b` }]) });
		const withOther = restoreJournalSecrets(text, receiver);
		expect(withOther.text).toBe(text);
		expect(withOther.report).toEqual({ restored: 0, unrestored: 1 });
		const withNone = restoreJournalSecrets(text, undefined);
		expect(withNone.text).toBe(text);
		expect(withNone.report).toEqual({ restored: 0, unrestored: 1 });
	});

	it("restores a regex placeholder after the literal value shows up in the journal", () => {
		const entry = { type: "regex", content: "tok_[a-z0-9]{12}", mode: "obfuscate", friendlyName: "Token" } as const;
		const live = new SecretObfuscator([entry], "key-one");
		const ph = live.obfuscate(`token ${TOKEN}`).slice("token ".length);
		expect(ph).toMatch(/^\$\$.+\$\$$/);
		const text = journal(
			{
				type: "message",
				id: "1",
				message: { role: "toolResult", content: [{ type: "text", text: `out ${TOKEN}` }] },
			},
			{ type: "message", id: "2", message: assistant([{ type: "text", text: `use ${ph}` }]) },
		);
		// A new process has not met the value yet: only the literal text in the journal teaches it.
		const fresh = new SecretObfuscator([entry], "key-one");
		const result = restoreJournalSecrets(text, fresh);
		expect(result.text).toContain(`use ${TOKEN}`);
		expect(result.report).toEqual({ restored: 1, unrestored: 0 });
	});

	it("ignores text without placeholders and shell $$", () => {
		const o = plain();
		const text = journal({
			type: "message",
			id: "1",
			message: assistant([{ type: "toolCall", id: "t", name: "bash", arguments: { command: "echo $$ $$HOME" } }]),
		});
		const result = restoreJournalSecrets(text, o);
		expect(result.text).toBe(text);
		expect(result.report).toEqual({ restored: 0, unrestored: 0 });
	});
});
