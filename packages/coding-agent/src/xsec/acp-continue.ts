import { isRecord } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";

/**
 * Resumes the session's unfinished turn for a `session/prompt` request whose `_meta` is
 * `{ xsec: { continue: true } }`. The request's text is not sent. The resume runs inside the
 * caller's prompt turn, so streamed updates and the stop reason reach the client as usual.
 * Any other request returns `undefined`, and the caller runs it as an ordinary prompt.
 */
export function resumeIf(request: { _meta?: unknown }, record: { session: AgentSession }): Promise<void> | undefined {
	if (!isContinueRequest(request._meta)) return undefined;
	return record.session.resume();
}

/** Only the boolean `true` asks for a continue; any other value is an ordinary prompt. */
function isContinueRequest(meta: unknown): boolean {
	if (!isRecord(meta) || !isRecord(meta.xsec)) return false;
	return meta.xsec.continue === true;
}
