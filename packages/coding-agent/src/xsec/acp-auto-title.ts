/**
 * Automatic session titles for ACP hosts that show session names (xSec Desktop). ACP mode names no session by
 * default: `main.ts` sets `PI_NO_TITLE=1` and never turns `autoTitle` on. A host opts in with
 * `PI_ACP_AUTO_TITLE=1`; the unnamed session is then titled from the first operator message by the title model
 * (plain title, no card), and the title is pushed as `session_info_update` the moment it lands, which can be after
 * the prompt response. `main.ts` and `acp-agent.ts` only call these functions, so the rule lives in this module and
 * the upstream files keep their call lines.
 */
import type { Settings } from "../config/settings";
import type { SessionManager } from "../session/session-manager";
import { cfgTitleGenerator, cfgTitleRefreshOnReplan } from "../utils/title-settings";
import { $flag } from "@oh-my-pi/pi-utils/env";
import acpTitlePrompt from "./acp-auto-title-prompt.md" with { type: "text" };
import * as logger from "@oh-my-pi/pi-utils/logger";
import { prompt } from "@oh-my-pi/pi-utils";

/**
 * Whether this ACP launch names sessions: the host set `PI_ACP_AUTO_TITLE` and `--no-title` is absent. When it is,
 * this process overrides (in memory, never saved) the user's `title.generator` with the plain `tiny` one, because a
 * card (icon and code) does not fit a host's session list, and turns `title.refreshOnReplan` off so a session is
 * named once and not renamed by a later todo replan.
 */
export function enableAcpAutoTitle(args: { mode?: string; noTitle?: boolean }, settings: Settings): boolean {
	if (args.mode !== "acp" || args.noTitle || !$flag("PI_ACP_AUTO_TITLE")) return false;
	cfgTitleGenerator.override(settings, "tiny");
	cfgTitleRefreshOnReplan.override(settings, false);
	return true;
}

/**
 * The title system prompt for an ACP session: the user's `TITLE_SYSTEM.md` when there is one, else, for a host that
 * opted in with `PI_ACP_AUTO_TITLE`, a prompt that makes the title follow the language of the user's message (the
 * bundled prompt is English-only and gave Chinese messages English titles). Without the opt-in the bundled prompt
 * stays in force, so a host that did not ask sees no change.
 */
export function acpTitleSystemPrompt(override: string | undefined): string | undefined {
	if (override !== undefined || !$flag("PI_ACP_AUTO_TITLE")) return override;
	return prompt.render(acpTitlePrompt);
}

/**
 * Calls `notify` with the session's name whenever a generated (`auto`) title lands. `/rename` and `/new` tell the
 * client themselves, so a user-set title is left to them. Without `PI_ACP_AUTO_TITLE` nothing is subscribed, so a
 * host that did not opt in sees no change. Returns the unsubscribe function.
 */
export function watchGeneratedTitle(
	sessionManager: SessionManager,
	notify: (title: string | undefined) => Promise<void>,
): () => void {
	if (!$flag("PI_ACP_AUTO_TITLE")) return () => {};
	return sessionManager.onSessionNameChanged(() => {
		if (sessionManager.titleSource !== "auto") return;
		void notify(sessionManager.getSessionName()).catch(error => {
			logger.warn("Failed to emit ACP session title update", { error: String(error) });
		});
	});
}
