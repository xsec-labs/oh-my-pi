import { describe, expect, it } from "bun:test";
import { resolveDaemonSpawnOptions } from "../../src/launch/spawn-options";

describe("resolveDaemonSpawnOptions", () => {
	it("hides Windows daemons when the host has no console", () => {
		expect(
			resolveDaemonSpawnOptions({
				platform: "win32",
				hostHasInheritableConsole: false,
			}),
		).toEqual({ detached: false, windowsHide: true });
	});

	it("inherits the Windows host console instead of detaching", () => {
		expect(
			resolveDaemonSpawnOptions({
				platform: "win32",
				hostHasInheritableConsole: true,
			}),
		).toEqual({ detached: false, windowsHide: false });
	});

	it("keeps POSIX daemons in their own session", () => {
		expect(
			resolveDaemonSpawnOptions({
				platform: "linux",
				hostHasInheritableConsole: false,
			}),
		).toEqual({ detached: true });
	});

	// Regression: a browser daemon started with setsid on macOS fails Chrome's bootstrap check-in.
	it("keeps a macOS daemon that inherits the session in the broker's session", () => {
		expect(
			resolveDaemonSpawnOptions({
				platform: "darwin",
				hostHasInheritableConsole: false,
				inheritSession: true,
			}),
		).toEqual({ detached: false });
	});

	it("keeps other macOS daemons in their own session", () => {
		expect(
			resolveDaemonSpawnOptions({
				platform: "darwin",
				hostHasInheritableConsole: false,
			}),
		).toEqual({ detached: true });
	});

	it("ignores the inherit request off macOS", () => {
		expect(
			resolveDaemonSpawnOptions({
				platform: "linux",
				hostHasInheritableConsole: false,
				inheritSession: true,
			}),
		).toEqual({ detached: true });
	});
});
