#!/usr/bin/env bun
/**
 * Lists the upstream test files that everyday pull requests run: every file the
 * test paths in `upstream-allowlist.txt` name. One line per file, `<dir> <file>`:
 * CI runs each file from `<dir>`, the package it belongs to, as upstream does.
 * Prints nothing when the allowlist lists no test path.
 *
 * Usage: bun scripts/xsec/list-test-paths.ts
 */
import * as path from "node:path";
import { $ } from "bun";
import { listTestPaths, parseAllowlist, splitPackagePath } from "./check-upstream-diff";
import { repoRoot } from "./upstream";

async function main(): Promise<void> {
	const allowlistPath = path.join(import.meta.dir, "upstream-allowlist.txt");
	const allowlist = parseAllowlist(await Bun.file(allowlistPath).text());
	const repoFiles = (await $`git ls-files -z`.cwd(repoRoot).text()).split("\0").filter(Boolean);
	for (const filePath of listTestPaths(allowlist, repoFiles)) {
		const { dir, file } = splitPackagePath(filePath);
		console.log(`${dir} ${file}`);
	}
}

if (import.meta.main) await main();
