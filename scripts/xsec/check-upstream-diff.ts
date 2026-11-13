#!/usr/bin/env bun
/**
 * Keeps the fork's footprint on upstream files small and visible.
 *
 * Everything the fork adds lives under the path prefixes in `OWNED_PREFIXES`,
 * which upstream does not use. An upstream file may be modified only when it is
 * listed in `upstream-allowlist.txt` with a line budget, so widening the
 * footprint is always an explicit, reviewable edit of that list. Some changes
 * are never allowed, listed or not: upstream CHANGELOG and workflow files, and
 * the version of any package.
 *
 * Usage: bun scripts/xsec/check-upstream-diff.ts
 * `XSEC_UPSTREAM_REF` names an already-fetched base commit; without it the
 * upstream tag `v<package version>` is fetched.
 */
import * as path from "node:path";
import { $ } from "bun";
import { readUpstreamVersion, repoRoot, UPSTREAM_REPO_URL } from "./upstream";

/** Path prefixes that belong to the fork. Upstream must not have files here. */
export const OWNED_PREFIXES: readonly string[] = [
	"scripts/xsec/",
	"packages/coding-agent/src/xsec/",
	"packages/coding-agent/test/xsec/",
	".github/workflows/xsec-",
];

export interface AllowlistEntry {
	path: string;
	/** Most lines (added plus removed) the fork may change in this file. */
	budget: number;
}

export interface FileChange {
	/** Git status letter: A, M, D or T. Renames are disabled, so no R or C. */
	status: string;
	path: string;
	/** Added plus removed lines; null for a binary file. */
	lines: number | null;
}

/** A changed `package.json` with its contents at the base and at HEAD. */
export interface ManifestEdit {
	path: string;
	before: string;
	after: string;
}

export function isOwnedPath(filePath: string): boolean {
	return OWNED_PREFIXES.some(prefix => filePath.startsWith(prefix));
}

/**
 * Upstream files the fork never changes, allowlisted or not: upstream rewrites
 * every CHANGELOG on release, and its workflows need upstream's runners.
 */
export function isForbiddenUpstreamPath(filePath: string): boolean {
	return path.posix.basename(filePath) === "CHANGELOG.md" || filePath.startsWith(".github/workflows/");
}

