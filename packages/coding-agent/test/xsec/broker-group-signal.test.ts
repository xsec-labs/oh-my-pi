import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Process } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { startDaemonBrokerFromEnvironment } from "../../src/launch/broker";
import { type DaemonBrokerClient, createDaemonBrokerClient } from "../../src/launch/client";
import { DAEMON_IDLE_GRACE_ENV, DAEMON_PROJECT_DIR_ENV, DAEMON_RUNTIME_DIR_ENV } from "../../src/launch/protocol";

const SLEEPER = "sleeper";

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

async function startSleeper(client: DaemonBrokerClient, projectDir: string): Promise<void> {
	await client.request({
		op: "start",
		spec: {
			name: SLEEPER,
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
}

/**
 * Runs `act` against a broker with one sleeping daemon that is not detached, and returns the `group`
 * option of the first native terminate the broker makes. `groupId` replaces the group the native
 * process reports, so the test decides whether the daemon leads its own group.
 */
async function firstTerminateGroup(
	groupId: number | undefined,
	act: (client: DaemonBrokerClient, projectDir: string) => Promise<void>,
): Promise<boolean | undefined> {
	using tempDir = TempDir.createSync("@omp-launch-group-signal-");
	const projectDir = path.join(tempDir.path(), "project");
	const runtimeDir = path.join(tempDir.path(), "runtime");
	await fs.mkdir(projectDir);

	const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
	const broker = startBroker(projectDir, runtimeDir);
	const terminate = vi.spyOn(Process.prototype, "terminate");
	if (groupId !== undefined) vi.spyOn(Process.prototype, "groupId").mockReturnValue(groupId);
	try {
		await act(client, projectDir);
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
		const group = await firstTerminateGroup(undefined, async (client, projectDir) => {
			await startSleeper(client, projectDir);
			await client.request({ op: "stop", name: SLEEPER, timeoutMs: 2_000 });
		});
		expect(group).toBe(true);
	}, 15_000);

	it("signals only the pid tree of a daemon in another group, so stop cannot reach the broker's group", async () => {
		const group = await firstTerminateGroup(process.pid, async (client, projectDir) => {
			await startSleeper(client, projectDir);
			await client.request({ op: "stop", name: SLEEPER, timeoutMs: 2_000 });
		});
		expect(group).toBe(false);
	}, 15_000);

	it("keeps the pid tree signal when a shared-group daemon is switched to detached and restarted", async () => {
		// The mode switch replaces the spec with a detached one and restarts the daemon. The restart's
		// stop still targets the running process, which shares the broker's group.
		const group = await firstTerminateGroup(process.pid, async (client, projectDir) => {
			await startSleeper(client, projectDir);
			await client.request({ op: "mode", name: SLEEPER, mode: "detached" });
		});
		expect(group).toBe(false);
	}, 15_000);
});
