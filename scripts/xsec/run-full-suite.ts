#!/usr/bin/env bun
/**
 * Runs one full-suite entry of upstream's pull-request workflow and judges it.
 *
 * The entry is a `ci:test:*` script that runs upstream's test runner. The script
 * runs unchanged, and its report decides the result. The run passes when the
 * script ran to completion and every failing test it reports is on
 * `upstream-known-failures.txt`. The run fails on an unlisted failure, a failure
 * that names no test, a crash or a timeout, a run without its summary, and a
 * summary that disagrees with the plan of the dry run. A listed test whose file
 * the plan runs and that did not fail gets a warning, so a stale entry gets
 * removed.
 *
 * Usage: bun scripts/xsec/run-full-suite.ts <ci:test:* script>
 * OMP_TEST_CONCURRENCY and OMP_TEST_SHARD are read from the environment, as the
 * script reads them when CI runs it directly.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** A test that upstream's suite fails and the full-suite run accepts. */
export interface KnownFailure {
	/** Test file, relative to the repository root. */
	file: string;
	/** Describe blocks and the test, joined with " > " as bun prints a failure. */
	name: string;
}

/** A known failure that a run hit, with the chunk that reported it. */
export interface AcceptedFailure extends KnownFailure {
	chunk: string;
}

/** The chunks a run plans, read from `bun run <script> --dry-run`. */
export interface ChunkPlan {
	chunks: number;
	/** Repository test files the chunks run explicitly, sorted and unique. */
	files: string[];
}

export interface RunEvidence {
	/** Exit code of `bun run <script>`. */
	exitCode: number;
	/** Standard output of that run, which holds the runner's report. */
	stdout: string;
	plan: ChunkPlan;
	knownFailures: readonly KnownFailure[];
}

export interface RunVerdict {
	ok: boolean;
	/** Why the run fails. Empty when `ok` is true. */
	problems: string[];
	/** The known failures the run hit, each once. */
	accepted: AcceptedFailure[];
	/** Listed tests whose file the plan runs and that did not fail in this run. */
	warnings: string[];
}

/** A failing chunk, as the runner's report shows it. */
interface ChunkFailure {
	label: string;
	exitCode: number;
	/** Failing tests, each `<file> > <describe> > <test>`. */
	names: string[];
	/** The runner's watchdog killed the chunk. */
	timedOut: boolean;
}

/** What the runner printed to stdout, read line by line. */
interface RunReport {
	/** `Running N test command(s)`: the chunks the run started with. */
	started?: number;
	/** The closing summary: `N chunks passed`, `N failed` and `Ran N test command(s)`. */
	passed?: number;
	failed?: number;
	ran?: number;
	/** Progress lines, one per chunk that finished. */
	passedLines: number;
	failedLines: number;
	/** One block per failing chunk, from its `✗ <label> (exit N)` header. */
	failures: ChunkFailure[];
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const RUNNING_RE = /^Running (\d+) test command\(s\)/;
const PROGRESS_RE = /^(✓|✗) .+ \[\d+(?:\.\d+)?(?:ms|s)\]/;
const FAILED_CHUNK_RE = /^✗ (.+) \(exit (-?\d+)\)$/;
const NAME_RE = /^ {2}✗ (.+)$/;
const PASSED_RE = /^ (\d+) chunks passed$/;
const FAILED_RE = /^ (\d+) failed$/;
const RAN_RE = /^Ran (\d+) test command\(s\) in .+\.$/;

const NAME_SEPARATOR = " > ";
const knownFailuresPath = path.join(import.meta.dir, "upstream-known-failures.txt");

/**
 * Parses `upstream-known-failures.txt`: one `<test file> :: <test name>` per line,
 * `#` lines are comments. A malformed or duplicate entry throws, because the list
 * decides which failures pass.
 */
export function parseKnownFailures(text: string): KnownFailure[] {
	const entries: KnownFailure[] = [];
	const seen = new Set<string>();
	for (const [index, rawLine] of text.split("\n").entries()) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const separator = line.indexOf(" :: ");
		const file = separator < 0 ? "" : line.slice(0, separator);
		const name = separator < 0 ? "" : line.slice(separator + 4).trim();
		if (!file.endsWith(".test.ts") || !name) {
			throw new Error(
				`upstream-known-failures.txt line ${index + 1}: expected "<test file> :: <test name>", got "${rawLine}"`,
			);
		}
		const key = `${file} :: ${name}`;
		if (seen.has(key)) {
			throw new Error(`upstream-known-failures.txt line ${index + 1}: ${key} is listed twice`);
		}
		seen.add(key);
		entries.push({ file, name });
	}
	return entries;
}

/**
 * The directory a chunk runs in. A `packages/<name>` chunk runs in its package;
 * the other chunks (the root `.omp/tests` one) run from the repository root.
 */
