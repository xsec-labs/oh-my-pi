/**
 * Restores secret placeholders (`$$NAME_HASH$$`) in a session journal for `omp session pack --restore-secrets`.
 *
 * With `secrets.enabled` the journal holds what the model wrote with placeholders in it: assistant text,
 * thinking, tool-call arguments and intent, and the branch and compaction summaries. The placeholders can only be
 * turned back into the values with the obfuscator of the machine that wrote them (its rules and its key), so a
 * session that moves to another machine must be restored before it leaves. User, developer and tool-result
 * messages are stored as written and are never rewritten.
 *
 * Only the copy that goes into the archive changes; the local journal is not touched.
 */
import type { SecretObfuscator } from "../secrets/obfuscator";
import { mapJsonStrings } from "../secrets/placeholder-scan";
import { PLACEHOLDER_RE } from "../secrets/placeholder";
import type { JsonValue } from "../secrets/obfuscator";

/** What a restore pass found. `unrestored` counts placeholders still in model-written text afterwards. */
export interface RestoreSecretsReport {
	/** Placeholders turned back into text. */
	restored: number;
	/** Placeholders left as they were: this obfuscator cannot resolve them (another key, or a rule that no longer exists). */
	unrestored: number;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function countPlaceholders(text: string): number {
	PLACEHOLDER_RE.lastIndex = 0;
	return text.match(PLACEHOLDER_RE)?.length ?? 0;
}

/** Roles whose stored text is exactly what a person or tool produced: they teach the obfuscator, they are not rewritten. */
function isLiteralRole(role: unknown): boolean {
	return role === "user" || role === "developer" || role === "toolResult";
}

/**
 * Shows the obfuscator the literal text of the journal. A placeholder minted for a regex rule only resolves after
 * the obfuscator has met the value it stands for, which is what a live session does before the model ever sees it.
 */
function prime(obfuscator: SecretObfuscator, journalText: string): void {
	for (const line of journalText.split("\n")) {
		if (!line.includes('"message"')) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) continue;
		if (!isLiteralRole(entry.message.role)) continue;
		obfuscator.obfuscateObject(entry.message);
	}
}

function restoreBlocks(content: unknown, restore: (text: string) => string): unknown {
	if (!Array.isArray(content)) return content;
	return content.map(block => {
		if (!isRecord(block)) return block;
		switch (block.type) {
			case "text":
				return typeof block.text === "string" ? { ...block, text: restore(block.text) } : block;
			case "thinking":
				return typeof block.thinking === "string" ? { ...block, thinking: restore(block.thinking) } : block;
			case "toolCall": {
				const next: JsonRecord = { ...block };
				if (isRecord(block.arguments)) next.arguments = mapJsonStrings(block.arguments as JsonValue, restore);
				if (typeof block.intent === "string") next.intent = restore(block.intent);
				if (typeof block.rawBlock === "string") next.rawBlock = restore(block.rawBlock);
				return next;
			}
			default:
				return block;
		}
	});
}

function restoreEntry(entry: JsonRecord, restore: (text: string) => string): JsonRecord {
	switch (entry.type) {
		case "message": {
			const message = entry.message;
			if (!isRecord(message)) return entry;
			if (message.role === "assistant")
				return { ...entry, message: { ...message, content: restoreBlocks(message.content, restore) } };
			if (message.role === "branchSummary" || message.role === "compactionSummary") {
				const next: JsonRecord = { ...message };
				if (typeof message.summary === "string") next.summary = restore(message.summary);
				if (typeof message.shortSummary === "string") next.shortSummary = restore(message.shortSummary);
				return { ...entry, message: next };
			}
			return entry;
		}
		case "compaction":
		case "branch_summary": {
			const next: JsonRecord = { ...entry };
			if (typeof entry.summary === "string") next.summary = restore(entry.summary);
			if (typeof entry.shortSummary === "string") next.shortSummary = restore(entry.shortSummary);
			return next;
		}
		default:
			return entry;
	}
}

/**
 * Returns the journal with placeholders restored in model-written text, and what was found (placeholders that could
 * not be restored are counted too). Lines that are not
 * model-written (and lines that did not change) are kept byte for byte.
 */
export function restoreJournalSecrets(
	journalText: string,
	obfuscator: SecretObfuscator | undefined,
): { text: string; report: RestoreSecretsReport } {
	const report: RestoreSecretsReport = { restored: 0, unrestored: 0 };
	if (!journalText.includes("$$")) return { text: journalText, report };
	// Without an obfuscator that has secrets nothing can be restored, but the placeholders are still counted.
	const active = obfuscator?.hasSecrets() ? obfuscator : undefined;
	if (active) prime(active, journalText);
	let changed = false;
	const restore = (text: string): string => {
		const before = countPlaceholders(text);
		if (before === 0) return text;
		const out = active ? active.deobfuscate(text) : text;
		if (out !== text) changed = true;
		const after = countPlaceholders(out);
		report.restored += Math.max(0, before - after);
		report.unrestored += after;
		return out;
	};
	const lines = journalText.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (!line.includes("$$")) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(entry)) continue;
		changed = false;
		const next = restoreEntry(entry, restore);
		if (changed) lines[i] = JSON.stringify(next);
	}
	return { text: lines.join("\n"), report };
}
