import { describe, expect, setDefaultTimeout } from "bun:test";
import { agentMessageText, useContractSession, userMessageTexts } from "./harness";

setDefaultTimeout(120_000);

const contract = useContractSession();
const { it } = contract;

describe("session/new and session/prompt", () => {
	it("streams the fake model's text as agent message chunks and resolves with end_turn", async () => {
		const home = await contract.home();
		const child = await contract.child(home);
		await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
		home.model.enqueue({ content: ["hello", " from the fake model"] });

		const { sessionId } = await child.connection.newSession({ cwd: home.workspace, mcpServers: [] });
		const response = await child.connection.prompt({ sessionId, prompt: [{ type: "text", text: "say hi" }] });

		expect(response.stopReason).toBe("end_turn");
		expect(agentMessageText(child.connection)).toBe("hello from the fake model");
		expect(userMessageTexts(home.model.requests.at(-1))).toContain("say hi");
	});
});
