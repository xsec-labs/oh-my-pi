import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { createDaemonBrokerClient } from "../../src/launch/client";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
}

function startBroker(projectDir: string, runtimeDir: string): Promise<void> {
	const previousProjectDir = process.env[DAEMON_PROJECT_DIR_ENV];
	const previousRuntimeDir = process.env[DAEMON_RUNTIME_DIR_ENV];
	const previousGrace = process.env[DAEMON_IDLE_GRACE_ENV];
	process.env[DAEMON_PROJECT_DIR_ENV] = projectDir;
	process.env[DAEMON_RUNTIME_DIR_ENV] = runtimeDir;
	process.env[DAEMON_IDLE_GRACE_ENV] = "5000";
	const broker = startDaemonBrokerFromEnvironment();
	restoreEnv(DAEMON_PROJECT_DIR_ENV, previousProjectDir);
	restoreEnv(DAEMON_RUNTIME_DIR_ENV, previousRuntimeDir);
	restoreEnv(DAEMON_IDLE_GRACE_ENV, previousGrace);
	return broker;
}

/**
 * Starts a sleeping daemon through the broker and stops it, returning the `group` option the
 * broker passed to the native terminate. `groupId` replaces what the native process reports as
 * its group, so the test controls whether the daemon leads its own group.
 */
async function stopSleeperGroupOption(groupId: number | null | undefined): Promise<boolean | undefined> {
	using tempDir = TempDir.createSync("@omp-launch-group-signal-");
	const projectDir = path.join(tempDir.path(), "project");
	const runtimeDir = path.join(tempDir.path(), "runtime");
	await fs.mkdir(projectDir);

	const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
	const broker = startBroker(projectDir, runtimeDir);
	const terminate = vi.spyOn(Process.prototype, "terminate");
	if (groupId !== undefined) vi.spyOn(Process.prototype, "groupId").mockReturnValue(groupId);
	try {
		await client.request({
			op: "start",
			spec: {
				name: "sleeper",
				application: "sleep",
				args: ["60"],
				env: {},
				cwd: projectDir,
				pty: false,
				restart: "no",
				persist: false,
				detached: false,
			},
		});
		await client.request({ op: "stop", name: "sleeper", timeoutMs: 2_000 });
		return terminate.mock.calls[0]?.[0]?.group;
	} finally {
		vi.restoreAllMocks();
		await client.request({ op: "shutdown" }).catch(() => undefined);
		client.close();
		await broker;
	}
}

describe("broker stop signals", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("signals the process group of a daemon that leads its own group, as stop always did", async () => {
		// Left unmocked, the native group of a daemon launched on POSIX is its own pid.
		expect(await stopSleeperGroupOption(undefined)).toBe(true);
	}, 15_000);

	it("signals only the pid tree of a daemon in another group, so stop cannot reach the broker's group", async () => {
		expect(await stopSleeperGroupOption(process.pid)).toBe(false);
	}, 15_000);
});
