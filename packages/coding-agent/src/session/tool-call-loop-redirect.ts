import type { RepeatedToolCallDetection } from "@oh-my-pi/pi-ai/utils/tool-call-loop-guard";
import { prompt } from "@oh-my-pi/pi-utils";
import repeatedTextRedirectTemplate from "../prompts/system/repeated-text-redirect.md" with { type: "text" };
import toolCallCycleRedirectTemplate from "../prompts/system/tool-call-cycle-redirect.md" with { type: "text" };
import toolCallLoopBreakerTemplate from "../prompts/system/tool-call-loop-breaker.md" with { type: "text" };
import toolCallLoopRedirectTemplate from "../prompts/system/tool-call-loop-redirect.md" with { type: "text" };

export const TOOL_CALL_LOOP_REDIRECT_TYPE = "tool-call-loop-redirect";

/** Structured record of the loop a redirect was issued for. */
export interface ToolCallLoopRedirectDetails {
	toolName: string;
	count: number;
	argumentsSummary: string;
	resultSummary: string;
}

/**
 * Renders the corrective a repeated tool call earns. Shared by the primary
 * session's `LoopGuards` and the advisor's own loop guard: both bounds speak
 * with one wording, while each wraps it in the message shape its own agent
 * converts to LLM context (the primary maps custom messages, the advisor runs
 * the default converter that keeps only LLM-native roles).
 */
export function renderToolCallLoopRedirect(detection: RepeatedToolCallDetection): string {
	const vars = {
		tool_name: detection.toolName,
		count: detection.count,
		period: detection.period ?? 0,
		arguments_summary: detection.argumentsSummary,
		result_summary: detection.resultSummary || "(no text result)",
	};
	switch (detection.kind) {
		case "repeated_tool_cycle":
			return prompt.render(toolCallCycleRedirectTemplate, vars);
		case "repeated_text":
			return prompt.render(repeatedTextRedirectTemplate, vars);
		default:
			return prompt.render(toolCallLoopRedirectTemplate, vars);
	}
}

/** What repeated, for the closing message of a run the breaker ended. */
function describeLoopReason(detection: RepeatedToolCallDetection): string {
	switch (detection.kind) {
		case "repeated_tool_cycle":
			return `连续 ${detection.count} 轮重复同一组 ${detection.period ?? 0} 个工具调用（${detection.toolName}）`;
		case "repeated_text":
			return `连续 ${detection.count} 轮输出了相同的内容`;
		default:
			return `连续 ${detection.count} 次用完全相同的参数调用工具 ${detection.toolName}`;
	}
}

/**
 * The visible closing message for a run the loop breaker ended. It is the
 * explanation the user reads in the transcript; the run ends as a normal
 * completion, with no separate "tripped" notice.
 */
export function renderToolCallLoopBreaker(detection: RepeatedToolCallDetection): string {
	return prompt.render(toolCallLoopBreakerTemplate, {
		reason: describeLoopReason(detection),
		arguments_summary: detection.argumentsSummary,
		result_summary: detection.kind === "repeated_text" ? "" : detection.resultSummary,
	});
}

export function toolCallLoopRedirectDetails(detection: RepeatedToolCallDetection): ToolCallLoopRedirectDetails {
	return {
		toolName: detection.toolName,
		count: detection.count,
		argumentsSummary: detection.argumentsSummary,
		resultSummary: detection.resultSummary,
	};
}
