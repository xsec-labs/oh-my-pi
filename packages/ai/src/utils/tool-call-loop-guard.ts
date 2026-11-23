import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "../types";

const LEGACY_INTENT_FIELD = "__intent";
const RESULT_SUMMARY_LIMIT = 200;
const ARGUMENT_SUMMARY_LIMIT = 400;

/** Runtime settings for cross-turn tool-call repetition detection. */
export interface ToolCallLoopGuardOptions {
	readonly threshold: number;
	readonly exemptTools: readonly string[];
	/**
	 * Extra repetitions tolerated after the corrective steer before the detection
	 * escalates to `level: "abort"`. `0` (default) never escalates, leaving the
	 * stop decision to the caller.
	 */
	readonly hardLimit?: number;
	/** Lets transport calls inherit an exemption from their dispatched tool without exempting the transport itself. */
	readonly exemptionAlias?: (call: ToolCall) => string | undefined;
}

/** A completed assistant turn plus the tool results it produced. */
export interface ToolCallLoopTurn {
	readonly message: AssistantMessage;
	readonly toolResults: readonly ToolResultMessage[];
	/** The turn also delivered context outside its tool results (extension `additionalContext`). */
	readonly injectedContext?: boolean;
}

/**
 * What repeated:
 * - `repeated_tool_call`: the same tool call(s) on consecutive turns;
 * - `repeated_tool_cycle`: a short sequence of turns (period 2 or 3) cycling, e.g. A, B, A, B;
 * - `repeated_text`: the same assistant prose on consecutive tool-calling turns.
 */
export type RepeatedToolCallKind = "repeated_tool_call" | "repeated_tool_cycle" | "repeated_text";

/** Details needed to steer the model away from a repeated tool call. */
export interface RepeatedToolCallDetection {
	readonly kind: RepeatedToolCallKind;
	readonly toolName: string;
	/** Repetitions seen: consecutive turns, or full cycles for `repeated_tool_cycle`. */
	readonly count: number;
	readonly resultSummary: string;
	readonly argumentsSummary: string;
	/**
	 * `redirect`: steer the model. `abort`: the steer was ignored for `hardLimit`
	 * more repetitions, so the caller should end the run.
	 */
	readonly level: "redirect" | "abort";
	/** Turns per cycle; only for `repeated_tool_cycle`. */
	readonly period?: number;
}

/** Shortest assistant prose that counts as a repeated-text signal; short acks repeat legitimately. */
const REPEATED_TEXT_MIN_CHARS = 80;
/** Turn history kept for cycle detection. */
const CYCLE_HISTORY_LIMIT = 24;
const CYCLE_PERIODS = [2, 3] as const;
/** A cycle must repeat at least this many full times, whatever the threshold: two passes is normal retrying. */
const CYCLE_MIN_REPEATS = 3;

interface TurnRecord {
	readonly hash: string;
	readonly toolName: string;
	readonly argumentsSummary: string;
	readonly resultSummary: string;
}

function canonicalizeToolCallValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(item => canonicalizeToolCallValue(item));
	}
	if (!value || typeof value !== "object") {
		return value;
	}

	const input = value as Record<string, unknown>;
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(input).sort()) {
		if (key === INTENT_FIELD || key === LEGACY_INTENT_FIELD) continue;
		output[key] = canonicalizeToolCallValue(input[key]);
	}
	return output;
}

function summarizeText(text: string, limit: number): string {
	let summary = text.replace(/\s+/g, " ").trim();
	if (summary.length > limit) {
		summary = `${summary.slice(0, limit)}…`;
	}
	return summary;
}

function summarizeToolResult(toolResults: readonly ToolResultMessage[], toolCallId: string): string {
	const result = toolResults.find(candidate => candidate.toolCallId === toolCallId);
	if (!result) return "";

	const textParts: string[] = [];
	for (const block of result.content) {
		if (block.type === "text") {
			textParts.push(block.text);
		}
	}
	return summarizeText(textParts.join("\n"), RESULT_SUMMARY_LIMIT);
}

/** Detects consecutive identical assistant tool calls across model turns. */
export class ToolCallLoopGuard {
	#threshold: number;
	#exemptTools: ReadonlySet<string>;
	#exemptionAlias: ((call: ToolCall) => string | undefined) | undefined;
	#hardLimit: number;
	#lastHash: string | undefined;
	#count = 0;
	#history: TurnRecord[] = [];
	#lastText: string | undefined;
	#textCount = 0;

	/** Keeps transport-specific exemption policy outside the shared repetition detector. */
	constructor(options: ToolCallLoopGuardOptions) {
		this.#threshold = Math.max(1, Math.trunc(options.threshold));
		this.#exemptTools = new Set(options.exemptTools);
		this.#exemptionAlias = options.exemptionAlias;
		this.#hardLimit = Math.max(0, Math.trunc(options.hardLimit ?? 0));
	}

