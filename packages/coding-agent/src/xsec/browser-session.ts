import type { DaemonSpec } from "@oh-my-pi/pi-tui/tools/daemon";
import type { DaemonSpawnOptions } from "../launch/spawn-options";

/**
 * Launch rules for the shared browser daemon. The upstream broker calls into this module, so each
 * upstream file keeps one call site and the rules stay in the fork's own code.
 *
 * On macOS, Chromium started in a session of its own (`setsid`) is refused the bootstrap check-in
 * it needs (`bootstrap_check_in ... Permission denied (1100)`). A browser that asks to inherit the
 * session starts in the broker's session instead. Such a daemon shares the broker's process group,
 * so stop and recovery signal it by pid, see `leadsOwnGroup`.
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
 * Whether `daemonSpawnOptions` spawns the daemon in the broker's session. Read at spawn time only:
 * a spec changed after launch does not change the process that is already running.
 */
function sharesBrokerSession(spec: DaemonSpec, platform: NodeJS.Platform): boolean {
	if (platform !== "darwin" || spec.detached || spec.pty) return false;
	return "inheritSession" in spec && spec.inheritSession === true;
}

/** The part of a native process reference that the group check reads. */
export interface GroupedProcess {
	readonly pid: number;
	groupId(): number | null;
}

/**
 * Whether a group signal to the process reaches only the process and its own children, which holds
 * when the process leads a group of its own. A process in another group, such as the broker's, must
 * get a pid-tree signal instead: a group signal would also reach that group's other members, the
 * broker included. The real group decides, not the spec, so a spec changed after launch (a mode
 * switch to detached restarts the daemon) cannot change how the running process is stopped.
 * Platforms without process groups report none, and the pid tree is signalled.
 */
export function leadsOwnGroup(processRef: GroupedProcess): boolean {
	return processRef.groupId() === processRef.pid;
}
