import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gitText, parentsOf, resolveCommit } from "./sync-git";

// Runs sync.ts the way the workflow does: from a fresh checkout of the fork, with
// real git repositories for the fork and upstream, and a fake GitHub REST API that
// records each request. Scenarios run in order and share the repositories.

const REPO = "xsec-labs/oh-my-pi";
const TOKEN = "test-token";
const READ_TOKEN = "read-token";
const SCRIPTS = path.join(import.meta.dir);
const SYNC_SOURCES = ["upstream.ts", "check-upstream-diff.ts", "sync-policy.ts", "sync-git.ts", "sync.ts"];

const IDENTITY = {
	GIT_AUTHOR_NAME: "test",
	GIT_AUTHOR_EMAIL: "test@example.invalid",
	GIT_COMMITTER_NAME: "test",
	GIT_COMMITTER_EMAIL: "test@example.invalid",
};

interface FakeCheckRun {
	name: string;
	status: string;
	conclusion: string | null;
}

interface FakePull {
	number: number;
	state: "open" | "closed";
	merged_at: string | null;
	draft: boolean;
	html_url: string;
	head: { ref: string; sha: string; repo: { full_name: string } };
	base: { ref: string };
	mergeable: boolean | null;
}

/** The part of the GitHub REST API that sync.ts uses, backed by a local bare repository. */
class FakeGitHub {
	readonly pulls: FakePull[] = [];
	readonly requests: string[] = [];
	checkRuns: FakeCheckRun[] = [];
	statusState = "pending";
	statusCount = 0;
	/** When set, the next merge is refused with this status and message instead of merging. */
	mergeRefusal: { status: number; message: string } | null = null;
	readonly #origin: string;
	#server: Bun.Server<undefined> | null = null;

	constructor(origin: string) {
		this.#origin = origin;
	}

	get url(): string {
		return `http://127.0.0.1:${this.#server?.port}`;
	}

	start(): void {
		this.#server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: request => this.#handle(request) });
	}

	stop(): void {
		this.#server?.stop(true);
	}

