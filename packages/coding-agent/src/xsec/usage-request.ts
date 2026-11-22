/**
 * Per-request token facts for ACP hosts that analyse token use (xSec Desktop).
 *
 * A host opts in with `PI_ACP_USAGE_REQUESTS=1`. Then every provider request of an ACP session ends with an
 * `_xsec/usage/request` notification: what the provider billed for it, and how the context it carried splits by
 * part (`usage-composition.ts`). The measured counts are exact; the split is an estimate with the session's
 * tokenizer. The host scales the split to the measured input, so the parts add up to what was billed.
 *
 * Only names and numbers are sent. Without the opt-in nothing is computed, so a host that did not ask sees no
 * change and pays nothing.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { $flag } from "@oh-my-pi/pi-utils/env";
import * as logger from "@oh-my-pi/pi-utils/logger";
import type { AgentSession } from "../session/agent-session";
import {
	buildRequestComposition,
	COMPOSITION_SCHEMA_VERSION,
	type CompositionItem,
	type ContextComposition,
} from "./usage-composition";

export const USAGE_REQUEST_METHOD = "_xsec/usage/request";

/**
 * Where a request came from. Only `main` (a request of the session's own conversation, with the tool loop's
 * follow-up requests) is sent today; the others are reserved so Desktop's schema does not change when the
 * fork starts reporting them.
 */
export type UsageRequestKind = "main" | "compaction" | "title" | "subagent";

export type UsageRequestParams = {
	schemaVersion: typeof COMPOSITION_SCHEMA_VERSION;
	sessionId: string;
	/** 1 for the session's first request in this process; counts requests this process saw, not the whole history. */
	seq: number;
	kind: UsageRequestKind;
	/** Epoch milliseconds the reply ended. */
	completedAt: number;
	provider: string;
	model: string;
	stopReason: string;
	/** What the provider billed for this request. `reasoning` is part of `output`, when the provider reports it. */
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; reasoning?: number };
	/** The context window of the model, when known. */
	contextWindow?: number;
	/** The context this request carried, split by part. */
	composition: ContextComposition;
	/** What that context gained since the previous request: new tool results and messages. */
	added: CompositionItem[];
	/** The reply's own blocks, the output side: text, thinking and tool calls by tool. */
	reply: CompositionItem[];
};

const sequences = new WeakMap<AgentSession, number>();
/** The reply to each session's previous request, to tell what the next request's context gained. */
const previousReplies = new WeakMap<AgentSession, AgentMessage>();

/** Whether the host asked for per-request usage. */
export function usageRequestsEnabled(): boolean {
	return $flag("PI_ACP_USAGE_REQUESTS");
}

/**
 * The notification for an assistant reply that just ended, or undefined when the host did not opt in or the
 * reply cost nothing (an abort before the provider answered). Never throws: counting must not fail a turn.
 */
export function usageRequestNotification(
	sessionId: string,
	session: AgentSession,
	message: AgentMessage,
): { method: typeof USAGE_REQUEST_METHOD; params: UsageRequestParams } | undefined {
	if (message.role !== "assistant" || !usageRequestsEnabled()) return undefined;
	const { usage } = message;
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	if (input + output + cacheRead + cacheWrite <= 0) return undefined;
	try {
		const seq = (sequences.get(session) ?? 0) + 1;
		sequences.set(session, seq);
		const split = buildRequestComposition(session, message, previousReplies.get(session));
		previousReplies.set(session, message);
		const params: UsageRequestParams = {
			schemaVersion: COMPOSITION_SCHEMA_VERSION,
			sessionId,
			seq,
			kind: "main",
			completedAt: Date.now(),
			provider: message.provider,
			model: message.model,
			stopReason: message.stopReason,
			usage: {
				input,
				output,
				cacheRead,
				cacheWrite,
				total: usage.totalTokens ?? input + output + cacheRead + cacheWrite,
				...(usage.reasoningTokens !== undefined ? { reasoning: usage.reasoningTokens } : {}),
			},
			composition: split.composition,
			added: split.added,
			reply: split.reply,
		};
		const contextWindow = session.model?.contextWindow;
		if (contextWindow) params.contextWindow = contextWindow;
		return { method: USAGE_REQUEST_METHOD, params };
	} catch (error) {
		logger.warn("Usage request composition failed", { sessionId, error: String(error) });
		return undefined;
	}
}
