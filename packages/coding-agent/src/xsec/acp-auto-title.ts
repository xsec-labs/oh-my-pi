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
import { cfgTitleGenerator } from "../utils/title-settings";
import { $flag } from "@oh-my-pi/pi-utils/env";
import * as logger from "@oh-my-pi/pi-utils/logger";

/**
 * Whether this ACP launch names sessions: the host set `PI_ACP_AUTO_TITLE` and `--no-title` is absent. When it is,
 * the title generator becomes the plain `tiny` one for this process, because a card (icon and code) does not fit a
 * host's session list.
 */
export function enableAcpAutoTitle(args: { mode?: string; noTitle?: boolean }, settings: Settings): boolean {
	if (args.mode !== "acp" || args.noTitle || !$flag("PI_ACP_AUTO_TITLE")) return false;
	cfgTitleGenerator.override(settings, "tiny");
	return true;
}

/**
 * Calls `notify` with the session's name whenever a generated (`auto`) title lands. `/rename` and `/new` tell the
 * client themselves, so a user-set title is left to them. Returns the unsubscribe function.
 */
export function watchGeneratedTitle(
	sessionManager: SessionManager,
	notify: (title: string | undefined) => Promise<void>,
): () => void {
	return sessionManager.onSessionNameChanged(() => {
		if (sessionManager.titleSource !== "auto") return;
		void notify(sessionManager.getSessionName()).catch(error => {
			logger.warn("Failed to emit ACP session title update", { error: String(error) });
		});
	});
}
