#!/usr/bin/env bun
/**
 * Keeps the fork in step with upstream. `.github/workflows/xsec-sync.yml` runs it
 * on a schedule and by hand; "Sync with upstream" in scripts/xsec/README.md
 * describes the whole flow. In order, it:
 *
 * 1. fast-forwards the fork's `main` to upstream's `main`;
 * 2. plans from the version on `xsec` and upstream's release tags (sync-policy.ts),
 *    with at most one open `sync/v<version>` pull request into `xsec`;
 * 3. opens that pull request with a merge commit of the release (sync-git.ts), or
 *    rebuilds it when xsec has moved on;
 * 4. merges the pull request itself once decideAutoMerge allows it.
 *
 * Environment: OMP_SYNC_TOKEN (required: every write, to git and to the API),
 * GITHUB_READ_TOKEN (required: every read; the workflow passes its own token),
 * GITHUB_REPOSITORY (required), GITHUB_API_URL, GITHUB_STEP_SUMMARY, and
 * DRY_RUN=1 to plan and report without pushing, opening or merging anything.
 * XSEC_SYNC_UPSTREAM overrides the upstream URL, for tests against a local mirror.
 */
import * as fs from "node:fs/promises";
import { UPSTREAM_REPO_URL } from "./upstream";
import {
	type ConflictReport,
	gitText,
	inspectSyncHead,
	isAncestor,
	mergeTrees,
	mergeUpstreamRelease,
	resolveCommit,
	showFileAt,
} from "./sync-git";
import {
	type AutoMergeFacts,
	type CheckRunFact,
	decideAutoMerge,
	isPristineUpstreamMerge,
	parseVersion,
	planSync,
	type ReleaseTag,
	SYNC_BASE_BRANCH,
	type SyncHeadFacts,
	syncBranchFor,
	versionOfSyncBranch,
} from "./sync-policy";

/** A failure that stops the run. Its message goes to the log and the step summary. */
class SyncError extends Error {}

const PACKAGE_MANIFEST = "packages/coding-agent/package.json";
const UPSTREAM_TAG_PREFIX = "refs/upstream-tags/";
const UPSTREAM_MAIN_REF = "refs/remotes/upstream/main";
const FORK_XSEC_REF = "refs/remotes/origin/xsec";
const FORK_MAIN_REF = "refs/remotes/origin/main";

/** Lines for the run's step summary, in order. */
const summary: string[] = [];

function report(line: string): void {
	console.log(line);
	summary.push(line);
}

function short(sha: string): string {
	return sha.slice(0, 7);
}

function requireEnv(name: string): string {
	const value = Bun.env[name];
	if (!value) throw new SyncError(`${name} is not set`);
	return value;
}

/**
 * Git configuration that authenticates to the fork for one command. The token
 * reaches git through the environment, so it is never written into `.git/config`
 * and never sent to upstream.
 */
