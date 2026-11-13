import { describe, expect, setDefaultTimeout } from "bun:test";
import * as path from "node:path";
import { logLines, startExtensionBridge, useContractSession } from "./harness";

setDefaultTimeout(120_000);

const contract = useContractSession();
const { it } = contract;
const BROKEN_EXTENSION = path.join(import.meta.dir, "fixtures", "broken-extension.ts");

describe("extension load failure", () => {
	it("logs a failed extension load and never registers the extension with the bridge", async () => {
		const home = await contract.home();
		const bridge = startExtensionBridge();
		try {
			// The bridge is reachable, so a registration would arrive if the extension ran.
			const child = await contract.child(home, {
				args: ["--extension", BROKEN_EXTENSION],
				env: { XSEC_CONTRACT_BRIDGE_URL: bridge.url },
			});
			await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
			await child.connection.newSession({ cwd: home.workspace, mcpServers: [] });

			expect(bridge.registrations).toHaveLength(0);
			const failures = logLines(home.base).filter(line => line.includes("Failed to load extension"));
			expect(failures.length).toBeGreaterThan(0);
			expect(failures.some(line => line.includes("broken-extension.ts"))).toBe(true);
			expect(failures.some(line => line.includes("contract fixture: this extension fails to load"))).toBe(true);
		} finally {
			bridge.stop();
		}
	});
});
