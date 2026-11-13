import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	type ChunkPlan,
	judgeRun,
	type KnownFailure,
	parseChunkPlan,
	parseKnownFailures,
	type RunVerdict,
} from "./run-full-suite";

const fixturesDir = path.join(import.meta.dir, "fixtures", "full-suite");
const repoRoot = path.join(import.meta.dir, "..", "..");

const relayDetach: KnownFailure = {
	file: "packages/coding-agent/test/tools/browser-relay-detach.test.ts",
	name: "relay tabs Chrome detaches omp from > reports a cancel that lands during the re-adoption as a cancel",
};

function fixture(name: string): Promise<string> {
	return Bun.file(path.join(fixturesDir, name)).text();
}

function planOf(name: string): Promise<ChunkPlan> {
	return fixture(name).then(parseChunkPlan);
}

function committedKnownFailures(): Promise<KnownFailure[]> {
	return Bun.file(path.join(import.meta.dir, "upstream-known-failures.txt"))
		.text()
		.then(parseKnownFailures);
}

async function judge(stdout: string, plan: ChunkPlan, exitCode = 1): Promise<RunVerdict> {
	return judgeRun({ exitCode, stdout, plan, knownFailures: await committedKnownFailures() });
}

/** Replaces the line an edit targets. Throws when the fixture no longer has it, so a stale edit fails loudly. */
function edit(text: string, pattern: RegExp, replacement: string): string {
	const edited = text.replace(pattern, replacement);
	if (edited === text) throw new Error(`the fixture has no match for ${pattern}`);
	return edited;
}

/** Drops the runner's closing summary: `N chunks passed`, `N failed` and `Ran N test command(s)`. */
function withoutSummary(text: string): string {
	return edit(text, /^ \d+ chunks passed\n \d+ failed\nRan \d+ test command\(s\) in [^\n]*\n/m, "");
}

/** Drops the runner's header and progress lines, leaving the shape the sequential mode prints. */
function withoutRunnerLines(text: string): string {
	return text
		.split("\n")
		.filter(line => !/^Running \d+ test command|^(✓|✗) /.test(line))
		.join("\n");
}

function hasProblem(verdict: RunVerdict, fragment: string): boolean {
	return verdict.problems.some(problem => problem.includes(fragment));
}

describe("known failures list", () => {
	it("names the browser-relay-detach failure in the committed list", async () => {
		expect(await committedKnownFailures()).toContainEqual(relayDetach);
	});

	it("names only test files that exist in the repository, so a typo cannot silently match nothing", async () => {
		for (const entry of await committedKnownFailures()) {
			expect(await Bun.file(path.join(repoRoot, entry.file)).exists()).toBe(true);
		}
	});

	it("rejects an entry that names no test or no test file", () => {
		expect(() => parseKnownFailures("packages/x/test/a.test.ts ::\n")).toThrow("line 1");
		expect(() => parseKnownFailures("packages/x/src/a.ts :: some test\n")).toThrow("expected");
	});

	it("rejects a test listed twice", () => {
		expect(() => parseKnownFailures("a.test.ts :: t\n# note\na.test.ts :: t\n")).toThrow("listed twice");
	});

	it("reads # lines as comments and keeps a # that is part of a test name", () => {
		expect(parseKnownFailures("# why\npackages/x/test/a.test.ts :: check #12 > ok\n")).toEqual([
			{ file: "packages/x/test/a.test.ts", name: "check #12 > ok" },
		]);
	});
});

describe("chunk plan", () => {
	it("maps each chunk's test files to the package the chunk runs in", async () => {
		const plan = await planOf("native-3-3-dry-run.txt");
		expect(plan.chunks).toBe(37);
		expect(plan.files).toContain(relayDetach.file);
		expect(plan.files.every(file => file.startsWith("packages/coding-agent/test/"))).toBe(true);
	});

	it("maps the files of a chunk that runs from the repository root to root paths", () => {
		const plan = parseChunkPlan(
			"==> .omp/tests (project-local TUI debug tool)\n$ bun test --only-failures ./.omp/tests/tui.test.ts --parallel=1\n",
		);
		expect(plan).toEqual({ chunks: 1, files: [".omp/tests/tui.test.ts"] });
	});
});

