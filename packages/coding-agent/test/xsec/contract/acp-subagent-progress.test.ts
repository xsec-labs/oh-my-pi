import { describe, expect, it, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs";
import { isRecord } from "@oh-my-pi/pi-utils";
import { type AcpClient, type ContractHome, useContractSession } from "./harness";

setDefaultTimeout(120_000);

const contract = useContractSession();

/** A made-up secret, long enough to be masked. The placeholder the session gives it is `$$ACME_<hash>$$`. */
const SECRET = "Quill-Harbor-4471-Synthetic";
const SECRETS_YML = JSON.stringify([{ type: "plain", content: SECRET, mode: "obfuscate", friendlyName: "ACME" }]);
/** Only in the sub-agent's own user prompt, so the fake model answers the sub-agent with the reply routed to this marker. */
const MARKER = "SUBAGENT-PROGRESS-MARK";

/** The placeholder of the secret, read from the first request, where the user's text is masked. */
function placeholderIn(body: unknown): string {
	const match = /\$\$ACME_[A-Z0-9]+(?::[ULCM])?\$\$/.exec(JSON.stringify(body));
	if (!match) throw new Error("the first request carries no placeholder for the secret");
	return match[0];
}

/** The user messages of a chat completions request, as JSON, so a marker is found in any part. */
function userTextOf(body: unknown): string {
	if (!isRecord(body) || !Array.isArray(body.messages)) return "";
	return JSON.stringify(body.messages.filter((message: unknown) => isRecord(message) && message.role === "user"));
}

/** The tool call notifications the client received from update index `from` onward, as JSON. */
function toolUpdatesJson(client: AcpClient, from: number): string {
	return JSON.stringify(
		client.updates
			.slice(from)
			.filter(({ update }) => update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update"),
	);
}

/** Every progress line the client received for the sub-agent: the `recentOutput` of each progress snapshot. */
function progressLines(client: AcpClient, from: number): string[] {
	const lines: string[] = [];
	for (const { update } of client.updates.slice(from)) {
		if (update.sessionUpdate !== "tool_call_update" || !isRecord(update.rawOutput)) continue;
		const details = update.rawOutput.details;
		if (!isRecord(details) || !Array.isArray(details.progress)) continue;
		for (const snapshot of details.progress) {
			if (!isRecord(snapshot) || !Array.isArray(snapshot.recentOutput)) continue;
			lines.push(...snapshot.recentOutput.filter((line: unknown): line is string => typeof line === "string"));
		}
	}
	return lines;
}

/** Runs the task inline, so the parent waits for the sub-agent and its progress streams during this turn. */
function inlineTasks(home: ContractHome): void {
	fs.appendFileSync(home.configPath, "async:\n  enabled: false\n");
}

describe("sub-agent progress on the ACP client", () => {
	it("shows the sub-agent's streamed text with real values, and no placeholder reaches the client", async () => {
		const home = await contract.home({ secrets: SECRETS_YML });
		inlineTasks(home);
		const child = await contract.child(home);
		await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const { sessionId } = await child.connection.newSession({ cwd: home.workspace, mcpServers: [] });
		home.model.enqueue({ content: ["noted"] });
		await child.connection.prompt({ sessionId, prompt: [{ type: "text", text: `the key is ${SECRET}` }] });
		const placeholder = placeholderIn(home.model.requests[0]);

		// The sub-agent's reply, one character at a time, so its progress snapshots carry partial text.
		home.model.route(MARKER, { content: Array.from(`Key is ${placeholder}. Done.`) });
		home.model.enqueue({
			content: [],
			toolCall: { name: "task", arguments: JSON.stringify({ task: `${MARKER} report the key` }) },
		});
		home.model.enqueue({ content: ["parent done"] });

		const from = child.connection.updates.length;
		const before = home.model.requests.length;
		await child.connection.prompt({ sessionId, prompt: [{ type: "text", text: "delegate the key" }] });

		const toolJson = toolUpdatesJson(child.connection, from);
		expect(toolJson).not.toContain("$$");
		expect(progressLines(child.connection, from).join("\n")).toContain(`Key is ${SECRET}`);
		expect(toolJson).toContain(`Key is ${SECRET}`);

		// The provider side is unchanged: the parent's requests keep the placeholder and never the value.
		const parentRequests = home.model.requests.slice(before).filter(body => !userTextOf(body).includes(MARKER));
		expect(JSON.stringify(parentRequests.at(-1))).toContain(placeholder);
		expect(JSON.stringify(parentRequests)).not.toContain(SECRET);
	});

	it("shows the sub-agent's text as written when masking is off", async () => {
		const home = await contract.home();
		inlineTasks(home);
		const child = await contract.child(home);
		await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const { sessionId } = await child.connection.newSession({ cwd: home.workspace, mcpServers: [] });

		const literal = "$$ACME_AB12CD34$$";
		home.model.route(MARKER, { content: Array.from(`Note: ${literal}. Done.`) });
		home.model.enqueue({
			content: [],
			toolCall: { name: "task", arguments: JSON.stringify({ task: `${MARKER} report the note` }) },
		});
		home.model.enqueue({ content: ["parent done"] });

		const from = child.connection.updates.length;
		await child.connection.prompt({ sessionId, prompt: [{ type: "text", text: "delegate the note" }] });

		expect(progressLines(child.connection, from).join("\n")).toContain(`Note: ${literal}.`);
		expect(toolUpdatesJson(child.connection, from)).toContain(`Note: ${literal}.`);
	});
});
