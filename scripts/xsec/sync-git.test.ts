import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gitText, inspectSyncHead, mergeTrees, mergeUpstreamRelease, parentsOf, showFileAt } from "./sync-git";
import { isPristineUpstreamMerge } from "./sync-policy";

// Real git in a throwaway repository: the merge and the head inspection are the
// parts of the sync that a mistake would push into xsec.
const IDENTITY = {
	GIT_AUTHOR_NAME: "test",
	GIT_AUTHOR_EMAIL: "test@example.invalid",
	GIT_COMMITTER_NAME: "test",
	GIT_COMMITTER_EMAIL: "test@example.invalid",
};

const created: string[] = [];

afterEach(async () => {
	for (const dir of created.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

async function commitFiles(dir: string, files: Record<string, string>, message: string): Promise<string> {
	for (const [name, content] of Object.entries(files)) await Bun.write(path.join(dir, name), content);
	await gitText(["add", "-A"], { cwd: dir });
	await gitText(["commit", "--quiet", "-m", message], { cwd: dir, env: IDENTITY });
	return (await gitText(["rev-parse", "HEAD"], { cwd: dir })).trim();
}

interface Fixture {
	dir: string;
	/** xsec: upstream's base with one fork commit that touches b.txt only. */
	xsec: string;
	/** Upstream's release tag: touches a.txt and adds c.txt. */
	tag: string;
	/** A second fork line that edits a.txt, so merging the release conflicts. */
	conflictingXsec: string;
	/** The upstream commit that changed a.txt. */
	upstreamChange: string;
}

async function fixture(): Promise<Fixture> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xsec-sync-git-"));
	created.push(dir);
	await gitText(["init", "--quiet", "-b", "upstream"], { cwd: dir });
	await commitFiles(dir, { "a.txt": "a\n", "b.txt": "b\n" }, "upstream base");
	const upstreamChange = await commitFiles(dir, { "a.txt": "a upstream\n", "c.txt": "c\n" }, "upstream change a");
	await gitText(["tag", "v1.1.0", upstreamChange], { cwd: dir });
	const base = (await gitText(["rev-parse", "HEAD~1"], { cwd: dir })).trim();

	await gitText(["checkout", "--quiet", "-b", "xsec", base], { cwd: dir });
	const xsec = await commitFiles(dir, { "b.txt": "b fork\n" }, "fork change b");
	await gitText(["checkout", "--quiet", "-b", "conflicting", base], { cwd: dir });
	const conflictingXsec = await commitFiles(dir, { "a.txt": "a fork\n" }, "fork change a");
	return { dir, xsec, tag: upstreamChange, conflictingXsec, upstreamChange };
}

describe("merging an upstream release into xsec", () => {
	it("makes one merge commit with xsec first and the release second, holding both sides", async () => {
		const { dir, xsec, tag } = await fixture();
		const merged = await mergeUpstreamRelease(xsec, tag, "Merge upstream v1.1.0", dir);
		expect(merged.clean).toBe(true);
		if (!merged.clean) return;
		expect(await parentsOf(merged.sha, dir)).toEqual([xsec, tag]);
		expect(await showFileAt(merged.sha, "a.txt", dir)).toBe("a upstream\n");
		expect(await showFileAt(merged.sha, "b.txt", dir)).toBe("b fork\n");
		expect(await showFileAt(merged.sha, "c.txt", dir)).toBe("c\n");
	});

	it("does not commit a conflict and names the file with the upstream commits that touched it", async () => {
		const { dir, conflictingXsec, tag, upstreamChange } = await fixture();
		const merged = await mergeUpstreamRelease(conflictingXsec, tag, "Merge upstream v1.1.0", dir);
		expect(merged.clean).toBe(false);
		if (merged.clean) return;
		expect(merged.conflicts.map(conflict => conflict.path)).toEqual(["a.txt"]);
		const upstreamCommits = merged.conflicts[0].upstreamCommits.join("\n");
		expect(upstreamCommits).toContain(upstreamChange.slice(0, 7));
		expect(upstreamCommits).toContain("upstream change a");
	});

	it("lists the files a merge cannot resolve when asked for the tree merge alone", async () => {
		const { dir, conflictingXsec, tag } = await fixture();
		const result = await mergeTrees(conflictingXsec, tag, dir);
		expect(result).toEqual({ clean: false, conflicts: ["a.txt"] });
	});
});

describe("inspecting a sync branch head", () => {
	it("recognises the workflow's own merge, and lists only the release's files as changed", async () => {
		const { dir, xsec, tag } = await fixture();
		const merged = await mergeUpstreamRelease(xsec, tag, "Merge upstream v1.1.0", dir);
		if (!merged.clean) throw new Error("the fixture merge must be clean");
		const facts = await inspectSyncHead(merged.sha, xsec, tag, dir);
		expect(isPristineUpstreamMerge(facts, tag)).toBe(true);
		// The fork's b.txt is xsec's own content, so the pull request changes only upstream files.
		expect(facts.changedPaths).toEqual([
			{ path: "a.txt", status: "M" },
			{ path: "c.txt", status: "A" },
		]);
	});

	it("reports a workflow file the release edits as modified and one it adds as added", async () => {
		// The status decides whether a sync pull request may stay open, so git's letters are pinned here.
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "xsec-sync-git-"));
		created.push(dir);
		await gitText(["init", "--quiet", "-b", "upstream"], { cwd: dir });
		const base = await commitFiles(
			dir,
			{ ".github/workflows/ci.yml": "on: push\n", "a.txt": "a\n" },
			"upstream base",
		);
		const tag = await commitFiles(
			dir,
			{ ".github/workflows/ci.yml": "on: pull_request\n", ".github/workflows/new.yml": "on: push\n" },
			"upstream workflows",
		);
		await gitText(["checkout", "--quiet", "-b", "xsec", base], { cwd: dir });
		const xsec = await commitFiles(dir, { "b.txt": "b fork\n" }, "fork change b");
		const merged = await mergeUpstreamRelease(xsec, tag, "Merge upstream workflows", dir);
		if (!merged.clean) throw new Error("the fixture merge must be clean");
		const facts = await inspectSyncHead(merged.sha, xsec, tag, dir);
		expect(facts.changedPaths).toEqual([
			{ path: ".github/workflows/ci.yml", status: "M" },
			{ path: ".github/workflows/new.yml", status: "A" },
		]);
	});

	it("does not treat a commit on top of the merge as the workflow's merge", async () => {
		const { dir, xsec, tag } = await fixture();
		const merged = await mergeUpstreamRelease(xsec, tag, "Merge upstream v1.1.0", dir);
		if (!merged.clean) throw new Error("the fixture merge must be clean");
		const onTop = await commitFiles(dir, { "d.txt": "a person's commit\n" }, "person commit");
		const facts = await inspectSyncHead(onTop, xsec, tag, dir);
		expect(isPristineUpstreamMerge(facts, tag)).toBe(false);
	});

	it("does not treat a merge commit with a hand edit as the workflow's merge", async () => {
		const { dir, xsec, tag } = await fixture();
		const auto = await mergeTrees(xsec, tag, dir);
		if (!auto.clean) throw new Error("the fixture merge must be clean");
		// Same parents as the workflow's merge, but a tree with one extra file.
		const indexFile = path.join(dir, "edit.index");
		const env = { GIT_INDEX_FILE: indexFile };
		await gitText(["read-tree", auto.tree], { cwd: dir, env });
		await Bun.write(path.join(dir, "edit.txt"), "hand edit\n");
		const blob = (await gitText(["hash-object", "-w", "edit.txt"], { cwd: dir })).trim();
		await gitText(["update-index", "--add", "--cacheinfo", `100644,${blob},extra.txt`], { cwd: dir, env });
		const editedTree = (await gitText(["write-tree"], { cwd: dir, env })).trim();
		const edited = (
			await gitText(["commit-tree", editedTree, "-p", xsec, "-p", tag, "-m", "hand edit"], {
				cwd: dir,
				env: IDENTITY,
			})
		).trim();
		const facts = await inspectSyncHead(edited, xsec, tag, dir);
		expect(facts.treeIsAutomaticMerge).toBe(false);
		expect(isPristineUpstreamMerge(facts, tag)).toBe(false);
	});

	it("still recognises the workflow's merge after xsec moves on, so the branch can be rebuilt", async () => {
		const { dir, xsec, tag } = await fixture();
		const merged = await mergeUpstreamRelease(xsec, tag, "Merge upstream v1.1.0", dir);
		if (!merged.clean) throw new Error("the fixture merge must be clean");
		await gitText(["checkout", "--quiet", xsec], { cwd: dir });
		const movedXsec = await commitFiles(dir, { "e.txt": "more fork work\n" }, "fork change e");
		const facts = await inspectSyncHead(merged.sha, movedXsec, tag, dir);
		expect(facts.parents[0]).toBe(xsec);
		expect(isPristineUpstreamMerge(facts, tag)).toBe(true);
	});
});
