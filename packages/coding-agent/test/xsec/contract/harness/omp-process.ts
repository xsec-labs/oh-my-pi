import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { type FakeModelServer, startFakeModelServer } from "./fake-model-server";
import { type RefusingProxy, startRefusingProxy } from "./refusing-proxy";

/** The provider and model every contract test selects. Both are served by the fake model server. */
export const FAKE_PROVIDER = "fake";
export const FAKE_MODEL = "fake-model";

/** The CLI of the source tree, run through bun when `XSEC_CONTRACT_OMP` is unset. */
const SOURCE_CLI = path.resolve(import.meta.dir, "../../../../src/cli.ts");

/** The home, agent directory and workspace of one test, with its own fake model and refusing proxy. */
export interface ContractHome {
	readonly workspace: string;
	readonly configPath: string;
	readonly model: FakeModelServer;
	readonly proxy: RefusingProxy;
	/** The environment of every omp process the test starts. Nothing in it reaches the real user's files. */
	readonly env: Record<string, string>;
	dispose(): Promise<void>;
}

/** The command that runs omp: the binary named by `XSEC_CONTRACT_OMP`, otherwise the source tree through bun. */
export function ompCommand(): string[] {
	const binary = process.env.XSEC_CONTRACT_OMP;
	if (binary) return [path.resolve(binary)];
	return [process.execPath, SOURCE_CLI];
}

/** What a test can choose about its home before the child starts. */
export interface ContractHomeOptions {
	/** Whether goal mode is on in the settings overlay. It defaults to on, as it does in omp. */
	goalEnabled?: boolean;
}

/** Starts a fresh home for one test: its own agent directory, workspace, models file and settings overlay. */
export async function createContractHome(options: ContractHomeOptions = {}): Promise<ContractHome> {
	const goalEnabled = options.goalEnabled ?? true;
	const root = TempDir.createSync("@omp-contract-");
	const base = root.path();
	const proxy = await startRefusingProxy();
	const model = startFakeModelServer();
	const dirs = {
		home: path.join(base, "home"),
		agentDir: path.join(base, "agent"),
		workspace: path.join(base, "workspace"),
		xdgConfig: path.join(base, "xdg", "config"),
		xdgData: path.join(base, "xdg", "data"),
		xdgState: path.join(base, "xdg", "state"),
		xdgCache: path.join(base, "xdg", "cache"),
		appData: path.join(base, "appdata"),
		localAppData: path.join(base, "localappdata"),
	};
	for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });

	// The settings Desktop passes with `--config`: discovery contacts only the configured providers, and a
	// tool name collision is an error. Goal mode is written out so a test can turn it off.
	const configPath = path.join(base, "config.yml");
	fs.writeFileSync(
		configPath,
		[
			"models:",
			"  discovery: configured",
			"mcp:",
			"  toolNameCollision: error",
			"goal:",
			`  enabled: ${goalEnabled}`,
			"",
		].join("\n"),
	);

	// The one model provider, in the Desktop `models.yml` format, pointing at the fake model server.
	fs.writeFileSync(
		path.join(dirs.agentDir, "models.yml"),
		[
			"providers:",
			`  ${FAKE_PROVIDER}:`,
			`    baseUrl: ${model.baseUrl}`,
			"    api: openai-completions",
			"    auth: none",
			"    models:",
			`      - id: ${FAKE_MODEL}`,
			"        name: Fake model",
			"        contextWindow: 8192",
			"        maxTokens: 1024",
			"",
		].join("\n"),
	);

	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		HOME: dirs.home,
		USERPROFILE: dirs.home,
		PI_CODING_AGENT_DIR: dirs.agentDir,
		XDG_CONFIG_HOME: dirs.xdgConfig,
		XDG_DATA_HOME: dirs.xdgData,
		XDG_STATE_HOME: dirs.xdgState,
		XDG_CACHE_HOME: dirs.xdgCache,
		APPDATA: dirs.appData,
		LOCALAPPDATA: dirs.localAppData,
		TEMP: base,
		TMP: base,
		HTTP_PROXY: proxy.url,
		HTTPS_PROXY: proxy.url,
		ALL_PROXY: proxy.url,
		NO_PROXY: "127.0.0.1,localhost",
		NO_COLOR: "1",
	};
	// Windows needs SystemRoot to start processes.
	if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;

	return {
		workspace: dirs.workspace,
		configPath,
		model,
		proxy,
		env,
		async dispose() {
			model.stop();
			await proxy.stop();
			await root.remove();
		},
	};
}

/** The outcome of one omp process that ran to completion. */
export interface OmpRun {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** Runs omp with `args` in the home's workspace and waits for it to exit. */
export async function runOmp(home: ContractHome, args: string[]): Promise<OmpRun> {
	const child = Bun.spawn({
		cmd: [...ompCommand(), ...args],
		cwd: home.workspace,
		env: home.env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { exitCode, stdout, stderr };
}
