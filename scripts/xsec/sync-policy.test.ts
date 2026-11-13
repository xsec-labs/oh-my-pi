import { describe, expect, it } from "bun:test";
import {
	type AutoMergeFacts,
	decideAutoMerge,
	isPristineUpstreamMerge,
	KNOWN_UPSTREAM_FAILURE_CHECK,
	pickNewerRelease,
	planSync,
	type SyncHeadFacts,
	syncBranchFor,
	versionOfSyncBranch,
} from "./sync-policy";

/** A sync pull request that holds only the upstream merge and whose checks are all green. */
function cleanFacts(): AutoMergeFacts {
	return {
		pull: {
			open: true,
			draft: false,
			baseRef: "xsec",
			headRef: "sync/v18.21.0",
			headFromFork: false,
			mergeable: true,
		},
		baseSha: "xsec-head",
		tagSha: "upstream-v18.21.0",
		head: {
			parents: ["xsec-head", "upstream-v18.21.0"],
			extraCommits: [],
			treeIsAutomaticMerge: true,
			// Upstream's own CHANGELOG.md churn is part of every release and does not block.
			changedPaths: ["packages/ai/src/index.ts", "CHANGELOG.md"],
		},
		freshMergeConflicts: false,
		checkRuns: [
			{ name: "Fork scope", status: "completed", conclusion: "success" },
			{ name: "Tests workspace", status: "completed", conclusion: "skipped" },
		],
		statusState: null,
	};
}

function withHead(overrides: Partial<SyncHeadFacts>): AutoMergeFacts {
	const base = cleanFacts();
	return { ...base, head: { ...base.head, ...overrides } };
}

describe("choosing the next upstream release", () => {
	it("takes 18.10.0 over 18.9.1, comparing numbers rather than text", () => {
		// Text order would rank v18.9.1 above v18.10.0 and the fork would sync to the older release.
		expect(pickNewerRelease("18.9.0", ["v18.9.1", "v18.10.0"])?.tag).toBe("v18.10.0");
	});

	it("takes the newest release even when an older newer one is listed first", () => {
		expect(pickNewerRelease("18.20.0", ["v18.20.1", "v18.21.0", "v18.20.2"])?.version).toBe("18.21.0");
	});

	it("ignores a release tag older than the current base", () => {
		// Taking it would move xsec backwards.
		expect(pickNewerRelease("18.20.0", ["v18.19.9"])).toBeNull();
	});

	it("returns nothing when the base is already the newest release", () => {
		expect(pickNewerRelease("18.20.0", ["v18.20.0", "v18.19.0"])).toBeNull();
	});

	it("ignores pre-release tags and fork tags, which are not upstream releases", () => {
		// A fork tag or a release candidate merged as a release would ship unreviewed upstream code.
		expect(pickNewerRelease("18.20.0", ["v18.21.0-rc.1", "v18.21.0-xsec.1", "18.21.0", "v18.21"])).toBeNull();
	});
});

describe("sync branch names", () => {
	it("names a branch by its version and reads the version back", () => {
		expect(versionOfSyncBranch(syncBranchFor("18.21.0"))).toBe("18.21.0");
	});

	it("does not treat other branches as sync branches", () => {
		// The auto-merge check must never act on a branch a person made.
		expect(versionOfSyncBranch("claude/xsec-sync")).toBeNull();
		expect(versionOfSyncBranch("sync/v18.21.0-rc.1")).toBeNull();
	});
});

describe("planning a sync", () => {
	it("opens a pull request for the newest release when none is open", () => {
		const plan = planSync({ baseVersion: "18.20.0", tagNames: ["v18.20.1", "v18.21.0"], openSyncVersion: null });
		expect(plan).toEqual({ kind: "open", release: { tag: "v18.21.0", version: "18.21.0" } });
	});

	it("does nothing when xsec is the newest release and no pull request is open", () => {
		expect(planSync({ baseVersion: "18.20.0", tagNames: ["v18.20.0"], openSyncVersion: null })).toEqual({
			kind: "idle",
		});
	});

	it("keeps the open pull request and makes a newer release wait for it", () => {
		// A second sync pull request while one is open would race it into xsec.
		const plan = planSync({
			baseVersion: "18.20.0",
			tagNames: ["v18.20.1", "v18.21.0"],
			openSyncVersion: "18.20.1",
		});
		expect(plan).toEqual({
			kind: "keep",
			version: "18.20.1",
			waitingFor: { tag: "v18.21.0", version: "18.21.0" },
		});
	});

	it("keeps the open pull request without a wait when it already carries the newest release", () => {
		const plan = planSync({ baseVersion: "18.20.0", tagNames: ["v18.21.0"], openSyncVersion: "18.21.0" });
		expect(plan).toEqual({ kind: "keep", version: "18.21.0", waitingFor: null });
	});
});