/** Parses `upstream-allowlist.txt`: one `<path> <budget>` per line, `#` comments. */
export function parseAllowlist(text: string): AllowlistEntry[] {
	const entries: AllowlistEntry[] = [];
	const seen = new Set<string>();
	for (const [index, rawLine] of text.split("\n").entries()) {
		const line = rawLine.replace(/#.*$/, "").trim();
		if (!line) continue;
		const match = /^(\S+)\s+(\d+)$/.exec(line);
		if (!match) {
			throw new Error(`upstream-allowlist.txt line ${index + 1}: expected "<path> <line budget>", got "${rawLine}"`);
		}
		const [, filePath, budget] = match;
		if (seen.has(filePath)) {
			throw new Error(`upstream-allowlist.txt line ${index + 1}: ${filePath} is listed twice`);
		}
		seen.add(filePath);
		entries.push({ path: filePath, budget: Number(budget) });
	}
	return entries;
}

/**
 * Joins `git diff --name-status -z` and `git diff --numstat -z` output (both
 * with `--no-renames`) into one record per changed file.
 */
export function parseChanges(nameStatus: string, numstat: string): FileChange[] {
	const lineCounts = new Map<string, number | null>();
	for (const record of numstat.split("\0")) {
		if (!record) continue;
		const [added, removed, ...rest] = record.split("\t");
		const filePath = rest.join("\t");
		lineCounts.set(filePath, added === "-" || removed === "-" ? null : Number(added) + Number(removed));
	}
	const fields = nameStatus.split("\0");
	const changes: FileChange[] = [];
	for (let i = 0; i + 1 < fields.length; i += 2) {
		const filePath = fields[i + 1];
		changes.push({ status: fields[i], path: filePath, lines: lineCounts.get(filePath) ?? null });
	}
	return changes;
}

/**
 * Returns one message per rule the fork breaks; an empty list means the diff
 * against upstream stays inside the fork's allowance.
 */
export function findScopeViolations(
	changes: readonly FileChange[],
	allowlist: readonly AllowlistEntry[],
	upstreamPaths: readonly string[],
): string[] {
	const violations: string[] = [];
	for (const upstreamPath of upstreamPaths) {
		if (isOwnedPath(upstreamPath)) {
			violations.push(`upstream now has ${upstreamPath} under a prefix the fork treats as its own`);
		}
	}
	const allowed = new Map(allowlist.map(entry => [entry.path, entry]));
	for (const entry of allowlist) {
		if (isOwnedPath(entry.path)) {
			violations.push(`${entry.path} is a fork-owned path and does not belong on the allowlist`);
		} else if (isForbiddenUpstreamPath(entry.path)) {
			violations.push(`${entry.path} is on the allowlist but the fork must not change it`);
		}
	}
	const modified = new Set<string>();
	for (const change of changes) {
		if (isOwnedPath(change.path)) continue;
		if (isForbiddenUpstreamPath(change.path)) {
			violations.push(`${change.path} is a file the fork must not change`);
			continue;
		}
		const entry = allowed.get(change.path);
		if (change.status === "A") {
			violations.push(`${change.path} is a new file outside the fork-owned prefixes`);
		} else if (change.status === "D") {
			violations.push(`${change.path} is an upstream file the fork deletes`);
		} else if (!entry) {
			violations.push(`${change.path} is an upstream file changed without an allowlist entry`);
		} else {
			modified.add(change.path);
			if (change.lines === null) {
				violations.push(`${change.path} is binary and cannot be held to a line budget`);
			} else if (change.lines > entry.budget) {
				violations.push(`${change.path} changes ${change.lines} lines, over its budget of ${entry.budget}`);
			}
		}
	}
	for (const entry of allowlist) {
		if (!isOwnedPath(entry.path) && !isForbiddenUpstreamPath(entry.path) && !modified.has(entry.path)) {
			violations.push(`${entry.path} is on the allowlist but the fork no longer changes it; remove the entry`);
		}
	}
	return violations;
}

function versionOf(manifest: string, filePath: string): unknown {
	try {
		return (JSON.parse(manifest) as { version?: unknown }).version;
	} catch (error) {
		throw new Error(`${filePath} is not valid JSON`, { cause: error });
	}
}

/**
 * Package versions belong to upstream: it rewrites them on every release, and a
 * compiled binary only embeds a native addon whose version stamp matches its
 * package. Other fields of a manifest may change.
 */
export function findVersionEdits(edits: readonly ManifestEdit[]): string[] {
	const violations: string[] = [];
	for (const edit of edits) {
		const before = versionOf(edit.before, edit.path);
		const after = versionOf(edit.after, edit.path);
		if (before !== after) {
			violations.push(`${edit.path} changes its package version from ${String(before)} to ${String(after)}`);
		}
	}
	return violations;
}

async function resolveUpstreamRef(): Promise<string> {
	const override = Bun.env.XSEC_UPSTREAM_REF;
	if (override) return override;
	const version = await readUpstreamVersion();
	const ref = "refs/xsec/upstream-base";
	await $`git fetch --quiet --depth 1 ${UPSTREAM_REPO_URL} +refs/tags/v${version}:${ref}`.cwd(repoRoot);
	return ref;
}

async function main(): Promise<void> {
	const base = await resolveUpstreamRef();
	const allowlistPath = path.join(import.meta.dir, "upstream-allowlist.txt");
	const allowlist = parseAllowlist(await Bun.file(allowlistPath).text());
	const diffArgs = ["--no-renames", "-z", base, "HEAD"];
	const nameStatus = await $`git diff --name-status ${diffArgs}`.cwd(repoRoot).text();
	const numstat = await $`git diff --numstat ${diffArgs}`.cwd(repoRoot).text();
	const upstreamPaths = (await $`git ls-tree -r --name-only -z ${base}`.cwd(repoRoot).text()).split("\0");
	const changes = parseChanges(nameStatus, numstat);

	const manifestEdits: ManifestEdit[] = [];
	for (const change of changes) {
		if (change.status !== "M" || isOwnedPath(change.path)) continue;
		if (path.posix.basename(change.path) !== "package.json") continue;
		manifestEdits.push({
			path: change.path,
			before: await $`git show ${base}:${change.path}`.cwd(repoRoot).text(),
			after: await $`git show HEAD:${change.path}`.cwd(repoRoot).text(),
		});
	}
	const violations = [...findScopeViolations(changes, allowlist, upstreamPaths), ...findVersionEdits(manifestEdits)];

	const upstreamTouched = changes.filter(change => !isOwnedPath(change.path));
	console.log(`Base ${base}: ${changes.length} changed file(s), ${upstreamTouched.length} of them upstream files.`);
	for (const change of upstreamTouched) {
		console.log(`  ${change.status} ${change.path} (${change.lines ?? "binary"} lines)`);
	}
	if (violations.length > 0) {
		for (const violation of violations) console.error(`::error title=Fork scope::${violation}`);
		process.exit(1);
	}
}

if (import.meta.main) await main();