describe("judging recorded runs", () => {
	it("accepts a run whose only failing test is listed, and reports which chunk hit it", async () => {
		const verdict = await judge(await fixture("native-3-3-listed-only.txt"), await planOf("native-3-3-dry-run.txt"));
		expect(verdict.problems).toEqual([]);
		expect(verdict.ok).toBe(true);
		expect(verdict.accepted).toHaveLength(1);
		expect(verdict.accepted[0]).toMatchObject({ ...relayDetach, chunk: expect.stringContaining("chunk 84/112") });
		expect(verdict.warnings).toEqual([]);
	});

	it("rejects a listed failure that comes with an unlisted one, naming each unlisted test", async () => {
		const verdict = await judge(
			await fixture("native-3-3-listed-and-unlisted.txt"),
			await planOf("native-3-3-dry-run.txt"),
		);
		expect(verdict.ok).toBe(false);
		expect(verdict.accepted).toHaveLength(1);
		const unlisted = verdict.problems.filter(problem => problem.startsWith("unlisted failure:"));
		expect(unlisted).toHaveLength(6);
		expect(unlisted.every(problem => problem.includes("browser-tab-worker-startup.test.ts"))).toBe(true);
		expect(verdict.problems).toHaveLength(6);
	});

	it("passes a run that passed in full, with no warning for a listed test its plan does not run", async () => {
		const verdict = await judge(await fixture("native-1-3-pass.txt"), await planOf("native-1-3-dry-run.txt"), 0);
		expect(verdict.ok).toBe(true);
		expect(verdict.problems).toEqual([]);
		expect(verdict.warnings).toEqual([]);
	});

	it("warns about a listed test whose file the plan runs when the run passes without failing it", async () => {
		const plan = await planOf("native-1-3-dry-run.txt");
		const verdict = await judge(
			await fixture("native-1-3-pass.txt"),
			{ ...plan, files: [...plan.files, relayDetach.file].sort() },
			0,
		);
		expect(verdict.ok).toBe(true);
		expect(verdict.warnings).toHaveLength(1);
		expect(verdict.warnings[0]).toContain(relayDetach.name);
	});

	it("accepts a passing run that prints no runner summary, as the sequential mode does", async () => {
		const stdout = withoutRunnerLines(withoutSummary(await fixture("native-1-3-pass.txt")));
		const verdict = await judge(stdout, await planOf("native-1-3-dry-run.txt"), 0);
		expect(verdict.ok).toBe(true);
		expect(verdict.problems).toEqual([]);
	});

	it("fails a run whose only failure is listed when the run did not reach its summary", async () => {
		const stdout = withoutSummary(await fixture("native-3-3-listed-only.txt"));
		const verdict = await judge(stdout, await planOf("native-3-3-dry-run.txt"));
		expect(verdict.ok).toBe(false);
		expect(hasProblem(verdict, "did not run to completion")).toBe(true);
	});

	it("fails a run whose summary disagrees with the chunk count of its dry run", async () => {
		const plan = await planOf("native-3-3-dry-run.txt");
		const verdict = await judge(await fixture("native-3-3-listed-only.txt"), { ...plan, chunks: plan.chunks + 1 });
		expect(verdict.ok).toBe(false);
		expect(hasProblem(verdict, "did not run to completion")).toBe(true);
	});

	it("fails a run that exits nonzero while its report shows every chunk passing", async () => {
		const verdict = await judge(await fixture("native-1-3-pass.txt"), await planOf("native-1-3-dry-run.txt"), 1);
		expect(verdict.ok).toBe(false);
		expect(hasProblem(verdict, "without reporting a failing chunk")).toBe(true);
	});

	it("fails a chunk that exits with a crash code, even when every test it names is listed", async () => {
		const stdout = edit(await fixture("native-3-3-listed-only.txt"), /\(exit 1\)$/m, "(exit 133)");
		const verdict = await judge(stdout, await planOf("native-3-3-dry-run.txt"));
		expect(verdict.ok).toBe(false);
		expect(verdict.accepted).toHaveLength(1);
		expect(hasProblem(verdict, "exited 133")).toBe(true);
	});

	it("fails a chunk that is killed with exit 137 outside the watchdog, as an OOM kill is", async () => {
		const stdout = edit(await fixture("native-3-3-listed-only.txt"), /\(exit 1\)$/m, "(exit 137)");
		const verdict = await judge(stdout, await planOf("native-3-3-dry-run.txt"));
		expect(verdict.ok).toBe(false);
		expect(hasProblem(verdict, "exited 137")).toBe(true);
	});

	it("fails a chunk whose report names no failing test", async () => {
		const stdout = edit(
			await fixture("native-3-3-listed-only.txt"),
			/^  ✗ test\/tools\/browser-relay-detach\.test\.ts > [^\n]*\n/m,
			"",
		);
		const verdict = await judge(stdout, await planOf("native-3-3-dry-run.txt"));
		expect(verdict.ok).toBe(false);
		expect(hasProblem(verdict, "failed without naming a failing test")).toBe(true);
	});

	it("fails a failing test name that carries no test file, even when its test is listed", async () => {
		const stdout = edit(
			await fixture("native-3-3-listed-only.txt"),
			/^  ✗ test\/tools\/browser-relay-detach\.test\.ts > relay tabs Chrome detaches omp from > /m,
			"  ✗ ",
		);
		const verdict = await judge(stdout, await planOf("native-3-3-dry-run.txt"));
		expect(verdict.ok).toBe(false);
		expect(hasProblem(verdict, "names a failure with no test file")).toBe(true);
	});

	it("does not accept a listed test that a chunk of another package reports", async () => {
		const stdout = (await fixture("native-3-3-listed-only.txt")).replaceAll(
			"packages/coding-agent (",
			"packages/ai (",
		);
		const verdict = await judge(stdout, await planOf("native-3-3-dry-run.txt"));
		expect(verdict.ok).toBe(false);
		expect(verdict.accepted).toHaveLength(0);
		expect(hasProblem(verdict, "unlisted failure: packages/ai/test/tools/browser-relay-detach.test.ts")).toBe(true);
	});

	it("fails a watchdog timeout, in which every chunk is killed and names no test", async () => {
		// The shard 1/4 plan has 28 chunks: the run's own header says so.
		const verdict = await judge(await fixture("native-1-4-watchdog-timeout.txt"), { chunks: 28, files: [] });
		expect(verdict.ok).toBe(false);
		expect(verdict.problems.filter(problem => problem.includes("killed by the chunk watchdog"))).toHaveLength(28);
		expect(verdict.problems.filter(problem => problem.includes("failed without naming a failing test"))).toHaveLength(
			28,
		);
		expect(verdict.accepted).toEqual([]);
	});

	it("fails a dry run that planned no chunk, so nothing is passed for having run nothing", async () => {
		const verdict = await judge(await fixture("native-1-3-pass.txt"), { chunks: 0, files: [] }, 0);
		expect(verdict.ok).toBe(false);
		expect(hasProblem(verdict, "planned no test chunk")).toBe(true);
	});
});
