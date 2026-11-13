import { describe, expect, it, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type ContractHome, useContractSession } from "./harness";

setDefaultTimeout(120_000);

const contract = useContractSession();

/** The folder the session runs in. Its name is the value the secret rule matches, and the date/cwd reminder carries it. */
const CLIENT_FOLDER = "Tessel-Harbor-Quill";
/** A placeholder as the session writes it: a key, an optional hint, and `$$` on both sides. */
const PLACEHOLDER = /\$\$(?:[A-Z0-9]+_)?[A-Z0-9]{4,}(?::[ULCM])?\$\$/;

/** The indexes of the captured request bodies whose exact bytes contain `marker`. */
function requestsCarrying(home: ContractHome, marker: string): number[] {
	const needle = Buffer.from(marker, "utf8");
	return home.model.rawRequests.flatMap((raw, index) => (Buffer.from(raw, "utf8").includes(needle) ? [index] : []));
}

/**
 * One session begun with secrets off, then resumed by a second child. The first turn journals the date/cwd reminder with the
 * real folder name. The resume turns secrets on (with a plain entry for the folder name) unless `resumeWithSecrets` is false.
 * Returns the home and the index of the first request the resumed child sent.
 */
async function resumeSession(resumeWithSecrets: boolean): Promise<{ home: ContractHome; resumedFrom: number }> {
	const home = await contract.home({ secretsEnabled: false });
	const projectDir = path.join(home.base, "clients", CLIENT_FOLDER, "project");
	fs.mkdirSync(projectDir, { recursive: true });

	const first = await contract.child(home);
	await first.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
	const { sessionId } = await first.connection.newSession({ cwd: projectDir, mcpServers: [] });
	home.model.enqueue({ content: ["noted"] });
	await first.connection.prompt({ sessionId, prompt: [{ type: "text", text: "the first turn" }] });
	await first.close();
	// The first request is the one whose reminder the session journals: it carries the real folder name.
	expect(requestsCarrying(home, CLIENT_FOLDER)).not.toEqual([]);

	if (resumeWithSecrets) {
		fs.writeFileSync(
			path.join(home.env.PI_CODING_AGENT_DIR!, "secrets.yml"),
			`- type: plain\n  content: ${CLIENT_FOLDER}\n  friendlyName: client\n`,
		);
		const config = fs.readFileSync(home.configPath, "utf8");
		fs.writeFileSync(home.configPath, config.replace("secrets:\n  enabled: false", "secrets:\n  enabled: true"));
	}

	const resumedFrom = home.model.requests.length;
	const second = await contract.child(home);
	await second.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
	await second.connection.loadSession({ sessionId, cwd: projectDir, mcpServers: [] });
	home.model.enqueue({ content: ["still noted"] });
	await second.connection.prompt({ sessionId, prompt: [{ type: "text", text: "the resumed turn" }] });
	return { home, resumedFrom };
}

describe("a session begun with secrets off, resumed with secrets on", () => {
	it("sends the replayed date/cwd reminder with the folder name masked, in every request after the resume", async () => {
		const { home, resumedFrom } = await resumeSession(true);

		// The replayed reminder reaches the first request after the resume with the folder name as a placeholder.
		expect(home.model.rawRequests[resumedFrom]).toMatch(PLACEHOLDER);
		expect(requestsCarrying(home, CLIENT_FOLDER).filter(index => index >= resumedFrom)).toEqual([]);
	});
});

describe("control: the same resume with secrets off", () => {
	it("sends the folder name after the resume, so the replay the test above masks is really sent", async () => {
		const { home, resumedFrom } = await resumeSession(false);

		expect(requestsCarrying(home, CLIENT_FOLDER).some(index => index >= resumedFrom)).toBe(true);
	});
});
