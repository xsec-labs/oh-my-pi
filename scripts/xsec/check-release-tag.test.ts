import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { checkReleaseCommit, decideRelease, listXsecCiRuns, type WorkflowRun } from "./check-release-tag";
import { gitText } from "./sync-git";

const SHA = "0025b03e600228bd5cb487b507c6bb7f9fa280be";
const OTHER_SHA = "30dd9255cb1e1887ff307ea0baa6a99f23a8a83a";

/** A completed, successful push run of xsec-ci.yml on xsec: the run a release needs. */
function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
	return {
		id: 43382604491,
		path: ".github/workflows/xsec-ci.yml",
		event: "push",
		head_branch: "xsec",
		head_sha: SHA,
		status: "completed",
		conclusion: "success",
		created_at: "2026-11-13T07:00:21Z",
		...overrides,
	};
}

describe("decideRelease", () => {
	test("allows a commit of xsec whose push run succeeded", () => {
		expect(decideRelease({ sha: SHA, reachableFromXsec: true, runs: [run()] }).ok).toBe(true);
	});

	test("refuses a commit that xsec does not contain, even with a green run", () => {
		expect(decideRelease({ sha: SHA, reachableFromXsec: false, runs: [run()] }).ok).toBe(false);
	});

	test("refuses a commit that has no xsec CI push run", () => {
		expect(decideRelease({ sha: SHA, reachableFromXsec: true, runs: [] }).ok).toBe(false);
	});

	const notCounted: [string, Partial<WorkflowRun>][] = [
		["another commit", { head_sha: OTHER_SHA }],
		["another branch", { head_branch: "main" }],
		["a pull request event", { event: "pull_request" }],
		["another workflow", { path: ".github/workflows/xsec-release.yml" }],
	];
	test.each(notCounted)("does not count a run of %s as the commit's CI", (_label, override) => {
		expect(decideRelease({ sha: SHA, reachableFromXsec: true, runs: [run(override)] }).ok).toBe(false);
	});

	test("refuses while the newest push run has not finished", () => {
		const pending = run({ status: "in_progress", conclusion: null });
		expect(decideRelease({ sha: SHA, reachableFromXsec: true, runs: [pending] }).ok).toBe(false);
	});

	test("refuses when the newest push run failed, even after an earlier success", () => {
		const earlier = run({ id: 1, created_at: "2026-11-13T06:50:00Z" });
		const newer = run({ id: 2, created_at: "2026-11-13T07:00:00Z", conclusion: "failure" });
		expect(decideRelease({ sha: SHA, reachableFromXsec: true, runs: [earlier, newer] }).ok).toBe(false);
		expect(decideRelease({ sha: SHA, reachableFromXsec: true, runs: [newer, earlier] }).ok).toBe(false);
	});

	test("allows a commit whose newest push run succeeded after an earlier failure", () => {
		const earlier = run({ id: 1, created_at: "2026-11-13T06:50:00Z", conclusion: "failure" });
		const newer = run({ id: 2, created_at: "2026-11-13T07:00:00Z" });
		expect(decideRelease({ sha: SHA, reachableFromXsec: true, runs: [earlier, newer] }).ok).toBe(true);
		expect(decideRelease({ sha: SHA, reachableFromXsec: true, runs: [newer, earlier] }).ok).toBe(true);
	});
});

describe("listXsecCiRuns", () => {
	test("asks GitHub for the push runs of the commit on xsec", async () => {
		let query = new URLSearchParams();
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				query = new URL(request.url).searchParams;
				return Response.json({ total_count: 1, workflow_runs: [run()] });
			},
		});
		try {
			const runs = await listXsecCiRuns({
				apiUrl: server.url.origin,
				repository: "xsec-labs/oh-my-pi",
				token: "test-token",
				sha: SHA,
			});
			expect(runs).toEqual([run()]);
			expect(query.get("head_sha")).toBe(SHA);
			expect(query.get("branch")).toBe("xsec");
			expect(query.get("event")).toBe("push");
		} finally {
			server.stop(true);
		}
	});

	test("reports a token that cannot read the runs instead of finding none", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: () => new Response("Resource not accessible by integration", { status: 403 }),
		});
		try {
			const listing = listXsecCiRuns({
				apiUrl: server.url.origin,
				repository: "xsec-labs/oh-my-pi",
				token: "test-token",
				sha: SHA,
			});
			await expect(listing).rejects.toThrow("HTTP 403");
		} finally {
			server.stop(true);
		}
	});
});

describe("checkReleaseCommit", () => {
	/**
	 * A clone whose origin/xsec is its first commit. The second commit sits on a
	 * branch of its own, so xsec does not contain it.
	 */
	async function cloneWithCommits(): Promise<{ repo: string; onXsec: string; offXsec: string }> {
		const repo = await fs.mkdtemp(path.join(os.tmpdir(), "xsec-release-tag-"));
		const git = (args: string[]) => gitText(args, { cwd: repo });
		const commit = (message: string) =>
			git([
				"-c",
				"user.name=test",
				"-c",
				"user.email=test@example.com",
				"commit",
				"-q",
				"--allow-empty",
				"-m",
				message,
			]);
		await git(["init", "-q"]);
		await commit("on xsec");
		const onXsec = (await git(["rev-parse", "HEAD"])).trim();
		await git(["update-ref", "refs/remotes/origin/xsec", onXsec]);
		await git(["checkout", "-q", "-b", "feature"]);
		await commit("not on xsec");
		const offXsec = (await git(["rev-parse", "HEAD"])).trim();
		return { repo, onXsec, offXsec };
	}

	/** Answers every runs query with a green push run for the commit it asks about. */
	function serveGreenRuns() {
		return Bun.serve({
			port: 0,
			fetch(request) {
				const headSha = new URL(request.url).searchParams.get("head_sha") ?? "";
				return Response.json({ total_count: 1, workflow_runs: [run({ head_sha: headSha })] });
			},
		});
	}

	test("allows a commit that xsec contains when its push run succeeded", async () => {
		const { repo, onXsec } = await cloneWithCommits();
		const server = serveGreenRuns();
		try {
			const decision = await checkReleaseCommit({
				commit: onXsec,
				cwd: repo,
				apiUrl: server.url.origin,
				repository: "xsec-labs/oh-my-pi",
				token: "test-token",
			});
			expect(decision.ok).toBe(true);
		} finally {
			server.stop(true);
			await fs.rm(repo, { recursive: true, force: true });
		}
	});

	test("refuses a green commit that xsec does not contain", async () => {
		const { repo, offXsec } = await cloneWithCommits();
		const server = serveGreenRuns();
		try {
			const decision = await checkReleaseCommit({
				commit: offXsec,
				cwd: repo,
				apiUrl: server.url.origin,
				repository: "xsec-labs/oh-my-pi",
				token: "test-token",
			});
			expect(decision.ok).toBe(false);
			expect(decision.reason).toContain("not reachable from origin/xsec");
		} finally {
			server.stop(true);
			await fs.rm(repo, { recursive: true, force: true });
		}
	});
});
