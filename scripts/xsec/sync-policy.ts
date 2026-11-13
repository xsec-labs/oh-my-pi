/**
 * Decisions of the sync workflow that need no I/O: which upstream release the
 * fork takes next, and whether an open sync pull request may merge itself.
 * `sync.ts` gathers the facts from git and the GitHub API and acts on what these
 * functions return.
 */
import { isOwnedPath, type NameStatusEntry } from "./check-upstream-diff";

/** Head branch of every sync pull request, followed by the upstream version. */
export const SYNC_BRANCH_PREFIX = "sync/v";

/** The branch sync pull requests merge into. */
export const SYNC_BASE_BRANCH = "xsec";

/** Check conclusions that count as green. A check that was skipped does not block. */
const GREEN_CONCLUSIONS: ReadonlySet<string> = new Set(["success", "skipped"]);

/** Upstream's workflow files live here. */
const WORKFLOW_DIR = ".github/workflows/";

/**
 * Statuses that leave an upstream workflow file harmless: an edit keeps the file's
 * disabled state, and a deletion removes it. Any other status stays for review.
 */
const HARMLESS_WORKFLOW_STATUSES: ReadonlySet<string> = new Set(["M", "D"]);

const PLAIN_VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const RELEASE_TAG = /^v(\d+\.\d+\.\d+)$/;

export interface Version {
	major: number;
	minor: number;
	patch: number;
}

