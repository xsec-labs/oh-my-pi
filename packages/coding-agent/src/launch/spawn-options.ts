/** Platform-specific options for the launch broker's non-PTY children. */
export interface DaemonSpawnOptions {
	detached: boolean;
	windowsHide?: boolean;
}

/**
 * Keep launch processes headless without discarding an inheritable Windows console.
 *
 * `inheritSession` keeps a pipe-launched daemon in the broker's session on macOS only:
 * Chrome's bootstrap check-in is refused from a new session there, so a browser daemon
 * started with setsid never comes up. Every other platform keeps its own session.
 */
export function resolveDaemonSpawnOptions(opts: {
	platform: NodeJS.Platform;
	hostHasInheritableConsole: boolean;
	inheritSession?: boolean;
}): DaemonSpawnOptions {
	if (opts.platform !== "win32") {
		return opts.inheritSession && opts.platform === "darwin" ? { detached: false } : { detached: true };
	}
	return {
		detached: false,
		windowsHide: !opts.hostHasInheritableConsole,
	};
}
