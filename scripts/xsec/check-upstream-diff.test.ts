import { describe, expect, it } from "bun:test";
import {
	type AllowlistEntry,
	type FileChange,
	findScopeViolations,
	findTestPathViolations,
	findVersionEdits,
	listTestPaths,
	parseAllowlist,
	parseChanges,
	splitPackagePath,
} from "./check-upstream-diff";

function change(status: string, path: string, lines: number | null = 1): FileChange {
	return { status, path, lines };
}

describe("fork scope check", () => {
	it("accepts new, changed and deleted files under the fork-owned prefixes without an allowlist", () => {
		const changes = [
			change("A", "packages/coding-agent/src/xsec/continue.ts", 400),
			change("M", "packages/coding-agent/test/xsec/continue.test.ts", 90),
			change("D", "scripts/xsec/old.ts", 30),
			change("A", ".github/workflows/xsec-ci.yml", 120),
		];
		expect(findScopeViolations(changes, [], [])).toEqual([]);
	});

	it("rejects an upstream file changed without an allowlist entry", () => {
		const violations = findScopeViolations([change("M", "packages/coding-agent/src/main.ts")], [], []);
		expect(violations).toHaveLength(1);
		expect(violations[0]).toContain("packages/coding-agent/src/main.ts");
		expect(violations[0]).toContain("without an allowlist entry");
	});

	it("holds an allowlisted file to its line budget", () => {
		const allowlist: AllowlistEntry[] = [
			{
				path: "packages/coding-agent/src/modes/acp/acp-agent.ts",
				budget: 6,
				testPaths: ["packages/coding-agent/test/acp-*.test.ts"],
			},
		];
		const within = [change("M", "packages/coding-agent/src/modes/acp/acp-agent.ts", 6)];
		const over = [change("M", "packages/coding-agent/src/modes/acp/acp-agent.ts", 7)];
		expect(findScopeViolations(within, allowlist, [])).toEqual([]);
		expect(findScopeViolations(over, allowlist, [])).toEqual([
			"packages/coding-agent/src/modes/acp/acp-agent.ts changes 7 lines, over its budget of 6",
		]);
	});

	it("rejects new files outside the owned prefixes and deleted upstream files even when allowlisted", () => {
		const allowlist: AllowlistEntry[] = [
			{
				path: "packages/coding-agent/src/gone.ts",
				budget: 500,
				testPaths: ["packages/coding-agent/test/gone.test.ts"],
			},
		];
		const violations = findScopeViolations(
			[change("A", "packages/coding-agent/src/helper.ts"), change("D", "packages/coding-agent/src/gone.ts", 80)],
			allowlist,
			[],
		);
		expect(violations.some(v => v.includes("src/helper.ts is a new file outside"))).toBe(true);
		expect(violations.some(v => v.includes("src/gone.ts is an upstream file the fork deletes"))).toBe(true);
	});

	it("rejects an allowlist entry the fork no longer needs", () => {
		const allowlist: AllowlistEntry[] = [
			{
				path: "packages/coding-agent/src/mcp/tool-bridge.ts",
				budget: 4,
				testPaths: ["packages/coding-agent/test/mcp-*.test.ts"],
			},
		];
		expect(findScopeViolations([], allowlist, [])).toEqual([
			"packages/coding-agent/src/mcp/tool-bridge.ts is on the allowlist but the fork no longer changes it; remove the entry",
		]);
	});

	it("reports upstream moving into a prefix the fork owns", () => {
		const violations = findScopeViolations([], [], ["README.md", "packages/coding-agent/src/xsec/index.ts"]);
		expect(violations).toEqual([
			"upstream now has packages/coding-agent/src/xsec/index.ts under a prefix the fork treats as its own",
		]);
	});

	it("rejects a binary change to an allowlisted file", () => {
		const allowlist: AllowlistEntry[] = [
			{ path: "assets/logo.png", budget: 10, testPaths: ["packages/coding-agent/test/logo.test.ts"] },
		];
		const violations = findScopeViolations([change("M", "assets/logo.png", null)], allowlist, []);
		expect(violations).toEqual(["assets/logo.png is binary and cannot be held to a line budget"]);
	});

	it("never accepts a CHANGELOG or upstream workflow change, even when allowlisted", () => {
		const allowlist: AllowlistEntry[] = [
			{
				path: "packages/coding-agent/CHANGELOG.md",
				budget: 5,
				testPaths: ["packages/coding-agent/test/changelog.test.ts"],
			},
			{ path: ".github/workflows/ci.yml", budget: 2, testPaths: ["packages/coding-agent/test/ci.test.ts"] },
		];
		const changes = [
			change("M", "packages/coding-agent/CHANGELOG.md", 5),
			change("M", ".github/workflows/ci.yml", 2),
		];
		expect(findScopeViolations(changes, allowlist, [])).toEqual([
			"packages/coding-agent/CHANGELOG.md is on the allowlist but the fork must not change it",
			".github/workflows/ci.yml is on the allowlist but the fork must not change it",
			"packages/coding-agent/CHANGELOG.md is a file the fork must not change",
			".github/workflows/ci.yml is a file the fork must not change",
		]);
	});

	it("still accepts a fork-owned CHANGELOG-named file and workflow", () => {
		const changes = [
			change("A", ".github/workflows/xsec-release.yml", 40),
			change("M", "scripts/xsec/CHANGELOG.md", 3),
		];
		expect(findScopeViolations(changes, [], [])).toEqual([]);
	});
});