export function chunkDirectory(label: string): string {
	return /^(packages\/[^\s(]+)/.exec(label)?.[1] ?? ".";
}

function repoPath(directory: string, file: string): string {
	return path.posix.normalize(path.posix.join(directory, file));
}

/**
 * Reads `bun run <script> --dry-run`: one `==>` line per chunk, then the `$` line
 * of the command the chunk runs. The test files on those lines are the files the
 * run executes explicitly.
 */
export function parseChunkPlan(text: string): ChunkPlan {
	const files = new Set<string>();
	let chunks = 0;
	let directory = ".";
	for (const raw of text.split("\n")) {
		const line = raw.replace(ANSI_RE, "");
		if (line.startsWith("==> ")) {
			chunks += 1;
			directory = chunkDirectory(line.slice("==> ".length));
		} else if (line.startsWith("$ ")) {
			for (const token of line.slice(2).split(" ")) {
				if (token.endsWith(".test.ts")) files.add(repoPath(directory, token));
			}
		}
	}
	return { chunks, files: [...files].sort() };
}

/**
 * Reads the runner's report from its standard output. A failing chunk's block runs
 * from its `✗ <label> (exit N)` header to the next progress line or summary line,
 * and its failing tests are the `  ✗ <name>` lines in it.
 */
export function parseReport(stdout: string): RunReport {
	const report: RunReport = { passedLines: 0, failedLines: 0, failures: [] };
	let block: ChunkFailure | undefined;
	for (const raw of stdout.split("\n")) {
		const line = raw.replace(ANSI_RE, "").replace(/\r$/, "");
		const header = FAILED_CHUNK_RE.exec(line);
		if (header) {
			block = { label: header[1], exitCode: Number(header[2]), names: [], timedOut: false };
			report.failures.push(block);
			continue;
		}
		const started = RUNNING_RE.exec(line);
		if (started) {
			report.started = Number(started[1]);
			block = undefined;
			continue;
		}
		if (PROGRESS_RE.test(line)) {
			if (line.startsWith("✓")) report.passedLines += 1;
			else report.failedLines += 1;
			block = undefined;
			continue;
		}
		const passed = PASSED_RE.exec(line);
		if (passed) {
			report.passed = Number(passed[1]);
			block = undefined;
			continue;
		}
		if (report.passed !== undefined) {
			const failed = FAILED_RE.exec(line);
			const ran = RAN_RE.exec(line);
			if (failed) report.failed = Number(failed[1]);
			if (ran) report.ran = Number(ran[1]);
			continue;
		}
		if (!block) continue;
		const name = NAME_RE.exec(line);
		if (name) block.names.push(name[1]);
		else if (line.includes("[watchdog]")) block.timedOut = true;
	}
	return report;
}

/**
 * Judges one run. Returns the problems that fail it, the known failures it hit,
 * and the warnings. An empty `problems` list means the run passes.
 */
export function judgeRun(evidence: RunEvidence): RunVerdict {
	const { exitCode, plan, knownFailures } = evidence;
	const report = parseReport(evidence.stdout);
	const problems: string[] = [];
	const accepted = new Map<string, AcceptedFailure>();

	// The summary must account for every chunk the dry run planned. A sequential
	// run prints no summary; it exits 0 only when every chunk passed.
	const consistent =
		report.started !== undefined &&
		report.passed !== undefined &&
		report.failed !== undefined &&
		report.ran !== undefined &&
		report.started === plan.chunks &&
		report.ran === report.started &&
		report.passed + report.failed === report.started &&
		report.passedLines === report.passed &&
		report.failedLines === report.failed &&
		report.failures.length === report.failed;

	if (plan.chunks === 0) {
		problems.push("the dry run planned no test chunk, so nothing was judged");
	}
	if (exitCode === 0) {
		if (report.failures.length > 0) {
			problems.push("the run exited 0 but its report lists failing chunks");
		} else if (report.started !== undefined && !consistent) {
			problems.push(`the run exited 0 but its summary does not match the ${plan.chunks} chunk(s) of the dry run`);
		}
	} else {
		if (!consistent) {
			problems.push(
				`the script did not run to completion: its summary does not match the ${plan.chunks} chunk(s) of the dry run, so no failure can be accepted`,
			);
		}
		if (report.failures.length === 0) {
			problems.push(`the script exited ${exitCode} without reporting a failing chunk`);
		}
	}

	for (const failure of report.failures) {
		if (failure.timedOut) {
			problems.push(
				`${failure.label} was killed by the chunk watchdog (exit ${failure.exitCode}); a timeout fails the job`,
			);
		} else if (failure.exitCode !== 1) {
			problems.push(
				`${failure.label} exited ${failure.exitCode}; only failing tests (exit 1) can be accepted, and a crash or a kill fails the job`,
			);
		}
		if (failure.names.length === 0) {
			problems.push(`${failure.label} failed without naming a failing test`);
		}
		for (const name of failure.names) {
			const split = name.indexOf(NAME_SEPARATOR);
			if (split < 0) {
				problems.push(`${failure.label} names a failure with no test file: ${name}`);
				continue;
			}
			const file = repoPath(chunkDirectory(failure.label), name.slice(0, split));
			const testName = name.slice(split + NAME_SEPARATOR.length);
			const known = knownFailures.find(entry => entry.file === file && entry.name === testName);
			if (!known) {
				problems.push(`unlisted failure: ${file} :: ${testName}`);
				continue;
			}
			const key = `${known.file} :: ${known.name}`;
			if (!accepted.has(key)) accepted.set(key, { ...known, chunk: failure.label });
		}
	}

	const warnings: string[] = [];
	// Every chunk ran when the summary adds up, or when a sequential run exited 0.
	if (exitCode === 0 || consistent) {
		const planned = new Set(plan.files);
		for (const entry of knownFailures) {
			if (planned.has(entry.file) && !accepted.has(`${entry.file} :: ${entry.name}`)) {
				warnings.push(
					`${entry.file} :: ${entry.name} did not fail in this run (it passed or was skipped); remove its entry if it keeps passing`,
				);
			}
		}
	}

	return { ok: problems.length === 0, problems, accepted: [...accepted.values()], warnings };
}

/** Reads a child's stdout and stderr while the child runs, forwarding them when asked. */
async function runCapturing(argv: string[], forward: boolean): Promise<{ exitCode: number; stdout: string }> {
	const child = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
	const [stdout, , exitCode] = await Promise.all([
		drain(child.stdout as ReadableStream<Uint8Array>, forward ? chunk => process.stdout.write(chunk) : undefined),
		drain(child.stderr as ReadableStream<Uint8Array>, forward ? chunk => process.stderr.write(chunk) : undefined),
		child.exited,
	]);
	return { exitCode, stdout };
}

async function drain(stream: ReadableStream<Uint8Array>, forward?: (chunk: Uint8Array) => void): Promise<string> {
	const decoder = new TextDecoder();
	let text = "";
	for await (const chunk of stream) {
		forward?.(chunk);
		text += decoder.decode(chunk, { stream: true });
	}
	return text + decoder.decode();
}

function formatVerdict(script: string, verdict: RunVerdict): string {
	const lines = [`### Full suite: \`${script}\``, "", verdict.ok ? "Result: passed." : "Result: failed.", ""];
	if (verdict.accepted.length > 0) {
		lines.push("Known failures accepted (they count as passing in this mode):");
		for (const failure of verdict.accepted) {
			lines.push(`- \`${failure.file} :: ${failure.name}\` in ${failure.chunk}`);
		}
		lines.push("");
	}
	if (verdict.warnings.length > 0) {
		lines.push("Warnings:", ...verdict.warnings.map(warning => `- ${warning}`), "");
	}
	if (verdict.problems.length > 0) {
		lines.push("Problems:", ...verdict.problems.map(problem => `- ${problem}`), "");
	}
	return lines.join("\n");
}

async function main(): Promise<void> {
	const script = process.argv[2] ?? "";
	if (!/^ci:test:[\w:-]+$/.test(script)) {
		throw new Error(`Usage: bun scripts/xsec/run-full-suite.ts <ci:test:* script>; got ${JSON.stringify(script)}`);
	}
	const knownFailures = parseKnownFailures(await Bun.file(knownFailuresPath).text());

	const dryRun = await runCapturing(["bun", "run", script, "--dry-run"], false);
	if (dryRun.exitCode !== 0) {
		console.log(`::error title=Full suite::the dry run of ${script} exited ${dryRun.exitCode}; nothing was judged`);
		process.exitCode = 1;
		return;
	}
	const plan = parseChunkPlan(dryRun.stdout);

	const run = await runCapturing(["bun", "run", script], true);
	const verdict = judgeRun({ exitCode: run.exitCode, stdout: run.stdout, plan, knownFailures });

	for (const failure of verdict.accepted) {
		console.log(`::notice title=Known failure::${failure.file} :: ${failure.name}`);
	}
	for (const warning of verdict.warnings) console.log(`::warning title=Known failure::${warning}`);
	for (const problem of verdict.problems) console.log(`::error title=Full suite::${problem}`);

	const markdown = formatVerdict(script, verdict);
	console.log(markdown);
	const summaryPath = Bun.env.GITHUB_STEP_SUMMARY;
	if (summaryPath) await fs.appendFile(summaryPath, `${markdown}\n`);
	process.exitCode = verdict.ok ? 0 : 1;
}

if (import.meta.main) await main();
