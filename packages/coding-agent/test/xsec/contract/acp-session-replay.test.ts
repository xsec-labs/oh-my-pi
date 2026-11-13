import { describe, expect, it, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type AcpClient, type ContractHome, useContractSession } from "./harness";

setDefaultTimeout(120_000);

const contract = useContractSession();

/** A made-up secret, long enough to be masked. The placeholder the session gives it is `$$ACME_<hash>$$`. */
const SECRET = "Quill-Harbor-4471-Synthetic";
const SECRETS_YML = JSON.stringify([{ type: "plain", content: SECRET, mode: "obfuscate", friendlyName: "ACME" }]);

/** The placeholder of the secret, read from the first request, where the user's text is masked. */
function placeholderIn(body: unknown): string {
	const match = /\$\$ACME_[A-Z0-9]+(?::[ULCM])?\$\$/.exec(JSON.stringify(body));
	if (!match) throw new Error("the first request carries no placeholder for the secret");
	return match[0];
}

/** The text of one kind of chunk the client received from update index `from` onward, concatenated. */
function chunkText(
	client: AcpClient,
	from: number,
	sessionUpdate: "agent_message_chunk" | "agent_thought_chunk",
): string {
	let text = "";
	for (const { update } of client.updates.slice(from)) {
		if (update.sessionUpdate === sessionUpdate && update.content.type === "text") text += update.content.text;
	}
	return text;
}

/** Every session file the home holds, as base64 of its bytes, keyed by its path, so a load can be checked byte for byte. */
function sessionFileBytes(home: ContractHome): Record<string, string> {
	const sessionsDir = path.join(home.base, "agent", "sessions");
	const bytes: Record<string, string> = {};
	for (const name of fs.readdirSync(sessionsDir, { recursive: true, encoding: "utf8" })) {
		if (!name.endsWith(".jsonl")) continue;
		bytes[name] = fs.readFileSync(path.join(sessionsDir, name)).toString("base64");
	}
	return bytes;
}

/** The text of the session files, decoded, so a test can see what the session stores. */
function sessionFileText(files: Record<string, string>): string {
	return Object.values(files)
		.map(bytes => Buffer.from(bytes, "base64").toString("utf8"))
		.join("\n");
}

describe("session/load replays stored history with real values", () => {
	it("sends a stored placeholder as the real value in text, thinking and tool arguments, and writes nothing", async () => {
		const home = await contract.home({ secrets: SECRETS_YML });
		const first = await contract.child(home);
		await first.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const { sessionId } = await first.connection.newSession({ cwd: home.workspace, mcpServers: [] });
		home.model.enqueue({ content: ["noted"] });
		await first.connection.prompt({ sessionId, prompt: [{ type: "text", text: `the key is ${SECRET}` }] });
		const placeholder = placeholderIn(home.model.requests[0]);

		// The stored reply: a thinking block and a tool call whose arguments carry the placeholder, then a text reply.
		home.model.enqueue({
			content: [],
			thinking: [`Checking ${placeholder} first.`],
			toolCall: { name: "write", arguments: JSON.stringify({ path: "note.txt", content: `token ${placeholder}` }) },
		});
		home.model.enqueue({ content: [`Use ${placeholder} now.`] });
		await first.connection.prompt({ sessionId, prompt: [{ type: "text", text: "save the token" }] });
		// The session file as the first child left it. The load below must leave every byte of it alone.
		await first.close();
		const stored = sessionFileBytes(home);
		const storedText = sessionFileText(stored);
		expect(storedText).toContain(`Checking ${placeholder} first.`);
		expect(storedText).toContain(`token ${placeholder}`);
		expect(storedText).toContain(`Use ${placeholder} now.`);

		const second = await contract.child(home);
		await second.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
		await second.connection.loadSession({ sessionId, cwd: home.workspace, mcpServers: [] });

		expect(chunkText(second.connection, 0, "agent_thought_chunk")).toBe(`Checking ${SECRET} first.`);
		expect(chunkText(second.connection, 0, "agent_message_chunk")).toContain(`Use ${SECRET} now.`);
		const replayed = JSON.stringify(second.connection.updates);
		expect(replayed).toContain(`token ${SECRET}`);
		expect(replayed).not.toContain(placeholder);
		expect(sessionFileBytes(home)).toEqual(stored);
	});
});
