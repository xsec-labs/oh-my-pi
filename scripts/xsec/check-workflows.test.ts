import { describe, expect, it } from "bun:test";
import { findForeignActiveWorkflows } from "./check-workflows";

describe("workflow guard", () => {
	it("flags only enabled workflow files that are not the fork's own", () => {
		const workflows = [
			{ name: "CI", path: ".github/workflows/ci.yml", state: "active" },
			{ name: "OMP Nix", path: ".github/workflows/nix.yml", state: "disabled_manually" },
			{ name: "xsec CI", path: ".github/workflows/xsec-ci.yml", state: "active" },
			{ name: "Dependabot Updates", path: "dynamic/dependabot/dependabot-updates", state: "active" },
		];
		expect(findForeignActiveWorkflows(workflows).map(workflow => workflow.path)).toEqual([
			".github/workflows/ci.yml",
		]);
	});
});
