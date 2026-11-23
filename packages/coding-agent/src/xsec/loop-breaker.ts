/**
 * Circuit breaker on top of the tool-call loop guard (`session/stream-guards.ts`).
 *
 * Upstream's guard only steers: a model that ignores the corrective is steered again on every turn and never
 * stops, and it sees only identical consecutive calls. This adds, for the same `model.toolCallLoopGuard.*` settings:
 *
 * - a hard stop: once the guard's repeat count reaches the threshold plus `model.toolCallLoopGuard.hardLimit`
 *   (default 3), the run ends as a normal completion with a closing assistant message that says what repeated;
 *   the user sees the reason in the reply, with no separate notice and no cancelled stop reason;
 * - repeating cycles of 2 or 3 tool-call turns (A, B, A, B, ...): a redirect after 3 full cycles (half the
 *   threshold, at least 3), the hard stop after half the hard limit more cycles;
 * - identical prose (80 characters or more) on consecutive tool-calling turns: same threshold and hard limit as
 *   identical calls.
 *
 * Exempt tools, idle polls and turns without tool calls follow the upstream guard's rules.
 */
import type { Agent, AgentMessage, AgentTurnEndContext } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai";
import type { RepeatedToolCallDetection } from "@oh-my-pi/pi-ai/utils/tool-call-loop-guard";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import type { Settings } from "../config/settings";
import type { CustomMessage } from "../session/messages";
import type { SessionManager } from "../session/session-manager";
import {
	cfgModelToolCallLoopGuardEnabled,
	cfgModelToolCallLoopGuardExemptTools,
	cfgModelToolCallLoopGuardThreshold,
} from "../session/settings";
import { writeDeviceName } from "../tools/resolve";
import cycleRedirectTemplate from "./loop-breaker-cycle.md" with { type: "text" };
import stopTemplate from "./loop-breaker-stop.md" with { type: "text" };
import textRedirectTemplate from "./loop-breaker-text.md" with { type: "text" };
import { cfgToolCallLoopGuardHardLimit } from "./settings";

export const LOOP_BREAKER_REDIRECT_TYPE = "loop-breaker-redirect";

const LEGACY_INTENT_FIELD = "__intent";
const SUMMARY_LIMIT = 400;
/** Shortest assistant prose that counts as a repeated-text signal; short acknowledgements repeat legitimately. */
const REPEATED_TEXT_MIN_CHARS = 80;
const CYCLE_HISTORY_LIMIT = 24;
const CYCLE_PERIODS = [2, 3] as const;
/** A cycle repeats this many full times at least, whatever the threshold: two passes is ordinary retrying. */
const CYCLE_MIN_REPEATS = 3;

export type LoopBreakerKind = "repeated_tool_call" | "repeated_tool_cycle" | "repeated_text";

export interface LoopBreakerHost {
	readonly agent: Agent;
	readonly settings: Settings;
	readonly sessionManager: SessionManager;
}

interface Verdict {
	kind: LoopBreakerKind;
	toolName: string;
	count: number;
	argumentsSummary: string;
	resultSummary: string;
	period?: number;
	abort: boolean;
}

interface TurnRecord {
	hash: string;
	toolName: string;
	argumentsSummary: string;
	resultSummary: string;
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (!value || typeof value !== "object") return value;
	const input = value as Record<string, unknown>;
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(input).sort()) {
		if (key === INTENT_FIELD || key === LEGACY_INTENT_FIELD) continue;
		output[key] = canonicalize(input[key]);
	}
	return output;
}

function summarize(text: string, limit = SUMMARY_LIMIT): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

function resultText(toolResults: readonly ToolResultMessage[], toolCallId: string): string {
	const result = toolResults.find(candidate => candidate.toolCallId === toolCallId);
	if (!result) return "";
	return summarize(
		result.content
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("\n"),
		200,
	);
}

/** Counts repetitions the upstream guard cannot see, and ends the run when a loop outlives its redirect. */
export class LoopBreaker {
	readonly #host: LoopBreakerHost;
	#history: TurnRecord[] = [];
	#lastText: string | undefined;
	#textCount = 0;

	constructor(host: LoopBreakerHost) {
		this.#host = host;
	}