	#resetRun(): void {
		this.#lastHash = undefined;
		this.#count = 0;
		this.#history = [];
		this.#lastText = undefined;
		this.#textCount = 0;
	}

	#levelFor(count: number, threshold: number, hardLimit: number): "redirect" | "abort" {
		return hardLimit > 0 && count >= threshold + hardLimit ? "abort" : "redirect";
	}

	/** Applies the same exemption policy when counting turns and choosing the reported call. */
	#isExempt(call: ToolCall): boolean {
		if (this.#exemptTools.has(call.name)) return true;
		const alias = this.#exemptionAlias?.(call);
		return alias !== undefined && this.#exemptTools.has(alias);
	}

	/** Records one completed turn and reports repetitions at or beyond the threshold. */
	recordTurn(turn: ToolCallLoopTurn): RepeatedToolCallDetection | null {
		const toolCalls = turn.message.content.filter((part): part is ToolCall => part.type === "toolCall");
		if (toolCalls.length === 0) {
			this.#resetRun();
			return null;
		}
		if (toolCalls.every(tc => this.#isExempt(tc))) {
			// An exempt poll its tool flagged useless (a wait that elapsed or found
			// nothing to wait for) is skipped, so alternating it with a repeated call
			// cannot hide the loop. Any other exempt turn, failures included, may have
			// changed state (finished jobs, a message, injected context), so it ends
			// the repetition.
			const idle =
				!turn.injectedContext &&
				toolCalls.every(tc => turn.toolResults.find(result => result.toolCallId === tc.id)?.useless === true);
			if (!idle) this.#resetRun();
			return null;
		}

		const canonicalCalls = toolCalls
			.map(tc => JSON.stringify([tc.name, canonicalizeToolCallValue(tc.arguments)]))
			.sort();
		const turnHash = JSON.stringify(canonicalCalls);
		const reportCall = toolCalls.find(tc => !this.#isExempt(tc)) ?? toolCalls[0]!;
		const record: TurnRecord = {
			hash: turnHash,
			toolName: reportCall.name,
			argumentsSummary: summarizeText(
				JSON.stringify(canonicalizeToolCallValue(reportCall.arguments)),
				ARGUMENT_SUMMARY_LIMIT,
			),
			resultSummary: summarizeToolResult(turn.toolResults, reportCall.id),
		};
		if (turnHash === this.#lastHash) {
			this.#count++;
		} else {
			this.#lastHash = turnHash;
			this.#count = 1;
		}
		this.#history.push(record);
		if (this.#history.length > CYCLE_HISTORY_LIMIT) this.#history.shift();

		const repeatedText = this.#recordText(turn.message);

		if (this.#count >= this.#threshold) {
			return {
				kind: "repeated_tool_call",
				toolName: record.toolName,
				count: this.#count,
				resultSummary: record.resultSummary,
				argumentsSummary: record.argumentsSummary,
				level: this.#levelFor(this.#count, this.#threshold, this.#hardLimit),
			};
		}
		return this.#detectCycle() ?? repeatedText;
	}

	/** Counts consecutive tool-calling turns whose assistant prose is identical (whitespace-normalized). */
	#recordText(message: AssistantMessage): RepeatedToolCallDetection | null {
		const text = message.content
			.filter((part): part is { type: "text"; text: string } => part.type === "text")
			.map(part => part.text)
			.join("\n");
		const normalized = text.replace(/\s+/g, " ").trim();
		if (normalized.length < REPEATED_TEXT_MIN_CHARS) {
			this.#lastText = undefined;
			this.#textCount = 0;
			return null;
		}
		if (normalized === this.#lastText) {
			this.#textCount++;
		} else {
			this.#lastText = normalized;
			this.#textCount = 1;
		}
		if (this.#textCount < this.#threshold) return null;
		return {
			kind: "repeated_text",
			toolName: "",
			count: this.#textCount,
			resultSummary: "",
			argumentsSummary: summarizeText(normalized, ARGUMENT_SUMMARY_LIMIT),
			level: this.#levelFor(this.#textCount, this.#threshold, this.#hardLimit),
		};
	}

	/**
	 * Finds the shortest period (2 or 3 turns) the recent turns have been cycling
	 * with, e.g. A, B, A, B, A, B. A cycle needs half the exact-repeat threshold in
	 * full repetitions: it spans more turns for the same evidence.
	 */
	#detectCycle(): RepeatedToolCallDetection | null {
		const threshold = Math.max(CYCLE_MIN_REPEATS, Math.ceil(this.#threshold / 2));
		const hardLimit = Math.ceil(this.#hardLimit / 2);
		const history = this.#history;
		for (const period of CYCLE_PERIODS) {
			// Trailing run of positions that equal the one `period` turns earlier.
			let matched = 0;
			for (let i = history.length - 1; i >= period; i--) {
				if (history[i]!.hash !== history[i - period]!.hash) break;
				matched++;
			}
			const cycles = Math.floor((matched + period) / period);
			if (cycles < threshold) continue;
			const unit = history.slice(history.length - period);
			if (new Set(unit.map(entry => entry.hash)).size < 2) continue;
			return {
				kind: "repeated_tool_cycle",
				toolName: unit.map(entry => entry.toolName).join(" → "),
				count: cycles,
				resultSummary: unit.map(entry => entry.resultSummary).join(" | "),
				argumentsSummary: unit.map(entry => entry.argumentsSummary).join(" | "),
				level: this.#levelFor(cycles, threshold, hardLimit),
				period,
			};
		}
		return null;
	}
}
