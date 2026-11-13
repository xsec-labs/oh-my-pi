import { describe, expect, it, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type AcpChild, agentMessageText, type ContractHome, useContractSession } from "./harness";

setDefaultTimeout(120_000);

const contract = useContractSession();

/** A made-up value of the kind a secret rule matches. It reaches a request only if masking misses it. */
const SECRET = "SIDE-PROBE-KEY-4412";
/** A placeholder as the session writes it: a key, an optional hint, and `$$` on both sides. */
const PLACEHOLDER = /\$\$(?:[A-Z0-9]+_)?[A-Z0-9]{4,}(?::[ULCM])?\$\$/;

/** The indexes of the captured request bodies whose exact bytes contain `marker`. */
function requestsCarrying(home: ContractHome, marker: string): number[] {
	const needle = Buffer.from(marker, "utf8");
	return home.model.rawRequests.flatMap((raw, index) => (Buffer.from(raw, "utf8").includes(needle) ? [index] : []));
}

/** The placeholder the session wrote for the key, as the first request's user message carries it. */
function keyPlaceholder(home: ContractHome): string {
	const match = /the key is (\$\$(?:[A-Z0-9]+_)?[A-Z0-9]{4,}(?::[ULCM])?\$\$)/.exec(home.model.rawRequests[0] ?? "");
	if (match?.[1] === undefined) throw new Error("the first request carries no placeholder for the key");
	return match[1];
}

/** Waits until the client has received one of `needles` in agent message text, and returns all of that text. */
async function waitForAgentText(child: AcpChild, needles: string[]): Promise<string> {
	for (;;) {
		const text = agentMessageText(child.connection);
		if (needles.some(needle => text.includes(needle))) return text;
		await Bun.sleep(20);
	}
}

interface Session {
	home: ContractHome;
	child: AcpChild;
	sessionId: string;
}

/**
 * One session whose first turn says the key, with secrets on or off. The model answers that turn with "noted".
 * `compactionKeepRecentTokens` sets how much recent history a compaction keeps verbatim; a short history needs a small value.
 */
async function startSession(secretsEnabled: boolean, compactionKeepRecentTokens?: number): Promise<Session> {
	const home = await contract.home({ secretsEnabled, compactionKeepRecentTokens });
	if (secretsEnabled) {
		fs.writeFileSync(
			path.join(home.env.PI_CODING_AGENT_DIR!, "secrets.yml"),
			`- type: plain\n  content: ${SECRET}\n  friendlyName: key\n`,
		);
	}
	const projectDir = path.join(home.base, "clients", "project");
	fs.mkdirSync(projectDir, { recursive: true });
	fs.writeFileSync(path.join(projectDir, "AGENTS.md"), "# Project notes\n\nReply briefly.\n");
	const child = await contract.child(home);
	await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
	const { sessionId } = await child.connection.newSession({ cwd: projectDir, mcpServers: [] });
	const session = { home, child, sessionId };
	await turn(session, `the key is ${SECRET}`, "noted");
	return session;
}

/** One prompt turn whose model answer is `reply`. */
async function turn(session: Session, text: string, reply: string): Promise<void> {
	session.home.model.enqueue({ content: [reply] });
	await session.child.connection.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text }] });
}

describe("title generation with secrets on", () => {
	it("sends the first message to the title model masked, and shows the title with the real value", async () => {
		const session = await startSession(true);
		// The title model answers with the placeholder the session wrote for the key. The session restores it, so the
		// client receives the real value in the title.
		session.home.model.enqueue({ content: [keyPlaceholder(session.home)] });
		await session.child.connection.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "/rename" }],
		});
		const text = await waitForAgentText(session.child, ["Session renamed to", "Could not generate", "Rename failed"]);

		expect(text).toContain(`Session renamed to ${SECRET}.`);
		expect(requestsCarrying(session.home, SECRET)).toEqual([]);
	});
});

describe("title generation with secrets off", () => {
	it("control: the title request carries the real value", async () => {
		const session = await startSession(false);
		const before = session.home.model.requests.length;
		session.home.model.enqueue({ content: ["A short title"] });
		await session.child.connection.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "/rename" }],
		});
		await waitForAgentText(session.child, ["Session renamed to", "Could not generate", "Rename failed"]);

		// The first turn carries the real value too, so only a request made by /rename shows the control.
		expect(requestsCarrying(session.home, SECRET).some(index => index >= before)).toBe(true);
	});
});

describe("compaction with secrets on", () => {
	it("sends the conversation to the compaction request masked", async () => {
		const session = await startSession(true, 1);
		await turn(session, "any results yet", "still noted");
		await turn(session, "one more thing", "also noted");
		const before = session.home.model.requests.length;
		session.home.model.enqueue({ content: ["A summary of the conversation"] });
		await session.child.connection.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "/compact soft" }],
		});

		expect(session.home.model.requests.length).toBeGreaterThan(before);
		expect(requestsCarrying(session.home, SECRET)).toEqual([]);
		// The first request /compact makes summarizes the conversation with the key as the placeholder the session wrote
		// for it. Later requests of the same compaction summarize other parts, so they are not checked here.
		expect(session.home.model.rawRequests[before]).toMatch(PLACEHOLDER);
	});
});

describe("compaction with secrets off", () => {
	it("control: the compaction request carries the real value", async () => {
		const session = await startSession(false, 1);
		await turn(session, "any results yet", "still noted");
		await turn(session, "one more thing", "also noted");
		const before = session.home.model.requests.length;
		session.home.model.enqueue({ content: ["A summary of the conversation"] });
		await session.child.connection.prompt({
			sessionId: session.sessionId,
			prompt: [{ type: "text", text: "/compact soft" }],
		});

		expect(session.home.model.requests.length).toBeGreaterThan(before);
		// The earlier turns carry the real value too, so only a request made by /compact shows the control.
		expect(requestsCarrying(session.home, SECRET).some(index => index >= before)).toBe(true);
	});
});
