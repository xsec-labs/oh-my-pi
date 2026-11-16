import type { DaemonSpec } from "@oh-my-pi/pi-tui/tools/daemon";
import type { DaemonSpawnOptions } from "../launch/spawn-options";

/**
 * Launch rules for the shared browser daemon. The upstream broker calls into this module, so each
 * upstream file keeps one call site and the rules stay in the fork's own code.
 *
 * On macOS, Chromium started in a session of its own (`setsid`) is refused the bootstrap check-in
 * it needs (`bootstrap_check_in ... Permission denied (1100)`). A browser that asks to inherit the
 * session starts in the broker's session instead. Such a daemon shares the broker's process group,
 * so stop and recovery signal its process tree by pid rather than its group.
 */

/** Fields the fork adds to a daemon launch spec. The upstream `DaemonSpec` type does not declare them. */
export interface SessionFields {
	/** Start the daemon in the broker's session on macOS rather than in a session of its own. */
	inheritSession?: boolean;
}

/** The fork fields the shared browser sends with its start request. */
export function sharedBrowserSessionFields(): SessionFields {
	return { inheritSession: true };
}

/**
 * Decodes the fork fields of a wire launch spec. An absent field keeps upstream's behavior; a field
 * that is not a boolean is rejected rather than read as the default.
 */
export function parseSessionFields(source: Record<string, unknown>): SessionFields {
	if (source.inheritSession === undefined) return {};
	if (typeof source.inheritSession !== "boolean") throw new Error("spec.inheritSession must be a boolean");
	return { inheritSession: source.inheritSession };
}

/**
 * Spawn options for a pipe-launched daemon: upstream's `defaults`, except that a macOS daemon which
 * inherits the session is spawned without a session of its own.
 */
export function daemonSpawnOptions(
	spec: DaemonSpec,
	defaults: DaemonSpawnOptions,
	platform: NodeJS.Platform = process.platform,
): DaemonSpawnOptions {
	return sharesBrokerSession(spec, platform) ? { detached: false } : defaults;
}

/**
 * Whether `daemonSpawnOptions` leaves the daemon in the broker's session and process group. A group
 * signal to such a daemon would also reach the broker, so stop and recovery must signal by pid.
 */
export function sharesBrokerSession(spec: DaemonSpec, platform: NodeJS.Platform = process.platform): boolean {
	if (platform !== "darwin" || spec.detached || spec.pty) return false;
	return "inheritSession" in spec && spec.inheritSession === true;
}
