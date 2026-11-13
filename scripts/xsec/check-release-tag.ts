#!/usr/bin/env bun
/**
 * Decides whether a release tag may publish: the tagged commit must be on `xsec`,
 * and the newest `xsec CI` push run on that commit must have finished with
 * success. xsec-release.yml's tag_guard job runs this before publish, and a
 * manual run runs it on the commit it started on.
 *
 * Usage (GitHub Actions): bun scripts/xsec/check-release-tag.ts <commit>
 * Needs GITHUB_TOKEN with `actions: read`, GITHUB_REPOSITORY, and origin/xsec
 * fetched. GITHUB_API_URL defaults to https://api.github.com.
 */
import { isAncestor, resolveCommit } from "./sync-git";

const XSEC_BRANCH = "xsec";
const XSEC_CI_NAME = "xsec CI";
const XSEC_CI_PATH = ".github/workflows/xsec-ci.yml";

/** The fields of a workflow run this check reads, as GET /repos/{owner}/{repo}/actions/runs returns them. */
export interface WorkflowRun {
	id: number;
	path: string;
	event: string;
	head_branch: string | null;
	head_sha: string;
	status: string | null;
	conclusion: string | null;
	created_at: string;
}

export interface ReleaseFacts {
	/** The full SHA of the tagged commit. */
	sha: string;
	/** Whether that commit is reachable from origin/xsec. */
	reachableFromXsec: boolean;
	/** The repository's runs for that commit, as listXsecCiRuns returns them. */
	runs: readonly WorkflowRun[];
}

export interface ReleaseDecision {
	ok: boolean;
	reason: string;
}

function compareRuns(a: WorkflowRun, b: WorkflowRun): number {
	return Date.parse(a.created_at) - Date.parse(b.created_at) || a.id - b.id;
}

/**
 * Whether a tag may publish. The newest `xsec CI` push run on the commit decides:
 * an older failure does not block a commit whose newest run succeeded, and a
 * newer failure blocks a commit whose earlier run succeeded.
 */
export function decideRelease(facts: ReleaseFacts): ReleaseDecision {
	if (!facts.reachableFromXsec) {
		return { ok: false, reason: `${facts.sha} is not reachable from origin/${XSEC_BRANCH}` };
	}
	const matching = facts.runs.filter(
		run =>
			run.path === XSEC_CI_PATH &&
			run.event === "push" &&
			run.head_branch === XSEC_BRANCH &&
			run.head_sha === facts.sha,
	);
	if (matching.length === 0) {
		return { ok: false, reason: `no ${XSEC_CI_NAME} push run on ${XSEC_BRANCH} for ${facts.sha}` };
	}
	const newest = matching.reduce((latest, run) => (compareRuns(run, latest) > 0 ? run : latest));
	if (newest.status !== "completed") {
		return { ok: false, reason: `${XSEC_CI_NAME} run ${newest.id} is ${newest.status}; wait for it to finish` };
	}
	if (newest.conclusion !== "success") {
		return { ok: false, reason: `${XSEC_CI_NAME} run ${newest.id} concluded ${newest.conclusion}` };
	}
	return { ok: true, reason: `${XSEC_CI_NAME} run ${newest.id} succeeded on ${facts.sha}` };
}

/** The repository's push runs of xsec-ci.yml for a commit on xsec, newest first. */
export async function listXsecCiRuns(options: {
	apiUrl: string;
	repository: string;
	token: string;
	sha: string;
}): Promise<WorkflowRun[]> {
	const url = new URL(`${options.apiUrl}/repos/${options.repository}/actions/runs`);
	url.searchParams.set("head_sha", options.sha);
	url.searchParams.set("branch", XSEC_BRANCH);
	url.searchParams.set("event", "push");
	url.searchParams.set("per_page", "100");
	const response = await fetch(url, {
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${options.token}`,
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});
	if (!response.ok) {
		throw new Error(
			`Listing workflow runs failed: HTTP ${response.status} ${await response.text()}. The job needs actions: read.`,
		);
	}
	const body = (await response.json()) as { workflow_runs: WorkflowRun[] };
	return body.workflow_runs;
}

function requireEnv(name: string): string {
	const value = Bun.env[name];
	if (!value) throw new Error(`${name} is not set`);
	return value;
}

export interface ReleaseCheck {
	/** The commit a tag names, or any ref that resolves to one. */
	commit: string;
	/** The clone to check in. The repository root by default. */
	cwd?: string;
	apiUrl: string;
	repository: string;
	token: string;
}

/**
 * Checks one commit: it must be reachable from origin/xsec, and the newest xsec CI
 * push run on it must have succeeded. A commit xsec does not contain is refused
 * without listing its runs.
 */
export async function checkReleaseCommit(check: ReleaseCheck): Promise<ReleaseDecision> {
	const sha = await resolveCommit(check.commit, check.cwd);
	if (!sha) throw new Error(`${check.commit} is not a commit of this clone`);
	const xsecTip = await resolveCommit(`origin/${XSEC_BRANCH}`, check.cwd);
	if (!xsecTip) throw new Error(`origin/${XSEC_BRANCH} is not fetched`);
	const reachableFromXsec = await isAncestor(sha, xsecTip, check.cwd);
	const runs = reachableFromXsec
		? await listXsecCiRuns({ apiUrl: check.apiUrl, repository: check.repository, token: check.token, sha })
		: [];
	return decideRelease({ sha, reachableFromXsec, runs });
}

async function main(): Promise<void> {
	const commit = Bun.argv[2];
	if (!commit) throw new Error("Usage: bun scripts/xsec/check-release-tag.ts <commit>");
	const decision = await checkReleaseCommit({
		commit,
		apiUrl: Bun.env.GITHUB_API_URL || "https://api.github.com",
		repository: requireEnv("GITHUB_REPOSITORY"),
		token: requireEnv("GITHUB_TOKEN"),
	});
	if (!decision.ok) {
		console.error(`::error title=Release refused::${decision.reason}`);
		process.exit(1);
	}
	console.log(decision.reason);
}

if (import.meta.main) await main();