	#reset(): void {
		this.#history = [];
		this.#lastText = undefined;
		this.#textCount = 0;
	}

	/**
	 * Call after the upstream guard has judged the turn. `repeated` is its detection (identical calls) or
	 * nothing. Returns `{ stop: true }` when the run must end; a cycle or repeated-text redirect is injected here.
	 * A turn the upstream guard already redirects gets no second redirect from here.
	 */
	recordTurn(
		messages: AgentMessage[],
		context: AgentTurnEndContext | undefined,
		repeated: RepeatedToolCallDetection | null | undefined,
	): { stop: true } | undefined {
		const settings = this.#host.settings;
		if (context?.message.role !== "assistant") return undefined;
		if (cfgModelToolCallLoopGuardEnabled.get(settings) !== true) {
			this.#reset();
			return undefined;
		}
		const threshold = Math.max(1, Math.trunc(cfgModelToolCallLoopGuardThreshold.get(settings)));
		const hardLimit = Math.max(0, Math.trunc(cfgToolCallLoopGuardHardLimit.get(settings)));

		const verdict = this.#judge(context.message, context, threshold, hardLimit, repeated);
		if (!verdict) return undefined;
		if (verdict.abort) {
			this.#endRun(context.message, verdict);
			return { stop: true };
		}
		if (verdict.kind !== "repeated_tool_call") this.#injectRedirect(messages, verdict);
		return undefined;
	}

	#judge(
		message: AssistantMessage,
		context: AgentTurnEndContext,
		threshold: number,
		hardLimit: number,
		repeated: RepeatedToolCallDetection | null | undefined,
	): Verdict | undefined {
		const toolResults = context.toolResults;
		const toolCalls = message.content.filter((part): part is ToolCall => part.type === "toolCall");
		if (toolCalls.length === 0) {
			this.#reset();
			return undefined;
		}
		const exemptTools = new Set(
			cfgModelToolCallLoopGuardExemptTools
				.get(this.#host.settings)
				.filter((tool): tool is string => typeof tool === "string" && tool.length > 0),
		);
		const isExempt = (call: ToolCall): boolean => {
			if (exemptTools.has(call.name)) return true;
			const alias = writeDeviceName(call);
			return alias !== undefined && exemptTools.has(alias);
		};
		if (toolCalls.every(isExempt)) {
			const idle =
				(context.additionalMessages?.length ?? 0) === 0 &&
				toolCalls.every(call => toolResults.find(result => result.toolCallId === call.id)?.useless === true);
			if (!idle) this.#reset();
			return undefined;
		}

		const reportCall = toolCalls.find(call => !isExempt(call)) ?? toolCalls[0]!;
		this.#history.push({
			hash: JSON.stringify(
				toolCalls.map(call => JSON.stringify([call.name, canonicalize(call.arguments)])).sort(),
			),
			toolName: reportCall.name,
			argumentsSummary: summarize(JSON.stringify(canonicalize(reportCall.arguments))),
			resultSummary: resultText(toolResults, reportCall.id),
		});
		if (this.#history.length > CYCLE_HISTORY_LIMIT) this.#history.shift();
		const text = this.#recordText(message);

		if (repeated) {
			// Identical calls: the upstream guard owns the redirect; this only decides the stop.
			if (hardLimit > 0 && repeated.count >= threshold + hardLimit) {
				return {
					kind: "repeated_tool_call",
					toolName: repeated.toolName,
					count: repeated.count,
					argumentsSummary: repeated.argumentsSummary,
					resultSummary: repeated.resultSummary,
					abort: true,
				};
			}
			return undefined;
		}
		const cycle = this.#detectCycle(threshold, hardLimit);
		if (cycle) return cycle;
		if (text && text >= threshold) {
			return {
				kind: "repeated_text",
				toolName: "",
				count: text,
				argumentsSummary: summarize(this.#lastText ?? ""),
				resultSummary: "",
				abort: hardLimit > 0 && text >= threshold + hardLimit,
			};
		}
		return undefined;
	}

	/** Consecutive tool-calling turns with identical prose (whitespace-normalized); 0 when this turn has none. */
	#recordText(message: AssistantMessage): number {
		const normalized = message.content
			.filter(part => part.type === "text")
			.map(part => part.text)
			.join("\n")
			.replace(/\s+/g, " ")
			.trim();
		if (normalized.length < REPEATED_TEXT_MIN_CHARS) {
			this.#lastText = undefined;
			this.#textCount = 0;
			return 0;
		}
		if (normalized === this.#lastText) {
			this.#textCount++;
		} else {
			this.#lastText = normalized;
			this.#textCount = 1;
		}
		return this.#textCount;
	}

	/** The shortest period (2 or 3 turns) the recent turns are cycling with, e.g. A, B, A, B, A, B. */
	#detectCycle(threshold: number, hardLimit: number): Verdict | undefined {
		const cycleThreshold = Math.max(CYCLE_MIN_REPEATS, Math.ceil(threshold / 2));
		const cycleHardLimit = Math.ceil(hardLimit / 2);
		const history = this.#history;
		for (const period of CYCLE_PERIODS) {
			let matched = 0;
			for (let i = history.length - 1; i >= period; i--) {
				if (history[i]!.hash !== history[i - period]!.hash) break;
				matched++;
			}
			const cycles = Math.floor((matched + period) / period);
			if (cycles < cycleThreshold) continue;
			const unit = history.slice(history.length - period);
			// One distinct turn repeated is the identical-call case, which the upstream guard counts.
			if (new Set(unit.map(entry => entry.hash)).size < 2) continue;
			return {
				kind: "repeated_tool_cycle",
				toolName: unit.map(entry => entry.toolName).join(" → "),
				count: cycles,
				argumentsSummary: unit.map(entry => entry.argumentsSummary).join(" | "),
				resultSummary: unit.map(entry => entry.resultSummary).join(" | "),
				period,
				abort: hardLimit > 0 && cycles >= cycleThreshold + cycleHardLimit,
			};
		}
		return undefined;
	}

	#injectRedirect(messages: AgentMessage[], verdict: Verdict): void {
		logger.warn("repeated tool-call pattern detected", {
			kind: verdict.kind,
			toolName: verdict.toolName,
			count: verdict.count,
		});
		const template = verdict.kind === "repeated_tool_cycle" ? cycleRedirectTemplate : textRedirectTemplate;
		const content = prompt.render(template, {
			tool_name: verdict.toolName,
			count: verdict.count,
			period: verdict.period ?? 0,
			arguments_summary: verdict.argumentsSummary,
		});
		const details = { kind: verdict.kind, count: verdict.count, argumentsSummary: verdict.argumentsSummary };
		const redirect: CustomMessage = {
			role: "custom",
			customType: LOOP_BREAKER_REDIRECT_TYPE,
			content,
			display: false,
			details,
			attribution: "agent",
			timestamp: Date.now(),
		};
		messages.push(redirect);
		if (this.#host.agent.state.messages !== messages) this.#host.agent.appendMessage(redirect);
		this.#host.sessionManager.appendCustomMessageEntry(LOOP_BREAKER_REDIRECT_TYPE, content, false, details, "agent");
	}

	/** Closes the run with an assistant message that carries the reason, so it is the reply the user reads. */
	#endRun(last: AssistantMessage, verdict: Verdict): void {
		logger.warn("repeated pattern outlived its redirect; ending the run", {
			kind: verdict.kind,
			toolName: verdict.toolName,
			count: verdict.count,
		});
		// The next prompt starts with fresh counters instead of tripping on this run's history.
		this.#reset();
		const closing: AssistantMessage = {
			role: "assistant",
			content: [
				{
					type: "text",
					text: prompt.render(stopTemplate, {
						reason: describeVerdict(verdict),
						arguments_summary: verdict.argumentsSummary,
						result_summary: verdict.kind === "repeated_text" ? "" : verdict.resultSummary,
					}),
				},
			],
			api: last.api,
			provider: last.provider,
			model: last.model,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		this.#host.agent.emitExternalEvent({ type: "message_start", message: closing });
		this.#host.agent.emitExternalEvent({ type: "message_end", message: closing });
	}
}

function describeVerdict(verdict: Verdict): string {
	switch (verdict.kind) {
		case "repeated_tool_cycle":
			return `连续 ${verdict.count} 轮重复同一组 ${verdict.period ?? 0} 个工具调用（${verdict.toolName}）`;
		case "repeated_text":
			return `连续 ${verdict.count} 轮输出了相同的内容`;
		default:
			return `连续 ${verdict.count} 次用完全相同的参数调用工具 ${verdict.toolName}`;
	}
}
