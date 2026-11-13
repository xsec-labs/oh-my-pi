import { describe, expect, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { startExtensionBridge, toolResultTexts, useContractSession } from "./harness";

setDefaultTimeout(120_000);

const contract = useContractSession();
const { it } = contract;
const APPROVAL_GATE = path.join(import.meta.dir, "fixtures", "approval-gate.ts");

/** The arguments of a `write` call that creates `filePath` with fixed content. */
function writeArguments(filePath: string): string {
	return JSON.stringify({ path: filePath, content: "written by the model" });
}

describe("approval gate extension", () => {
	it("does not run a tool call the bridge refuses, and the refusal reaches the model", async () => {
		const home = await contract.home();
		const bridge = startExtensionBridge();
		try {
			bridge.decide = () => ({ allow: false, reason: "the contract gate refused this write" });
			const child = await contract.child(home, {
				args: ["--extension", APPROVAL_GATE],
				env: { XSEC_CONTRACT_BRIDGE_URL: bridge.url },
			});
			await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
			const { sessionId } = await child.connection.newSession({ cwd: home.workspace, mcpServers: [] });

			home.model.enqueue({ content: [], toolCall: { name: "write", arguments: writeArguments("denied.txt") } });
			home.model.enqueue({ content: ["the write was refused"] });
			const response = await child.connection.prompt({
				sessionId,
				prompt: [{ type: "text", text: "write denied.txt" }],
			});

			expect(response.stopReason).toBe("end_turn");
			expect(bridge.registrations).toHaveLength(1);
			expect(bridge.approvals).toHaveLength(1);
			expect(bridge.approvals[0]).toMatchObject({ toolName: "write" });
			expect(fs.existsSync(path.join(home.workspace, "denied.txt"))).toBe(false);
			// The model's second request is the one that carries the tool result back.
			const toolResults = toolResultTexts(home.model.requests[1]);
			expect(toolResults.some(text => text.includes("the contract gate refused this write"))).toBe(true);
		} finally {
			bridge.stop();
		}
	});

	it("runs a tool call the bridge allows", async () => {
		const home = await contract.home();
		const bridge = startExtensionBridge();
		try {
			bridge.decide = () => ({ allow: true });
			const child = await contract.child(home, {
				args: ["--extension", APPROVAL_GATE],
				env: { XSEC_CONTRACT_BRIDGE_URL: bridge.url },
			});
			await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
			const { sessionId } = await child.connection.newSession({ cwd: home.workspace, mcpServers: [] });

			home.model.enqueue({ content: [], toolCall: { name: "write", arguments: writeArguments("allowed.txt") } });
			home.model.enqueue({ content: ["the write went through"] });
			const response = await child.connection.prompt({
				sessionId,
				prompt: [{ type: "text", text: "write allowed.txt" }],
			});

			expect(response.stopReason).toBe("end_turn");
			expect(bridge.approvals).toHaveLength(1);
			expect(fs.readFileSync(path.join(home.workspace, "allowed.txt"), "utf8")).toBe("written by the model");
		} finally {
			bridge.stop();
		}
	});
});
