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

/** One character per delta, so every cut point of a placeholder falls between two deltas. */
function perCharacter(text: string): string[] {
	return Array.from(text);
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

/** The text of every session file the home has written: what the session persists, placeholders included. */
function persistedSessionText(home: ContractHome): string {
	const sessionsDir = path.join(home.base, "agent", "sessions");
	return fs
		.readdirSync(sessionsDir, { recursive: true, encoding: "utf8" })
		.filter(name => name.endsWith(".jsonl"))
		.map(name => fs.readFileSync(path.join(sessionsDir, name), "utf8"))
		.join("\n");
}

/** Starts an ACP session for a home with the secret in it, and learns the placeholder from the first prompt. */
async function sessionKnowingSecret(home: ContractHome) {
	const child = await contract.child(home);
	await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
	const { sessionId } = await child.connection.newSession({ cwd: home.workspace, mcpServers: [] });
	home.model.enqueue({ content: ["noted"] });
	await child.connection.prompt({ sessionId, prompt: [{ type: "text", text: `the key is ${SECRET}` }] });
	return { child, sessionId, placeholder: placeholderIn(home.model.requests[0]) };
}

describe("streamed model text on the ACP client", () => {
	it("sends a placeholder split at every cut point as the real value, and the session keeps the placeholder", async () => {
		const home = await contract.home({ secrets: SECRETS_YML });
		const { child, sessionId, placeholder } = await sessionKnowingSecret(home);

		const from = child.connection.updates.length;
		home.model.enqueue({ content: perCharacter(`Use ${placeholder} now, and ${placeholder} again.`) });
		await child.connection.prompt({ sessionId, prompt: [{ type: "text", text: "repeat the key" }] });

		expect(chunkText(child.connection, from, "agent_message_chunk")).toBe(`Use ${SECRET} now, and ${SECRET} again.`);
		for (const { update } of child.connection.updates.slice(from)) {
			if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
				expect(update.content.text).not.toContain("$$");
			}
		}
		// The stored reply keeps its placeholders, so the next request carries them and never the value.
		home.model.enqueue({ content: ["again"] });
		await child.connection.prompt({ sessionId, prompt: [{ type: "text", text: "and once more" }] });
		const next = JSON.stringify(home.model.requests.at(-1));
		expect(next).toContain(`Use ${placeholder} now, and ${placeholder} again.`);
		expect(next).not.toContain(SECRET);
		// The session file holds the reply as the model wrote it: the placeholders, never the value.
		const persisted = persistedSessionText(home);
		expect(persisted).toContain(`Use ${placeholder} now, and ${placeholder} again.`);
		expect(persisted).not.toContain(`Use ${SECRET}`);
	});

	it("sends a placeholder split across reasoning deltas as the real value in the thought", async () => {
		const home = await contract.home({ secrets: SECRETS_YML });
		const { child, sessionId, placeholder } = await sessionKnowingSecret(home);

		const from = child.connection.updates.length;
		home.model.enqueue({ content: ["done"], thinking: perCharacter(`Checking ${placeholder} first.`) });
		await child.connection.prompt({ sessionId, prompt: [{ type: "text", text: "think about the key" }] });

		expect(chunkText(child.connection, from, "agent_thought_chunk")).toBe(`Checking ${SECRET} first.`);
		expect(chunkText(child.connection, from, "agent_message_chunk")).toBe("done");
	});

	it("sends literal dollar signs unchanged, including a $$ and a partial name that end the reply", async () => {
		const home = await contract.home({ secrets: SECRETS_YML });
		const child = await contract.child(home);
		await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const { sessionId } = await child.connection.newSession({ cwd: home.workspace, mcpServers: [] });

		home.model.enqueue({ content: perCharacter("cost $$ and $5, tail $$AB") });
		await child.connection.prompt({ sessionId, prompt: [{ type: "text", text: "price list" }] });

		expect(chunkText(child.connection, 0, "agent_message_chunk")).toBe("cost $$ and $5, tail $$AB");
	});

	it("shows a tool call with the real value, and the tool writes the real value", async () => {
		const home = await contract.home({ secrets: SECRETS_YML });
		const { child, sessionId, placeholder } = await sessionKnowingSecret(home);

		const from = child.connection.updates.length;
		const args = JSON.stringify({ path: "note.txt", content: `token ${placeholder}` });
		home.model.enqueue({ content: [], toolCall: { name: "write", arguments: args } });
		home.model.enqueue({ content: ["saved"] });
		await child.connection.prompt({ sessionId, prompt: [{ type: "text", text: "save the token" }] });

		const toolCalls = child.connection.updates
			.slice(from)
			.map(({ update }) => update)
			.filter(update => update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update");
		const shown = JSON.stringify(toolCalls);
		expect(shown).toContain(SECRET);
		expect(shown).not.toContain(placeholder);
		expect(fs.readFileSync(path.join(home.workspace, "note.txt"), "utf8")).toBe(`token ${SECRET}`);
	});

	it("leaves streamed text exactly as written when masking is off", async () => {
		const home = await contract.home();
		const child = await contract.child(home);
		await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const { sessionId } = await child.connection.newSession({ cwd: home.workspace, mcpServers: [] });

		const reply = "literal $$ACME_AB12CD34$$ stays as written";
		home.model.enqueue({ content: perCharacter(reply) });
		await child.connection.prompt({ sessionId, prompt: [{ type: "text", text: "say it" }] });

		expect(chunkText(child.connection, 0, "agent_message_chunk")).toBe(reply);
	});
});
