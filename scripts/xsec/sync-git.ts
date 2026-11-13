/**
 * The git side of the sync workflow: merging an upstream release into xsec, and
 * inspecting the head of a sync branch. Nothing here touches a working tree. A
 * merge is written as a commit object, and the caller decides whether to push it.
 */
import { $ } from "bun";
import { parseNameStatus } from "./check-upstream-diff";
import { repoRoot } from "./upstream";
import type { SyncHeadFacts } from "./sync-policy";

/** The commits the workflow makes carry the standard GitHub Actions bot identity. */
const BOT_IDENTITY: Record<string, string> = {
	GIT_AUTHOR_NAME: "github-actions[bot]",
	GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
	GIT_COMMITTER_NAME: "github-actions[bot]",
	GIT_COMMITTER_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
};

export interface GitOptions {
	/** The clone to run in; the repository root by default. */
	cwd?: string;
	/** Environment for this command only, on top of the process environment. */
	env?: Record<string, string>;
}

export interface GitResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export async function git(args: readonly string[], options: GitOptions = {}): Promise<GitResult> {
	const result = await $`git ${args}`
		.cwd(options.cwd ?? repoRoot)
		.env({ ...Bun.env, ...options.env })
		.quiet()
		.nothrow();
	return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

/** Runs git and returns its stdout. A failing command throws with git's own message. */
export async function gitText(args: readonly string[], options: GitOptions = {}): Promise<string> {
	const result = await git(args, options);
	if (result.exitCode !== 0) {
		throw new Error(`git ${args[0]} failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
	}
	return result.stdout;
}

/** The commit a ref names, or null when there is no such commit. */
export async function resolveCommit(ref: string, cwd?: string): Promise<string | null> {
	const result = await git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd });
	return result.exitCode === 0 ? result.stdout.trim() : null;
}

/** The parents of a commit, in order. */
export async function parentsOf(sha: string, cwd?: string): Promise<string[]> {
	const line = (await gitText(["rev-list", "--parents", "-n", "1", sha], { cwd })).trim();
	return line.split(" ").slice(1);
}

export async function isAncestor(ancestor: string, descendant: string, cwd?: string): Promise<boolean> {
	return (await git(["merge-base", "--is-ancestor", ancestor, descendant], { cwd })).exitCode === 0;
}

export async function showFileAt(ref: string, filePath: string, cwd?: string): Promise<string> {
	return gitText(["show", `${ref}:${filePath}`], { cwd });
}

export type TreeMerge = { clean: true; tree: string } | { clean: false; conflicts: string[] };

/**
 * git's automatic merge of two commits, as a tree. A merge that needs a human
 * returns the paths it cannot resolve.
 */
export async function mergeTrees(ours: string, theirs: string, cwd?: string): Promise<TreeMerge> {
	const result = await git(["merge-tree", "--write-tree", "--name-only", ours, theirs], { cwd });
	const lines = result.stdout.split("\n");
	if (result.exitCode === 0) return { clean: true, tree: lines[0].trim() };
	if (result.exitCode !== 1)
		throw new Error(`git merge-tree failed (exit ${result.exitCode}): ${result.stderr.trim()}`);
	// Output: the tree, one conflicted path per line, a blank line, then messages.
	const conflicts: string[] = [];
	for (const line of lines.slice(1)) {
		if (line === "") break;
		conflicts.push(line);
	}
	return { clean: false, conflicts };
}

export interface ConflictReport {
	path: string;
	/** Upstream commits since the merge base that touched the file, newest first. */
	upstreamCommits: string[];
}

export type UpstreamMerge = { clean: true; sha: string } | { clean: false; conflicts: ConflictReport[] };

/**
 * Merges an upstream release into `base` with a merge commit whose parents are
 * `base` (first) and `tag`. A conflict makes no commit and lists each conflicted
 * file with the upstream commits that touched it.
 */
export async function mergeUpstreamRelease(
	base: string,
	tag: string,
	message: string,
	cwd?: string,
): Promise<UpstreamMerge> {
	const merged = await mergeTrees(base, tag, cwd);
	if (merged.clean) {
		const sha = await gitText(["commit-tree", merged.tree, "-p", base, "-p", tag, "-m", message], {
			cwd,
			env: BOT_IDENTITY,
		});
		return { clean: true, sha: sha.trim() };
	}
	const mergeBase = (await gitText(["merge-base", base, tag], { cwd })).trim().split("\n")[0];
	const conflicts: ConflictReport[] = [];
	for (const path of merged.conflicts) {
		const log = await gitText(["log", "--format=%h %s", "--max-count=20", `${mergeBase}..${tag}`, "--", path], {
			cwd,
		});
		conflicts.push({ path, upstreamCommits: log.split("\n").filter(line => line !== "") });
	}
	return { clean: false, conflicts };
}

/**
 * Facts about the head of a sync branch, for the policy. `base` is the xsec head
 * the pull request is judged against, and `tag` the upstream release it merges.
 */
export async function inspectSyncHead(head: string, base: string, tag: string, cwd?: string): Promise<SyncHeadFacts> {
	const parents = await parentsOf(head, cwd);
	const beyond = (await gitText(["rev-list", head, "--not", base, tag], { cwd }))
		.split("\n")
		.filter(sha => sha !== "" && sha !== head);
	let treeIsAutomaticMerge = false;
	if (parents.length === 2) {
		const merged = await mergeTrees(parents[0], parents[1], cwd);
		const headTree = (await gitText(["rev-parse", `${head}^{tree}`], { cwd })).trim();
		treeIsAutomaticMerge = merged.clean && merged.tree === headTree;
	}
	const changed = await gitText(["diff", "--name-status", "--no-renames", "-z", `${base}...${head}`], { cwd });
	return {
		parents,
		extraCommits: beyond,
		treeIsAutomaticMerge,
		changedPaths: parseNameStatus(changed),
	};
}
