import { describe, expect, it, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { runOmp, useContractSession } from "./harness";

// Each test starts an omp process, which takes seconds on a loaded runner.
setDefaultTimeout(120_000);

const contract = useContractSession();
const PACKAGE_JSON = path.resolve(import.meta.dir, "../../../package.json");

describe("omp --version", () => {
	it("exits 0 and prints the version from packages/coding-agent/package.json", async () => {
		const home = await contract.home();
		const result = await runOmp(home, ["--version"]);
		const { version } = JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf8")) as { version: string };

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(version);
	});
});

describe("ACP initialize", () => {
	it("answers protocol version 1", async () => {
		const home = await contract.home();
		const child = await contract.child(home);

		const response = await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });

		expect(response.protocolVersion).toBe(1);
	});
});