describe("the auto-merge condition", () => {
	it("merges a clean sync pull request whose head is only the upstream merge and whose checks are green", () => {
		expect(decideAutoMerge(cleanFacts())).toEqual({ merge: true, reasons: [] });
	});

	it("keeps a pull request whose head has a fork commit on top of the merge", () => {
		// A fork commit would reach xsec without a T-37 review.
		const facts = withHead({ parents: ["fork-commit"], extraCommits: ["fork-commit"], treeIsAutomaticMerge: false });
		const decision = decideAutoMerge(facts);
		expect(decision.merge).toBe(false);
		expect(decision.reasons.join("; ")).toContain("not the merge of the current xsec head");
		expect(decision.reasons.join("; ")).toContain("beyond the merge");
	});

	it("keeps a merge commit whose tree was edited by hand", () => {
		const decision = decideAutoMerge(withHead({ treeIsAutomaticMerge: false }));
		expect(decision.reasons).toEqual(["its tree differs from git's automatic merge"]);
	});

	it("keeps a pull request built on an xsec that has since moved", () => {
		// Its checks ran on a merge that xsec no longer has, so they do not vouch for the result.
		const facts = { ...cleanFacts(), baseSha: "xsec-head-2" };
		expect(decideAutoMerge(facts).merge).toBe(false);
	});

	it("keeps a pull request with a conflict against xsec", () => {
		expect(decideAutoMerge({ ...cleanFacts(), freshMergeConflicts: true }).merge).toBe(false);
		const github = cleanFacts();
		expect(decideAutoMerge({ ...github, pull: { ...github.pull, mergeable: false } }).reasons).toEqual([
			"GitHub reports that it does not merge cleanly",
		]);
	});

	it("keeps a pull request while GitHub has not computed its mergeability", () => {
		const facts = cleanFacts();
		expect(decideAutoMerge({ ...facts, pull: { ...facts.pull, mergeable: null } }).merge).toBe(false);
	});

	it("keeps a pull request whose checks have not all finished", () => {
		const facts = cleanFacts();
		const running = {
			...facts,
			checkRuns: [...facts.checkRuns, { name: "Lint", status: "in_progress", conclusion: null }],
		};
		expect(decideAutoMerge(running).reasons).toEqual(["check Lint is in_progress"]);
	});

	it("keeps a pull request with a failed or cancelled check", () => {
		const facts = cleanFacts();
		const failed = { ...facts, checkRuns: [{ name: "Test native 1/3", status: "completed", conclusion: "failure" }] };
		const cancelled = {
			...facts,
			checkRuns: [{ name: "Test native 2/3", status: "completed", conclusion: "cancelled" }],
		};
		expect(decideAutoMerge(failed).reasons).toEqual(["check Test native 1/3 concluded failure"]);
		expect(decideAutoMerge(cancelled).reasons).toEqual(["check Test native 2/3 concluded cancelled"]);
	});

	it("names the known upstream failure when it is the red check, and keeps the pull request open", () => {
		// A red check always blocks. The name only tells the reader which failure it is.
		const known = {
			...cleanFacts(),
			checkRuns: [
				{ name: "Fork scope", status: "completed", conclusion: "success" },
				{ name: KNOWN_UPSTREAM_FAILURE_CHECK, status: "completed", conclusion: "failure" },
			],
		};
		const decision = decideAutoMerge(known);
		expect(decision.merge).toBe(false);
		expect(decision.reasons).toHaveLength(1);
		expect(decision.reasons[0]).toContain("known upstream failure");
	});

	it("does not call a cancelled known check a known failure", () => {
		// A cancelled run says nothing about upstream's test, so the reason stays the plain one.
		const cancelled = {
			...cleanFacts(),
			checkRuns: [{ name: KNOWN_UPSTREAM_FAILURE_CHECK, status: "completed", conclusion: "cancelled" }],
		};
		expect(decideAutoMerge(cancelled).reasons).toEqual([`check ${KNOWN_UPSTREAM_FAILURE_CHECK} concluded cancelled`]);
	});

	it("keeps a pull request that no check has run on", () => {
		// No checks at all is not the same as all checks green.
		expect(decideAutoMerge({ ...cleanFacts(), checkRuns: [] }).reasons).toEqual([
			"no check has reported on the head yet",
		]);
	});

	it("keeps a pull request whose combined commit status is pending or failed", () => {
		expect(decideAutoMerge({ ...cleanFacts(), statusState: "pending" }).reasons).toEqual([
			"the commit status is pending",
		]);
		expect(decideAutoMerge({ ...cleanFacts(), statusState: "failure" }).reasons).toEqual([
			"the commit status is failure",
		]);
	});

	it("keeps a pull request that changes fork-owned files or upstream workflow files", () => {
		const owned = withHead({ changedPaths: ["packages/ai/src/index.ts", "scripts/xsec/sync.ts"] });
		expect(decideAutoMerge(owned).reasons).toEqual(["it changes fork-owned file scripts/xsec/sync.ts"]);
		const workflow = withHead({ changedPaths: [".github/workflows/nix.yml"] });
		expect(decideAutoMerge(workflow).reasons).toEqual(["it changes workflow file .github/workflows/nix.yml"]);
	});

	it("keeps a draft, a pull request into another base, and one from a fork", () => {
		const facts = cleanFacts();
		expect(decideAutoMerge({ ...facts, pull: { ...facts.pull, draft: true } }).reasons).toEqual([
			"the pull request is a draft",
		]);
		expect(decideAutoMerge({ ...facts, pull: { ...facts.pull, baseRef: "main" } }).reasons).toEqual([
			"it targets main, not xsec",
		]);
		expect(decideAutoMerge({ ...facts, pull: { ...facts.pull, headFromFork: true } }).reasons).toEqual([
			"its head is not a branch of this repository",
		]);
	});
});

describe("which sync branches the workflow may rewrite", () => {
	const tag = "upstream-v18.21.0";

	it("rewrites only the workflow's own merge of the release", () => {
		expect(isPristineUpstreamMerge(cleanFacts().head, tag)).toBe(true);
	});

	it("leaves a branch alone once a person has committed to it", () => {
		// Rewriting it would discard that work.
		expect(isPristineUpstreamMerge({ ...cleanFacts().head, extraCommits: ["person-commit"] }, tag)).toBe(false);
	});

	it("leaves a branch alone when it merged a different upstream commit", () => {
		expect(isPristineUpstreamMerge(cleanFacts().head, "upstream-v18.20.0")).toBe(false);
	});
});
