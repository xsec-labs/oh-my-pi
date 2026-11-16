import { describe, expect, it } from "bun:test";
import type { DaemonSpec } from "@oh-my-pi/pi-tui/tools/daemon";
import { resolveDaemonSpawnOptions } from "../../src/launch/spawn-options";
import {
	daemonSpawnOptions,
	parseSessionFields,
	sharedBrowserSessionFields,
	sharesBrokerSession,
} from "../../src/xsec/browser-session";

const UPSTREAM_DARWIN = resolveDaemonSpawnOptions({ platform: "darwin", hostHasInheritableConsole: false });

function launchSpec(overrides: Partial<DaemonSpec> & { inheritSession?: boolean } = {}): DaemonSpec {
	return {
		name: "browser",
		application: "/Applications/Chromium.app/Contents/MacOS/Chromium",
		args: [],
		env: {},
		cwd: "/project",
		pty: false,
		restart: "no",
		persist: false,
		detached: false,
		...overrides,
	};
}

describe("shared browser launch on macOS", () => {
	it("starts the browser the shared-browser request describes in the broker's session, not its own", () => {
		const wire = { ...sharedBrowserSessionFields() };
		const spec = launchSpec(parseSessionFields(wire));
		expect(daemonSpawnOptions(spec, UPSTREAM_DARWIN, "darwin")).toEqual({ detached: false });
		expect(sharesBrokerSession(spec, "darwin")).toBe(true);
	});

	it("rejects a non-boolean session flag instead of spawning the browser in a session of its own", () => {
		expect(() => parseSessionFields({ inheritSession: "yes" })).toThrow("spec.inheritSession must be a boolean");
	});

	it("keeps upstream's spawn options and group stop for a spec without the flag", () => {
		const spec = launchSpec();
		expect(parseSessionFields({})).toEqual({});
		expect(daemonSpawnOptions(spec, UPSTREAM_DARWIN, "darwin")).toEqual(UPSTREAM_DARWIN);
		expect(sharesBrokerSession(spec, "darwin")).toBe(false);
	});

	it("keeps the flag inert off macOS, so Linux and Windows daemons keep upstream's behavior", () => {
		const spec = launchSpec({ inheritSession: true });
		expect(daemonSpawnOptions(spec, UPSTREAM_DARWIN, "linux")).toEqual(UPSTREAM_DARWIN);
		expect(sharesBrokerSession(spec, "linux")).toBe(false);
	});

	it("never takes a detached or PTY daemon out of its own session", () => {
		const detached = launchSpec({ inheritSession: true, detached: true });
		const pty = launchSpec({ inheritSession: true, pty: true });
		expect(daemonSpawnOptions(detached, UPSTREAM_DARWIN, "darwin")).toEqual(UPSTREAM_DARWIN);
		expect(daemonSpawnOptions(pty, UPSTREAM_DARWIN, "darwin")).toEqual(UPSTREAM_DARWIN);
		expect(sharesBrokerSession(detached, "darwin")).toBe(false);
		expect(sharesBrokerSession(pty, "darwin")).toBe(false);
	});
});
