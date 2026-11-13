import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { repoRoot } from "./upstream";

// The sync workflow is the one job in this repository that holds a write token.
// These checks read the parsed workflow file, not its text, for the properties
// that keep the token safe.
const WORKFLOW_PATH = path.join(repoRoot, ".github", "workflows", "xsec-sync.yml");
const TOKEN_REFERENCE = /\$\{\{\s*secrets\.OMP_SYNC_TOKEN\s*\}\}/;

interface Step {
	uses?: unknown;
	with?: Record<string, unknown>;
	run?: unknown;
}

interface JobSpec {
	"runs-on"?: unknown;
	steps?: Step[];
	permissions?: Record<string, unknown>;
	env?: Record<string, unknown>;
}

interface WorkflowSpec {
	on?: Record<string, unknown>;
	jobs: Record<string, JobSpec>;
}

async function loadWorkflow(): Promise<WorkflowSpec> {
	return Bun.YAML.parse(await Bun.file(WORKFLOW_PATH).text()) as WorkflowSpec;
}

/** Counts the strings under `value` that reference the sync token. */
function countTokenReferences(value: unknown): number {
	if (typeof value === "string") return TOKEN_REFERENCE.test(value) ? 1 : 0;
	if (Array.isArray(value)) return value.reduce<number>((sum, item) => sum + countTokenReferences(item), 0);
	if (value !== null && typeof value === "object") {
		return Object.values(value).reduce<number>((sum, item) => sum + countTokenReferences(item), 0);
	}
	return 0;
}

describe("xsec sync workflow", () => {
	it("grants the workflow's own token read scopes only, including the checks and statuses the merge reads", async () => {
		// Writes go through OMP_SYNC_TOKEN; a write scope here would let a run write without it.
		const workflow = await loadWorkflow();
		const permissions = workflow.jobs.sync.permissions ?? {};
		expect(Object.values(permissions).every(level => level === "read")).toBe(true);
		expect(permissions.checks).toBe("read");
		expect(permissions.statuses).toBe("read");
	});

	it("passes the workflow's own token to the run as the read token", async () => {
		// The run reads with this token; it must be the workflow's own, not the sync token.
		const workflow = await loadWorkflow();
		expect(workflow.jobs.sync.env?.GITHUB_READ_TOKEN).toBe(`\${{ github.token }}`);
	});

	it("runs only on a schedule or by hand, never on pull request events", async () => {
		// A pull request event would run the pull request's own code with the token.
		const workflow = await loadWorkflow();
		expect(Object.keys(workflow.on ?? {}).sort()).toEqual(["schedule", "workflow_dispatch"]);
	});

	it("runs every job on a GitHub-hosted runner", async () => {
		// The repository is public: a self-hosted runner would execute code from any fork.
		const workflow = await loadWorkflow();
		for (const [name, job] of Object.entries(workflow.jobs)) {
			expect(`${name}: ${String(job["runs-on"])}`).toMatch(/^[\w-]+: (ubuntu|macos|windows)-/);
		}
	});

	it("references the token in exactly one job", async () => {
		// A second job holding the token would widen what can use it.
		const workflow = await loadWorkflow();
		const jobsWithToken = Object.entries(workflow.jobs).filter(([, job]) => countTokenReferences(job) > 0);
		expect(jobsWithToken.map(([name]) => name)).toHaveLength(1);
	});

	it("hands the token only to the steps that use it, never to the actions the job runs", async () => {
		// An action runs in its job's environment, so a token set on the job would reach checkout and setup-bun.
		const workflow = await loadWorkflow();
		const job = workflow.jobs.sync;
		expect(countTokenReferences(job.env)).toBe(0);
		for (const step of job.steps ?? []) {
			if (typeof step.uses === "string") expect(countTokenReferences(step)).toBe(0);
		}
		// The sync run itself must still get the token.
		const sync = job.steps?.find(step => typeof step.run === "string" && step.run.includes("scripts/xsec/sync.ts"));
		expect(countTokenReferences(sync)).toBe(1);
	});

	it("does not leave the token in the checkout's git configuration", async () => {
		// Persisted credentials would stay in .git/config for every later step to read.
		const workflow = await loadWorkflow();
		const steps = Object.values(workflow.jobs).flatMap(job => job.steps ?? []);
		const checkouts = steps.filter(
			step => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@"),
		);
		expect(checkouts.length).toBeGreaterThan(0);
		for (const checkout of checkouts) {
			expect(checkout.with?.["persist-credentials"]).toBe(false);
		}
	});
});