/** Parses a plain `x.y.z` version. Anything else throws, so a malformed version fails the run. */
export function parseVersion(text: string): Version {
	const match = PLAIN_VERSION.exec(text);
	if (!match) throw new Error(`not a plain x.y.z version: ${JSON.stringify(text)}`);
	return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

/** Numeric order, so 18.10.0 is newer than 18.9.0. */
export function compareVersions(a: Version, b: Version): number {
	return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

export interface ReleaseTag {
	/** The tag name, `v<x.y.z>`. */
	tag: string;
	/** The version without the leading `v`. */
	version: string;
}

/**
 * The newest upstream release tag newer than `baseVersion`, or null when there is
 * none. Only plain `v<x.y.z>` tags are releases: pre-release tags and fork tags
 * (`v<x.y.z>-xsec.<n>`) do not match. Tags at or below the base are ignored.
 */
export function pickNewerRelease(baseVersion: string, tagNames: readonly string[]): ReleaseTag | null {
	const base = parseVersion(baseVersion);
	let best: { release: ReleaseTag; version: Version } | null = null;
	for (const tag of tagNames) {
		const match = RELEASE_TAG.exec(tag);
		if (!match) continue;
		const version = parseVersion(match[1]);
		if (compareVersions(version, base) <= 0) continue;
		if (!best || compareVersions(version, best.version) > 0) {
			best = { release: { tag, version: match[1] }, version };
		}
	}
	return best?.release ?? null;
}

/** The head branch a sync pull request uses for an upstream version. */
export function syncBranchFor(version: string): string {
	return `${SYNC_BRANCH_PREFIX}${version}`;
}

/** The upstream version a sync branch carries, or null for any other branch name. */
export function versionOfSyncBranch(branch: string): string | null {
	if (!branch.startsWith(SYNC_BRANCH_PREFIX)) return null;
	const version = branch.slice(SYNC_BRANCH_PREFIX.length);
	return PLAIN_VERSION.test(version) ? version : null;
}

export type SyncPlan =
	/** No newer upstream release, and no sync pull request is open. */
	| { kind: "idle" }
	/** Open a sync pull request for this release. */
	| { kind: "open"; release: ReleaseTag }
	/**
	 * A sync pull request is open: keep it current and evaluate it. A newer release
	 * waits (`waitingFor`) until that pull request merges.
	 */
	| { kind: "keep"; version: string; waitingFor: ReleaseTag | null };

/**
 * At most one sync pull request is open at a time. While one is open its release
 * is kept current; the next release is taken only after it merges.
 */
export function planSync(input: {
	baseVersion: string;
	tagNames: readonly string[];
	openSyncVersion: string | null;
}): SyncPlan {
	const next = pickNewerRelease(input.baseVersion, input.tagNames);
	if (input.openSyncVersion !== null) {
		const waitingFor = next && next.version !== input.openSyncVersion ? next : null;
		return { kind: "keep", version: input.openSyncVersion, waitingFor };
	}
	return next ? { kind: "open", release: next } : { kind: "idle" };
}

/** A check run, as the checks API reports it. */
export interface CheckRunFact {
	name: string;
	/** `queued`, `in_progress` or `completed`. */
	status: string;
	/** Set once completed: `success`, `failure`, `skipped`, `cancelled`, ... */
	conclusion: string | null;
}

/** The pull request, as the GitHub API reports it. */
export interface SyncPullFacts {
	open: boolean;
	draft: boolean;
	baseRef: string;
	headRef: string;
	/** The head branch is not a branch of this repository. */
	headFromFork: boolean;
	/** GitHub's mergeability; null while GitHub is still computing it. */
	mergeable: boolean | null;
}

/** The pull request head, as git sees it. */
export interface SyncHeadFacts {
	/** Parents of the head commit, in order. */
	parents: readonly string[];
	/**
	 * Commits reachable from the head but from neither its first parent nor the
	 * upstream tag, not counting the head itself: the fork's own commits.
	 */
	extraCommits: readonly string[];
	/** The head's tree is exactly the tree git's automatic merge of its two parents gives. */
	treeIsAutomaticMerge: boolean;
	/** Files the head changes relative to its first parent, with git's status letter for each. */
	changedPaths: readonly NameStatusEntry[];
}

export interface AutoMergeFacts {
	pull: SyncPullFacts;
	/** The current head of xsec. */
	baseSha: string;
	/** The upstream release commit the head must merge. */
	tagSha: string;
	head: SyncHeadFacts;
	/** A fresh merge of the current xsec head and the release conflicts. */
	freshMergeConflicts: boolean;
	checkRuns: readonly CheckRunFact[];
	/** Combined commit status state, or null when no status was reported. */
	statusState: string | null;
}

export interface AutoMergeDecision {
	merge: boolean;
	/** Why the pull request stays open for review; empty when it merges. */
	reasons: string[];
}

/**
 * Whether the head is exactly the merge the workflow makes of `tagSha` onto its
 * first parent: two parents with the tag second, no commit of the fork's own,
 * and no edit to the merged tree. The workflow only rewrites a sync branch that
 * passes this, so anything a person added to the branch is left alone.
 */
export function isPristineUpstreamMerge(head: SyncHeadFacts, tagSha: string): boolean {
	return (
		head.parents.length === 2 &&
		head.parents[1] === tagSha &&
		head.extraCommits.length === 0 &&
		head.treeIsAutomaticMerge
	);
}

/**
 * Whether a clean sync pull request merges itself, without a T-37 review. Every
 * condition must hold; each one that fails adds a reason. Anything that is not
 * a plain upstream merge, or any check that is not green, stays open.
 */
export function decideAutoMerge(facts: AutoMergeFacts): AutoMergeDecision {
	const { pull, head } = facts;
	const reasons: string[] = [];
	if (!pull.open) reasons.push("the pull request is not open");
	if (pull.draft) reasons.push("the pull request is a draft");
	if (pull.baseRef !== SYNC_BASE_BRANCH) reasons.push(`it targets ${pull.baseRef}, not ${SYNC_BASE_BRANCH}`);
	if (versionOfSyncBranch(pull.headRef) === null) reasons.push(`its head ${pull.headRef} is not a sync branch`);
	if (pull.headFromFork) reasons.push("its head is not a branch of this repository");
	if (pull.mergeable === null) reasons.push("GitHub has not yet computed whether it merges cleanly");
	else if (!pull.mergeable) reasons.push("GitHub reports that it does not merge cleanly");
	if (facts.freshMergeConflicts) reasons.push("merging the release into xsec conflicts");
	if (!sameList(head.parents, [facts.baseSha, facts.tagSha])) {
		reasons.push("its head is not the merge of the current xsec head with the release");
	}
	if (head.extraCommits.length > 0) {
		reasons.push(`it carries commits beyond the merge: ${head.extraCommits.map(shortSha).join(", ")}`);
	}
	if (!head.treeIsAutomaticMerge) reasons.push("its tree differs from git's automatic merge");
	for (const change of head.changedPaths) {
		// scripts/xsec/upstream-allowlist.txt sits under the owned prefix, so this covers it too.
		const reason = isOwnedPath(change.path) ? `it changes fork-owned file ${change.path}` : workflowReason(change);
		if (reason) reasons.push(reason);
	}
	reasons.push(...checkReasons(facts.checkRuns, facts.statusState));
	return { merge: reasons.length === 0, reasons };
}

/**
 * Why an upstream workflow file change keeps the pull request open, or null when it
 * does not. A file that is added becomes a new workflow in the fork, and so does one
 * whose status is anything but an edit or a deletion; those stay for review.
 */
function workflowReason(change: NameStatusEntry): string | null {
	if (!change.path.startsWith(WORKFLOW_DIR) || HARMLESS_WORKFLOW_STATUSES.has(change.status)) return null;
	return change.status === "A"
		? `it adds workflow file ${change.path}`
		: `it changes workflow file ${change.path} (status ${change.status})`;
}

function checkReasons(runs: readonly CheckRunFact[], statusState: string | null): string[] {
	const reasons: string[] = [];
	if (runs.length === 0) reasons.push("no check has reported on the head yet");
	for (const run of runs) {
		if (run.status !== "completed") reasons.push(`check ${run.name} is ${run.status}`);
		else if (!GREEN_CONCLUSIONS.has(run.conclusion ?? "")) {
			reasons.push(`check ${run.name} concluded ${run.conclusion ?? "without a conclusion"}`);
		}
	}
	if (statusState === "pending" || statusState === "failure" || statusState === "error") {
		reasons.push(`the commit status is ${statusState}`);
	}
	return reasons;
}

function sameList(actual: readonly string[], expected: readonly string[]): boolean {
	return actual.length === expected.length && actual.every((sha, index) => sha === expected[index]);
}

function shortSha(sha: string): string {
	return sha.slice(0, 10);
}
