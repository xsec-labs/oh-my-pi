#!/usr/bin/env bun
/**
 * Fails when a workflow that is not the fork's own can run in this repository.
 *
 * Upstream's workflow files stay in the tree untouched so syncs never conflict
 * on them, and are disabled in the repository's Actions settings instead: they
 * need upstream's runners and publishing secrets. A workflow upstream adds
 * later arrives enabled, and this check is what notices.
 *
 * Usage (GitHub Actions): bun scripts/xsec/check-workflows.ts
 * Needs GITHUB_TOKEN with `actions: read`, GITHUB_REPOSITORY and GITHUB_API_URL.
 */

export interface WorkflowInfo {
	name: string;
	path: string;
	state: string;
}

const WORKFLOW_DIR = ".github/workflows/";
const OWNED_WORKFLOW_PREFIX = ".github/workflows/xsec-";

/**
 * Workflow files of this repository that are enabled but not the fork's own.
 * Entries GitHub lists without a file in the workflow directory (Dependabot,
 * Pages and other built-in automation) are not upstream's and are ignored.
 */
export function findForeignActiveWorkflows(workflows: readonly WorkflowInfo[]): WorkflowInfo[] {
	return workflows.filter(
		workflow =>
			workflow.state === "active" &&
			workflow.path.startsWith(WORKFLOW_DIR) &&
			!workflow.path.startsWith(OWNED_WORKFLOW_PREFIX),
	);
}

function requireEnv(name: string): string {
	const value = Bun.env[name];
	if (!value) throw new Error(`${name} is not set`);
	return value;
}

async function listWorkflows(): Promise<WorkflowInfo[]> {
	const apiUrl = requireEnv("GITHUB_API_URL");
	const repository = requireEnv("GITHUB_REPOSITORY");
	const token = requireEnv("GITHUB_TOKEN");
	const workflows: WorkflowInfo[] = [];
	for (let page = 1; ; page++) {
		const response = await fetch(`${apiUrl}/repos/${repository}/actions/workflows?per_page=100&page=${page}`, {
			headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
		});
		if (!response.ok) {
			throw new Error(`Listing workflows failed: HTTP ${response.status} ${await response.text()}`);
		}
		const body = (await response.json()) as { workflows: WorkflowInfo[] };
		workflows.push(...body.workflows);
		if (body.workflows.length < 100) return workflows;
	}
}

async function main(): Promise<void> {
	const foreign = findForeignActiveWorkflows(await listWorkflows());
	if (foreign.length === 0) {
		console.log("No upstream workflow is enabled.");
		return;
	}
	for (const workflow of foreign) {
		console.error(
			`::error title=Upstream workflow enabled::${workflow.path} (${workflow.name}) is enabled. Disable it under Actions in the repository; do not edit or delete the file.`,
		);
	}
	process.exit(1);
}

if (import.meta.main) await main();