	async #sha(ref: string): Promise<string> {
		return gitText(["rev-parse", `refs/heads/${ref}`], { cwd: this.#origin }).then(text => text.trim());
	}

	async #pullView(pull: FakePull): Promise<FakePull> {
		return { ...pull, head: { ...pull.head, sha: await this.#sha(pull.head.ref) } };
	}

	json(body: unknown, status = 200): Response {
		return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
	}

	async #handle(request: Request): Promise<Response> {
		const url = new URL(request.url);
		this.requests.push(`${request.method} ${url.pathname}`);
		// Reads carry the workflow's own token, writes carry the sync token.
		const expected = request.method === "GET" ? READ_TOKEN : TOKEN;
		if (request.headers.get("authorization") !== `Bearer ${expected}`)
			return this.json({ message: "bad token" }, 401);
		const base = `/repos/${REPO}`;
		if (request.method === "GET" && url.pathname === `${base}/pulls`) {
			const state = url.searchParams.get("state");
			const head = url.searchParams.get("head");
			const listed = this.pulls.filter(
				pull =>
					pull.state === state &&
					(head === null || `xsec-labs:${pull.head.ref}` === head) &&
					(url.searchParams.get("base") === null || pull.base.ref === url.searchParams.get("base")),
			);
			return this.json(await Promise.all(listed.map(pull => this.#pullView(pull))));
		}
		if (request.method === "POST" && url.pathname === `${base}/pulls`) {
			const body = (await request.json()) as { head: string; base: string };
			const number = this.pulls.length + 1;
			this.pulls.push({
				number,
				state: "open",
				merged_at: null,
				draft: false,
				html_url: `https://github.example/${REPO}/pull/${number}`,
				head: { ref: body.head, sha: "", repo: { full_name: REPO } },
				base: { ref: body.base },
				mergeable: true,
			});
			return this.json(await this.#pullView(this.pulls[number - 1]), 201);
		}
		const pullMatch = new RegExp(`^${base}/pulls/(\\d+)(/merge)?$`).exec(url.pathname);
		if (pullMatch) {
			const pull = this.pulls.find(candidate => candidate.number === Number(pullMatch[1]));
			if (!pull) return this.json({ message: "not found" }, 404);
			if (request.method === "GET" && !pullMatch[2]) return this.json(await this.#pullView(pull));
			if (request.method === "PUT" && pullMatch[2])
				return this.#merge(pull, (await request.json()) as { sha: string });
		}
		const commitMatch = new RegExp(`^${base}/commits/([0-9a-f]+)/(check-runs|status)$`).exec(url.pathname);
		if (request.method === "GET" && commitMatch) {
			if (commitMatch[2] === "check-runs")
				return this.json({ total_count: this.checkRuns.length, check_runs: this.checkRuns });
			return this.json({ state: this.statusState, total_count: this.statusCount });
		}
		return this.json({ message: "not found" }, 404);
	}

	async #merge(pull: FakePull, body: { sha: string }): Promise<Response> {
		if (this.mergeRefusal) return this.json({ message: this.mergeRefusal.message }, this.mergeRefusal.status);
		const head = await this.#sha(pull.head.ref);
		if (body.sha !== head) return this.json({ message: "head moved" }, 409);
		// Stands in for GitHub's merge: xsec gets a merge commit whose tree is the head's.
		const xsec = await this.#sha("xsec");
		const tree = (await gitText(["rev-parse", `${head}^{tree}`], { cwd: this.#origin })).trim();
		const merge = (
			await gitText(["commit-tree", tree, "-p", xsec, "-p", head, "-m", `Merge pull request #${pull.number}`], {
				cwd: this.#origin,
				env: IDENTITY,
			})
		).trim();
		await gitText(["update-ref", "refs/heads/xsec", merge, xsec], { cwd: this.#origin });
		pull.state = "closed";
		pull.merged_at = new Date().toISOString();
		return this.json({ merged: true, sha: merge });
	}
}

async function commitFiles(dir: string, files: Record<string, string>, message: string): Promise<string> {
	for (const [name, content] of Object.entries(files)) {
		await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
		await Bun.write(path.join(dir, name), content);
	}
	await gitText(["add", "-A"], { cwd: dir });
	await gitText(["commit", "--quiet", "-m", message], { cwd: dir, env: IDENTITY });
	return (await gitText(["rev-parse", "HEAD"], { cwd: dir })).trim();
}

function manifest(version: string): string {
	return `${JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version }, null, "\t")}\n`;
}

async function sha(ref: string, cwd: string): Promise<string> {
	return (await gitText(["rev-parse", ref], { cwd })).trim();
}

let root = "";
let upstreamWork = "";
let upstreamBare = "";
let origin = "";
let summaryFile = "";
let api: FakeGitHub;
let runCount = 0;
let xsecSha = "";
let upstreamV21 = "";

/** Publishes a release on upstream: a commit, its tag, and the new main. */
async function publishUpstream(tag: string, files: Record<string, string>): Promise<string> {
	const commit = await commitFiles(upstreamWork, files, `upstream ${tag}`);
	await gitText(["tag", tag], { cwd: upstreamWork });
	await gitText(["push", "--quiet", upstreamBare, "main", tag], { cwd: upstreamWork });
	return commit;
}

/** Adds a fork commit to xsec on the fork, as a person's pull request would. */
async function forkCommit(files: Record<string, string>, message: string): Promise<string> {
	const editor = path.join(root, `fork-edit-${runCount++}`);
	await gitText(["clone", "--quiet", origin, editor]);
	await gitText(["checkout", "--quiet", "xsec"], { cwd: editor });
	const commit = await commitFiles(editor, files, message);
	await gitText(["push", "--quiet", "origin", "xsec"], { cwd: editor });
	return commit;
}

interface RunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	summary: string;
}

/** Runs sync.ts from a fresh checkout of the fork, as the workflow does. */
async function runSync(overrides: Record<string, string | undefined> = {}): Promise<RunResult> {
	const clone = path.join(root, `checkout-${runCount++}`);
	await gitText(["clone", "--quiet", origin, clone]);
	const env: Record<string, string | undefined> = {
		...Bun.env,
		OMP_SYNC_TOKEN: TOKEN,
		GITHUB_READ_TOKEN: READ_TOKEN,
		GITHUB_REPOSITORY: REPO,
		GITHUB_API_URL: api.url,
		XSEC_SYNC_UPSTREAM: upstreamBare,
		GITHUB_STEP_SUMMARY: summaryFile,
		DRY_RUN: "0",
		...overrides,
	};
	const child = Bun.spawn([process.execPath, path.join(clone, "scripts", "xsec", "sync.ts")], {
		cwd: clone,
		env: env as Record<string, string>,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	const summary = await fs.readFile(summaryFile, "utf8").catch(() => "");
	await fs.writeFile(summaryFile, "");
	return { exitCode, stdout, stderr, summary };
}

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "xsec-sync-e2e-"));
	summaryFile = path.join(root, "summary.md");
	await fs.writeFile(summaryFile, "");

	// Upstream: v18.20.0 is the base, v18.21.0 is the newest release.
	upstreamWork = path.join(root, "upstream-work");
	await fs.mkdir(upstreamWork);
	await gitText(["init", "--quiet", "-b", "main"], { cwd: upstreamWork });
	await commitFiles(
		upstreamWork,
		{ "packages/coding-agent/package.json": manifest("18.20.0"), "a.txt": "a\n", "README.md": "readme\n" },
		"upstream v18.20.0",
	);
	await gitText(["tag", "v18.20.0"], { cwd: upstreamWork });
	upstreamV21 = await commitFiles(
		upstreamWork,
		{ "packages/coding-agent/package.json": manifest("18.21.0"), "a.txt": "a upstream 21\n" },
		"upstream a change",
	);
	await gitText(["tag", "v18.21.0"], { cwd: upstreamWork });
	upstreamBare = path.join(root, "upstream.git");
	await gitText(["clone", "--quiet", "--bare", upstreamWork, upstreamBare]);

	// Fork: origin main is behind upstream, and xsec carries a fork commit with the sync scripts.
	const forkWork = path.join(root, "fork-work");
	await gitText(["clone", "--quiet", upstreamBare, forkWork]);
	await gitText(["checkout", "--quiet", "-b", "xsec", "v18.20.0"], { cwd: forkWork });
	await gitText(["branch", "-f", "main", "v18.20.0"], { cwd: forkWork });
	const sources: Record<string, string> = {
		"packages/coding-agent/src/xsec/acp.ts": "export const fork = true;\n",
	};
	for (const name of SYNC_SOURCES) sources[`scripts/xsec/${name}`] = await Bun.file(path.join(SCRIPTS, name)).text();
	await commitFiles(forkWork, sources, "fork: sync scripts and an xsec file");
	origin = path.join(root, "origin.git");
	await gitText(["clone", "--quiet", "--bare", "--no-tags", forkWork, origin]);
	xsecSha = await sha("xsec", origin);

	api = new FakeGitHub(origin);
	api.start();
});

afterAll(async () => {
	api?.stop();
	if (root) await fs.rm(root, { recursive: true, force: true });
});

describe("sync.ts against a fork and a fake GitHub", () => {
	it("stops with a clear error when the sync token is missing", async () => {
		const run = await runSync({ OMP_SYNC_TOKEN: "" });
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain("OMP_SYNC_TOKEN is not set");
		expect(api.requests).toEqual([]);
	});

	it("stops with a clear error when the workflow's read token is missing", async () => {
		const run = await runSync({ GITHUB_READ_TOKEN: "" });
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain("GITHUB_READ_TOKEN is not set");
		expect(api.requests).toEqual([]);
	});

	it("dry run plans the sync and writes nothing to the fork", async () => {
		const mainBefore = await sha("main", origin);
		const run = await runSync({ DRY_RUN: "1" });
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toContain("Dry run");
		expect(run.stdout).toContain("Merge v18.21.0 into xsec");
		expect(await sha("main", origin)).toBe(mainBefore);
		expect(api.pulls).toHaveLength(0);
		expect(await resolveCommit("refs/heads/sync/v18.21.0", origin)).toBeNull();
	});

	it("fast-forwards main, then opens one sync pull request carrying the release", async () => {
		const run = await runSync({});
		expect(run.exitCode).toBe(0);
		expect(await sha("main", origin)).toBe(upstreamV21);
		const branch = await sha("sync/v18.21.0", origin);
		// The merge has xsec first and the release second, so the pull request holds only upstream's changes.
		expect(await parentsOf(branch, origin)).toEqual([xsecSha, upstreamV21]);
		expect(api.pulls.map(pull => [pull.number, pull.head.ref, pull.state])).toEqual([[1, "sync/v18.21.0", "open"]]);
	});

	it("keeps the pull request open while a check is still running, and does not merge it", async () => {
		api.checkRuns = [{ name: "Fork scope", status: "in_progress", conclusion: null }];
		const run = await runSync({});
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toContain("#1 stays open: check Fork scope is in_progress");
		expect(api.requests.filter(request => request.startsWith("PUT"))).toEqual([]);
		expect(api.pulls).toHaveLength(1);
	});

	it("merges the pull request once every check is green", async () => {
		api.checkRuns = [
			{ name: "Fork scope", status: "completed", conclusion: "success" },
			{ name: "Test workspace", status: "completed", conclusion: "skipped" },
		];
		const branchHead = await sha("sync/v18.21.0", origin);
		const xsecBefore = await sha("xsec", origin);
		const run = await runSync({});
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toContain("#1 merges");
		expect(api.requests.filter(request => request.startsWith("PUT"))).toEqual([`PUT /repos/${REPO}/pulls/1/merge`]);
		expect(api.pulls[0]?.state).toBe("closed");
		// The fake's merge puts xsec's previous head and the pull request head side by side.
		expect(await parentsOf(await sha("xsec", origin), origin)).toEqual([xsecBefore, branchHead]);
	});

	it("opens the next sync pull request for a newer release once the last one has merged", async () => {
		const upstreamV2111 = await publishUpstream("v18.21.1", {
			"packages/coding-agent/package.json": manifest("18.21.1"),
			"a.txt": "a upstream 21.1\n",
		});
		const run = await runSync({});
		expect(run.exitCode).toBe(0);
		expect(await sha("main", origin)).toBe(upstreamV2111);
		expect(api.pulls.at(-1)).toMatchObject({ number: 2, state: "open", head: { ref: "sync/v18.21.1" } });
	});

	it("keeps the pull request open when GitHub refuses the merge as not mergeable", async () => {
		api.mergeRefusal = { status: 405, message: "Pull Request is not mergeable" };
		const run = await runSync({});
		api.mergeRefusal = null;
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toContain("GitHub refused the merge, so #2 stays open");
		expect(api.pulls[1]?.state).toBe("open");
	});

	it("fails the run, naming the permission to add, when GitHub refuses the merge with 403", async () => {
		api.mergeRefusal = { status: 403, message: "Resource not accessible by personal access token" };
		const run = await runSync({});
		api.mergeRefusal = null;
		expect(run.exitCode).toBe(1);
		expect(run.stderr).toContain("OMP_SYNC_TOKEN may lack a permission this request needs");
		expect(run.summary).toContain("**Sync failed:**");
		expect(api.pulls[1]?.state).toBe("open");
	});

	it("rebuilds an open sync branch on the new xsec head when a fork change lands meanwhile", async () => {
		const forkChange = await forkCommit(
			{ "packages/coding-agent/src/xsec/more.ts": "export const more = 1;\n" },
			"fork: more xsec work",
		);
		const run = await runSync({});
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toContain("rebuilt sync/v18.21.1");
		expect(api.pulls).toHaveLength(2);
		const branch = await sha("sync/v18.21.1", origin);
		expect(await parentsOf(branch, origin)).toEqual([forkChange, await sha("main", origin)]);
	});

	it("merges the rebuilt pull request once its checks are green", async () => {
		const run = await runSync({});
		expect(run.exitCode).toBe(0);
		expect(run.stdout).toContain("#2 merges");
		expect(api.pulls[1]?.state).toBe("closed");
	});

	it("fails with the conflicting files and their upstream commits when a release cannot merge", async () => {
		await forkCommit({ "README.md": "readme, changed by the fork\n" }, "fork: README");
		await publishUpstream("v18.21.2", {
			"packages/coding-agent/package.json": manifest("18.21.2"),
			"README.md": "readme, changed upstream\n",
		});
		const run = await runSync({});
		expect(run.exitCode).toBe(1);
		expect(run.summary).toContain("`README.md`");
		expect(run.summary).toContain("upstream v18.21.2");
		expect(run.stderr).toContain("conflicts");
		expect(api.pulls).toHaveLength(2);
	});
});