describe("related test paths", () => {
	it("accepts literal paths and globs that name test files", () => {
		const allowlist: AllowlistEntry[] = [
			{
				path: "packages/coding-agent/src/x.ts",
				budget: 1,
				testPaths: ["packages/coding-agent/test/x.test.ts", "packages/coding-agent/test/x-*.test.ts"],
			},
		];
		const files = [
			"packages/coding-agent/test/x.test.ts",
			"packages/coding-agent/test/x-extra.test.ts",
			"packages/coding-agent/src/x.ts",
		];
		expect(findTestPathViolations(allowlist, files)).toEqual([]);
	});

	it("rejects a glob that matches no file", () => {
		const allowlist: AllowlistEntry[] = [
			{ path: "packages/coding-agent/src/x.ts", budget: 1, testPaths: ["packages/coding-agent/test/y-*.test.ts"] },
		];
		expect(findTestPathViolations(allowlist, ["packages/coding-agent/test/x.test.ts"])).toEqual([
			"packages/coding-agent/src/x.ts lists test path packages/coding-agent/test/y-*.test.ts, which matches no file",
		]);
	});

	it("rejects a test path that matches a file which is not a *.test.ts file", () => {
		const allowlist: AllowlistEntry[] = [
			{ path: "packages/coding-agent/src/x.ts", budget: 1, testPaths: ["packages/coding-agent/test/x*"] },
		];
		expect(
			findTestPathViolations(allowlist, [
				"packages/coding-agent/test/x-helper.ts",
				"packages/coding-agent/test/x.test.ts",
			]),
		).toEqual([
			"packages/coding-agent/src/x.ts lists test path packages/coding-agent/test/x*, which matches packages/coding-agent/test/x-helper.ts, not a *.test.ts file",
		]);
	});

	it("lists each test file once, sorted, across all entries", () => {
		const allowlist: AllowlistEntry[] = [
			{ path: "packages/coding-agent/src/a.ts", budget: 1, testPaths: ["packages/coding-agent/test/*.test.ts"] },
			{
				path: "packages/coding-agent/src/b.ts",
				budget: 1,
				testPaths: ["packages/coding-agent/test/b.test.ts", "packages/coding-agent/test/a.test.ts"],
			},
		];
		const files = [
			"packages/coding-agent/test/b.test.ts",
			"packages/coding-agent/test/a.test.ts",
			"packages/coding-agent/test/helper.ts",
		];
		expect(listTestPaths(allowlist, files)).toEqual([
			"packages/coding-agent/test/a.test.ts",
			"packages/coding-agent/test/b.test.ts",
		]);
	});

	it("runs each test file from the package it belongs to", () => {
		expect(splitPackagePath("packages/coding-agent/test/acp-agent.test.ts")).toEqual({
			dir: "packages/coding-agent",
			file: "test/acp-agent.test.ts",
		});
		expect(splitPackagePath("scripts/xsec/check-workflows.test.ts")).toEqual({
			dir: ".",
			file: "scripts/xsec/check-workflows.test.ts",
		});
	});
});

describe("package versions", () => {
	it("accepts a manifest edit that leaves the version alone", () => {
		const edits = [
			{
				path: "packages/coding-agent/package.json",
				before: JSON.stringify({ version: "18.20.0", dependencies: { "left-pad": "1.0.0" } }),
				after: JSON.stringify({ version: "18.20.0", dependencies: { "left-pad": "1.1.0" } }),
			},
		];
		expect(findVersionEdits(edits)).toEqual([]);
	});

	it("rejects a changed version and names both versions", () => {
		const edits = [
			{
				path: "packages/natives/package.json",
				before: JSON.stringify({ version: "18.20.0" }),
				after: JSON.stringify({ version: "18.20.0-xsec.1" }),
			},
		];
		expect(findVersionEdits(edits)).toEqual([
			"packages/natives/package.json changes its package version from 18.20.0 to 18.20.0-xsec.1",
		]);
	});

	it("fails loudly on a manifest that is not JSON instead of passing it", () => {
		const edits = [{ path: "packages/utils/package.json", before: "{}", after: "{ not json" }];
		expect(() => findVersionEdits(edits)).toThrow("packages/utils/package.json is not valid JSON");
	});
});

describe("allowlist file", () => {
	it("reads paths, budgets and test paths, and skips comments and blank lines", () => {
		const text =
			"# header\n\npackages/a.ts 3 packages/a.test.ts\npackages/b.ts   12  packages/b/*.test.ts packages/b-extra.test.ts  # call line\n";
		expect(parseAllowlist(text)).toEqual([
			{ path: "packages/a.ts", budget: 3, testPaths: ["packages/a.test.ts"] },
			{ path: "packages/b.ts", budget: 12, testPaths: ["packages/b/*.test.ts", "packages/b-extra.test.ts"] },
		]);
	});

	it("rejects a line without a budget, a budget that is not a number, or no test path", () => {
		expect(() => parseAllowlist("packages/a.ts\n")).toThrow("line 1");
		expect(() => parseAllowlist("packages/a.ts x packages/a.test.ts\n")).toThrow("line 1");
		expect(() => parseAllowlist("packages/a.ts 3\n")).toThrow("line 1");
	});

	it("rejects a path listed twice", () => {
		expect(() => parseAllowlist("packages/a.ts 1 packages/a.test.ts\npackages/a.ts 2 packages/a.test.ts\n")).toThrow(
			"listed twice",
		);
	});
});

describe("git diff parsing", () => {
	it("joins status and line counts per file, with binary files as null", () => {
		const nameStatus = "M\0src/a.ts\0A\0src/with space.ts\0M\0logo.png\0";
		const numstat = "3\t2\tsrc/a.ts\x0010\t0\tsrc/with space.ts\0-\t-\tlogo.png\0";
		expect(parseChanges(nameStatus, numstat)).toEqual([
			{ status: "M", path: "src/a.ts", lines: 5 },
			{ status: "A", path: "src/with space.ts", lines: 10 },
			{ status: "M", path: "logo.png", lines: null },
		]);
	});
});