function originEnv(token: string): Record<string, string> {
	return {
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
		GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${btoa(`x-access-token:${token}`)}`,
	};
}

interface PullSummary {
	number: number;
	state: string;
	draft: boolean;
	merged_at: string | null;
	html_url: string;
	head: { ref: string; sha: string; repo: { full_name: string } | null };
	base: { ref: string };
}

interface PullDetail extends PullSummary {
	mergeable: boolean | null;
}

interface CheckRunSummary {
	name: string;
	status: string;
	conclusion: string | null;
}

interface CombinedStatus {
	state: string;
	total_count: number;
}

class GitHubApi {
	readonly #apiUrl: string;
	readonly #readToken: string;
	readonly #writeToken: string;

	/**
	 * Reads (GET) use the read token, which is the workflow's own token. Every other request
	 * uses the write token, because a push or pull request made with the workflow's token
	 * does not start CI.
	 */
	constructor(apiUrl: string, readToken: string, writeToken: string) {
		this.#apiUrl = apiUrl.replace(/\/+$/, "");
		this.#readToken = readToken;
		this.#writeToken = writeToken;
	}

	async request<T>(
		method: "GET" | "POST" | "PUT",
		route: string,
		options: { query?: Record<string, string>; body?: unknown } = {},
	): Promise<T> {
		const url = new URL(`${this.#apiUrl}${route}`);
		for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
		const token = method === "GET" ? this.#readToken : this.#writeToken;
		const headers: Record<string, string> = {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${token}`,
			"X-GitHub-Api-Version": "2022-11-28",
		};
		const init: RequestInit = { method, headers };
		if (options.body !== undefined) {
			headers["Content-Type"] = "application/json";
			init.body = JSON.stringify(options.body);
		}
		const response = await fetch(url, init);
		if (!response.ok) {
			const detail = (await response.text()).slice(0, 300);
			throw new SyncError(`GitHub ${method} ${route} failed: HTTP ${response.status} ${detail}`);
		}
		return (await response.json()) as T;
	}

	/** Every page of a list endpoint. `field` names the array when the response is an object. */
	async pages<T>(route: string, query: Record<string, string> = {}, field?: string): Promise<T[]> {
		const items: T[] = [];
		for (let page = 1; ; page++) {
			const body = await this.request<unknown>("GET", route, {
				query: { ...query, per_page: "100", page: String(page) },
			});
			const batch = (field === undefined ? body : (body as Record<string, unknown>)[field]) as T[];
			items.push(...batch);
			if (batch.length < 100) return items;
		}
	}
}

interface RunContext {
	api: GitHubApi;
	repository: string;
	/** The owner part of `repository`, for the `head` filter of pull request lists. */
	owner: string;
	dryRun: boolean;
	readEnv: Record<string, string>;
	writeEnv: Record<string, string>;
	/** The current head of xsec. */
	xsecSha: string;
}

async function requireCommit(ref: string): Promise<string> {
	const sha = await resolveCommit(ref);
	if (sha === null) throw new SyncError(`${ref} does not exist`);
	return sha;
}

async function fetchUpstream(): Promise<void> {
	const upstream = Bun.env.XSEC_SYNC_UPSTREAM || UPSTREAM_REPO_URL;
	await gitText(["fetch", "--quiet", "--no-tags", upstream, `+refs/heads/main:${UPSTREAM_MAIN_REF}`]);
	await gitText(["fetch", "--quiet", "--no-tags", upstream, `+refs/tags/*:${UPSTREAM_TAG_PREFIX}*`]);
}

async function fastForwardMain(ctx: RunContext): Promise<void> {
	const upstreamMain = await requireCommit(UPSTREAM_MAIN_REF);
	const forkMain = await resolveCommit(FORK_MAIN_REF);
	if (forkMain === upstreamMain) {
		report(`main is at upstream main ${short(upstreamMain)}.`);
		return;
	}
	if (forkMain !== null && !(await isAncestor(forkMain, upstreamMain))) {
		throw new SyncError(
			`main (${short(forkMain)}) has commits that upstream main (${short(upstreamMain)}) does not have, so it cannot be fast-forwarded. Look at the fork's main by hand.`,
		);
	}
	report(`Fast-forward main ${forkMain === null ? "(missing)" : short(forkMain)} to ${short(upstreamMain)}.`);
	if (!ctx.dryRun) {
		await gitText(["push", "--quiet", "origin", `${upstreamMain}:refs/heads/main`], { env: ctx.writeEnv });
	}
}

async function readVersionAt(sha: string): Promise<string> {
	const manifest = JSON.parse(await showFileAt(sha, PACKAGE_MANIFEST)) as { version?: unknown };
	if (typeof manifest.version !== "string") throw new SyncError(`${PACKAGE_MANIFEST} has no version at ${short(sha)}`);
	parseVersion(manifest.version);
	return manifest.version;
}

async function listUpstreamTags(): Promise<string[]> {
	const refs = (await gitText(["for-each-ref", "--format=%(refname)", UPSTREAM_TAG_PREFIX]))
		.split("\n")
		.filter(line => line !== "");
	return refs.map(ref => ref.slice(UPSTREAM_TAG_PREFIX.length));
}

async function listOpenSyncPulls(ctx: RunContext): Promise<PullSummary[]> {
	const pulls = await ctx.api.pages<PullSummary>(`/repos/${ctx.repository}/pulls`, {
		state: "open",
		base: SYNC_BASE_BRANCH,
	});
	return pulls.filter(
		pull => versionOfSyncBranch(pull.head.ref) !== null && pull.head.repo?.full_name === ctx.repository,
	);
}

/** The sha a sync branch points to on the fork, or null when it does not exist. */
async function remoteBranchSha(ctx: RunContext, branch: string): Promise<string | null> {
	const out = await gitText(["ls-remote", "--heads", "origin", `refs/heads/${branch}`], { env: ctx.readEnv });
	const [line] = out.split("\n").filter(text => text !== "");
	return line === undefined ? null : (line.split("\t")[0] ?? null);
}

async function pushBranch(ctx: RunContext, branch: string, sha: string, expected: string | null): Promise<void> {
	// A lease on the sha we inspected: a push that lands in between makes this fail, not overwrite.
	const lease = expected === null ? [] : [`--force-with-lease=refs/heads/${branch}:${expected}`];
	await gitText(["push", "--quiet", ...lease, "origin", `${sha}:refs/heads/${branch}`], { env: ctx.writeEnv });
}

function mergeMessage(tag: string, tagSha: string): string {
	return `Merge upstream ${tag} into xsec\n\nUpstream release ${tag} (${tagSha}), merged by the xsec sync workflow.`;
}

function pullBody(tag: string, tagSha: string, xsecSha: string): string {
	return [
		`Merges upstream release ${tag} (\`${short(tagSha)}\`) into \`xsec\` (\`${short(xsecSha)}\`) with one merge commit. Opened by the xsec sync workflow.`,
		"",
		'A scheduled run merges this pull request itself once it holds only that merge and every check is green. Otherwise it stays open for review. See "Sync with upstream" in `scripts/xsec/README.md`.',
	].join("\n");
}

/** Reports each conflicted file with the upstream commits that touched it, and stops the run. */
function conflictError(tag: string, conflicts: ConflictReport[]): SyncError {
	report(`Merging ${tag} into xsec conflicts in ${conflicts.length} file(s):`);
	for (const conflict of conflicts) {
		report(`- \`${conflict.path}\`, upstream commits since the merge base that touched it:`);
		for (const commit of conflict.upstreamCommits) report(`  - ${commit}`);
	}
	return new SyncError(
		`Merging ${tag} into xsec conflicts. Adapt the fork's change on xsec so the release merges cleanly, then run this workflow again.`,
	);
}

async function openSyncPull(ctx: RunContext, release: ReleaseTag): Promise<void> {
	const branch = syncBranchFor(release.version);
	const tagSha = await requireCommit(`${UPSTREAM_TAG_PREFIX}${release.tag}`);
	const remoteSha = await remoteBranchSha(ctx, branch);
	let expected: string | null = null;
	let mergedSha: string | null = null;
	if (remoteSha !== null) {
		// A branch left behind by an earlier run. Its pull request is either still wanted (a
		// failed run) or was closed on purpose, which this run respects.
		const closed = await ctx.api.pages<PullSummary>(`/repos/${ctx.repository}/pulls`, {
			state: "closed",
			head: `${ctx.owner}:${branch}`,
		});
		if (closed.length > 0) {
			report(
				`${branch} already has a closed pull request (#${closed[0].number}). This run does not reopen it; delete the branch to let a later run open a new one.`,
			);
			return;
		}
		const inspection = await inspectSyncHead(remoteSha, ctx.xsecSha, tagSha);
		if (!isPristineUpstreamMerge(inspection, tagSha)) {
			throw new SyncError(
				`${branch} holds commits that are not the workflow's merge of ${release.tag}. Resolve it by hand or delete the branch.`,
			);
		}
		expected = remoteSha;
		if (inspection.parents[0] === ctx.xsecSha) mergedSha = remoteSha;
	}
	const merged =
		mergedSha === null
			? await mergeUpstreamRelease(ctx.xsecSha, tagSha, mergeMessage(release.tag, tagSha))
			: { clean: true as const, sha: mergedSha };
	if (!merged.clean) throw conflictError(release.tag, merged.conflicts);
	report(`Merge ${release.tag} into xsec ${short(ctx.xsecSha)} as ${short(merged.sha)} on ${branch}.`);
	if (ctx.dryRun) return;
	if (merged.sha !== remoteSha) await pushBranch(ctx, branch, merged.sha, expected);
	const pull = await ctx.api.request<PullDetail>("POST", `/repos/${ctx.repository}/pulls`, {
		body: {
			title: `Sync upstream ${release.tag} into xsec`,
			head: branch,
			base: SYNC_BASE_BRANCH,
			body: pullBody(release.tag, tagSha, ctx.xsecSha),
			draft: false,
		},
	});
	report(
		`Opened [#${pull.number}](${pull.html_url}). Its checks run now; a scheduled run merges it once they are green and the policy holds.`,
	);
}

async function listCheckRuns(ctx: RunContext, sha: string): Promise<CheckRunSummary[]> {
	return ctx.api.pages<CheckRunSummary>(`/repos/${ctx.repository}/commits/${sha}/check-runs`, {}, "check_runs");
}

async function collectFacts(
	ctx: RunContext,
	detail: PullDetail,
	inspection: SyncHeadFacts,
	tagSha: string,
): Promise<AutoMergeFacts> {
	const runs = await listCheckRuns(ctx, detail.head.sha);
	const status = await ctx.api.request<CombinedStatus>(
		"GET",
		`/repos/${ctx.repository}/commits/${detail.head.sha}/status`,
	);
	const freshMerge = await mergeTrees(ctx.xsecSha, tagSha);
	const checkRuns: CheckRunFact[] = runs.map(run => ({
		name: run.name,
		status: run.status,
		conclusion: run.conclusion,
	}));
	return {
		pull: {
			open: detail.state === "open" && detail.merged_at === null,
			draft: detail.draft,
			baseRef: detail.base.ref,
			headRef: detail.head.ref,
			headFromFork: detail.head.repo?.full_name !== ctx.repository,
			mergeable: detail.mergeable,
		},
		baseSha: ctx.xsecSha,
		tagSha,
		head: inspection,
		freshMergeConflicts: !freshMerge.clean,
		checkRuns,
		// GitHub reports `pending` for a commit with no status at all; only a reported status counts.
		statusState: status.total_count === 0 ? null : status.state,
	};
}

async function keepSyncPull(ctx: RunContext, listed: PullSummary): Promise<void> {
	const branch = listed.head.ref;
	const version = versionOfSyncBranch(branch);
	if (version === null) throw new SyncError(`${branch} is not a sync branch`);
	const tagSha = await requireCommit(`${UPSTREAM_TAG_PREFIX}v${version}`);
	const detail = await ctx.api.request<PullDetail>("GET", `/repos/${ctx.repository}/pulls/${listed.number}`);
	const inspection = await inspectSyncHead(detail.head.sha, ctx.xsecSha, tagSha);
	if (inspection.parents[0] !== ctx.xsecSha) {
		// xsec moved on: rebuild the workflow's own merge so the checks run on the merged result.
		if (!isPristineUpstreamMerge(inspection, tagSha)) {
			report(`#${detail.number} is behind xsec and holds more than the workflow's merge, so it is left for review.`);
			return;
		}
		const merged = await mergeUpstreamRelease(ctx.xsecSha, tagSha, mergeMessage(`v${version}`, tagSha));
		if (!merged.clean) throw conflictError(`v${version}`, merged.conflicts);
		report(
			`xsec moved to ${short(ctx.xsecSha)}: rebuilt ${branch} as ${short(merged.sha)}, so #${detail.number} runs its checks again.`,
		);
		if (!ctx.dryRun) await pushBranch(ctx, branch, merged.sha, detail.head.sha);
		return;
	}
	const decision = decideAutoMerge(await collectFacts(ctx, detail, inspection, tagSha));
	if (!decision.merge) {
		report(`#${detail.number} stays open: ${decision.reasons.join("; ")}.`);
		return;
	}
	report(`#${detail.number} merges: its head is the clean upstream merge and every check is green.`);
	if (ctx.dryRun) return;
	try {
		await ctx.api.request("PUT", `/repos/${ctx.repository}/pulls/${detail.number}/merge`, {
			body: { merge_method: "merge", sha: detail.head.sha },
		});
	} catch (error) {
		report(`GitHub refused the merge, so #${detail.number} stays open: ${errorText(error)}`);
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function writeSummary(): Promise<void> {
	const file = Bun.env.GITHUB_STEP_SUMMARY;
	if (!file || summary.length === 0) return;
	await fs.appendFile(file, `${summary.join("\n")}\n`);
}

async function main(): Promise<void> {
	const token = requireEnv("OMP_SYNC_TOKEN");
	const readToken = requireEnv("GITHUB_READ_TOKEN");
	const repository = requireEnv("GITHUB_REPOSITORY");
	const dryRun = Bun.env.DRY_RUN === "1";
	if (dryRun) report("Dry run: nothing is pushed, opened or merged.");

	const readEnv = originEnv(readToken);
	const writeEnv = originEnv(token);
	await fetchUpstream();
	// Fetch the sync branches so their commits are local before they are inspected.
	await gitText(["fetch", "--quiet", "--no-tags", "origin", "+refs/heads/sync/*:refs/remotes/origin/sync/*"], {
		env: readEnv,
	});
	const ctx: RunContext = {
		api: new GitHubApi(Bun.env.GITHUB_API_URL || "https://api.github.com", readToken, token),
		repository,
		owner: repository.split("/")[0] ?? repository,
		dryRun,
		readEnv,
		writeEnv,
		xsecSha: await requireCommit(FORK_XSEC_REF),
	};
	await fastForwardMain(ctx);

	const baseVersion = await readVersionAt(ctx.xsecSha);
	const openPulls = await listOpenSyncPulls(ctx);
	if (openPulls.length > 1) {
		throw new SyncError(
			`${openPulls.length} sync pull requests are open (${openPulls.map(pull => `#${pull.number}`).join(", ")}). Close all but one.`,
		);
	}
	const [openPull] = openPulls;
	const plan = planSync({
		baseVersion,
		tagNames: await listUpstreamTags(),
		openSyncVersion: openPull === undefined ? null : versionOfSyncBranch(openPull.head.ref),
	});
	switch (plan.kind) {
		case "idle":
			report(`xsec is at ${baseVersion}, the newest upstream release. Nothing to sync.`);
			return;
		case "open":
			await openSyncPull(ctx, plan.release);
			return;
		case "keep":
			if (plan.waitingFor !== null) {
				report(`${plan.waitingFor.tag} waits until the sync pull request for v${plan.version} merges.`);
			}
			if (openPull !== undefined) await keepSyncPull(ctx, openPull);
			return;
	}
}

if (import.meta.main) {
	try {
		await main();
	} catch (error) {
		const message = errorText(error);
		console.error(`::error title=xsec sync failed::${message.replace(/\s+/g, " ")}`);
		report(`**Sync failed:** ${message}`);
		await writeSummary();
		process.exit(1);
	}
	await writeSummary();
}
