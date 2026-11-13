import { describe, expect, it, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { agentMessageText, type ContractHome, useContractSession, userMessageTexts } from "./harness";

setDefaultTimeout(120_000);

const contract = useContractSession();

/** A project folder named after a client. The name is made up for this test. */
const CLIENT_FOLDER = "Tessel-Harbor-Quill";
/** Where the date/cwd reminder states the working directory, on the first user turn. */
const REMINDER_CWD = /current working directory: '([^']*)'/;

/** The indexes of the captured request bodies whose exact bytes contain `marker`. */
function requestsCarrying(home: ContractHome, marker: string): number[] {
	const needle = Buffer.from(marker, "utf8");
	return home.model.rawRequests.flatMap((raw, index) => (Buffer.from(raw, "utf8").includes(needle) ? [index] : []));
}

/**
 * One session with two turns and one tool call. The first turn shows the model the working directory it
 * is given; the second has the model write a file through that directory as it appears to the model.
 */
async function runSession(secretsYaml: string) {
	const home = await contract.home({ secretsEnabled: true });
	fs.writeFileSync(path.join(home.env.PI_CODING_AGENT_DIR!, "secrets.yml"), secretsYaml);
	const projectDir = path.join(home.base, "clients", CLIENT_FOLDER, "project");
	fs.mkdirSync(projectDir, { recursive: true });
	// A project context file puts the working directory into the system prompt as well.
	fs.writeFileSync(path.join(projectDir, "AGENTS.md"), "# Project notes\n\nReply briefly.\n");
	const child = await contract.child(home);
	await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
	const { sessionId } = await child.connection.newSession({ cwd: projectDir, mcpServers: [] });

	home.model.enqueue({ content: ["noted"] });
	await child.connection.prompt({ sessionId, prompt: [{ type: "text", text: "remember the project" }] });
	const shownDir = REMINDER_CWD.exec(userMessageTexts(home.model.requests[0]).join("\n"))?.[1];
	if (shownDir === undefined) throw new Error("the first request carries no working directory reminder");

	const target = `${shownDir}/written-by-model.txt`;
	home.model.enqueue({
		content: [],
		toolCall: { name: "write", arguments: JSON.stringify({ path: target, content: "written by the model" }) },
	});
	home.model.enqueue({ content: ["written"] });
	const response = await child.connection.prompt({ sessionId, prompt: [{ type: "text", text: "write the file" }] });
	return { home, child, projectDir, shownDir, stopReason: response.stopReason };
}

describe("working directory masking with secrets enabled", () => {
	it("keeps a plain entry matching the folder name out of every request body", async () => {
		const run = await runSession(`- type: plain\n  content: ${CLIENT_FOLDER}\n  friendlyName: client\n`);

		expect(run.stopReason).toBe("end_turn");
		expect(requestsCarrying(run.home, CLIENT_FOLDER)).toEqual([]);
		expect(run.shownDir).not.toContain(CLIENT_FOLDER);
	});

	it("keeps a regex entry matching part of the folder name out of every request body", async () => {
		const matched = "Tessel-Harbor";
		const run = await runSession(`- type: regex\n  content: "Tessel-[A-Za-z]+"\n  friendlyName: client\n`);

		expect(run.stopReason).toBe("end_turn");
		expect(requestsCarrying(run.home, matched)).toEqual([]);
		expect(run.shownDir).not.toContain(matched);
	});

	it("runs the tool call that uses the masked path in the real directory and shows the real path to the client", async () => {
		const run = await runSession(`- type: plain\n  content: ${CLIENT_FOLDER}\n  friendlyName: client\n`);

		const realTarget = path.join(run.projectDir, "written-by-model.txt");
		expect(fs.readFileSync(realTarget, "utf8")).toBe("written by the model");
		// ACP reports a path with forward slashes on every platform, so the real path is compared in that spelling.
		expect(JSON.stringify(run.child.connection.updates)).toContain(realTarget.split(path.sep).join("/"));
		expect(agentMessageText(run.child.connection)).toContain("written");
	});
});

/** The text of the sub-agent's task. The fake model holds the sub-agent's request on it, so the test can read that request. */
const SUBAGENT_TEXT = "sub-agent probe for the masking contract";

/**
 * One session that starts one sub-agent. The sub-agent's request is held open, so it stays in the captured bodies while
 * the test reads them. `secretsYaml` undefined runs the session with secrets disabled.
 */
async function runSubagentSession(secretsYaml: string | undefined) {
	const home = await contract.home({ secretsEnabled: secretsYaml !== undefined, workerThreads: 0 });
	if (secretsYaml !== undefined)
		fs.writeFileSync(path.join(home.env.PI_CODING_AGENT_DIR!, "secrets.yml"), secretsYaml);
	const projectDir = path.join(home.base, "clients", CLIENT_FOLDER, "project");
	fs.mkdirSync(projectDir, { recursive: true });
	fs.writeFileSync(path.join(projectDir, "AGENTS.md"), "# Project notes\n\nReply briefly.\n");
	const child = await contract.child(home);
	await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
	const { sessionId } = await child.connection.newSession({ cwd: projectDir, mcpServers: [] });

	home.model.enqueue({ content: ["noted"] });
	await child.connection.prompt({ sessionId, prompt: [{ type: "text", text: "remember the project" }] });

	// The batch runs in the background, so the turn that starts it ends before the sub-agent sends anything.
	home.model.route(SUBAGENT_TEXT, { content: [], hold: true });
	home.model.enqueue({
		content: [],
		toolCall: {
			name: "task",
			arguments: JSON.stringify({
				context: "contract test: the run answers in one sentence",
				tasks: [{ name: "probe", task: SUBAGENT_TEXT, solutionSpace: "one short sentence" }],
			}),
		},
	});
	home.model.enqueue({ content: ["the sub-agent is started"] });
	await child.connection.prompt({ sessionId, prompt: [{ type: "text", text: "run the sub-agent" }] });
	await home.model.waitForUserText(SUBAGENT_TEXT, 1);

	const index = home.model.requests.findIndex(body =>
		userMessageTexts(body).some(text => text.includes(SUBAGENT_TEXT)),
	);
	if (index < 0) throw new Error("the sub-agent sent no request");
	return { home, index };
}

describe("working directory masking in a sub-agent request", () => {
	it("keeps a plain entry matching the folder name out of every request body, the sub-agent's included", async () => {
		const run = await runSubagentSession(`- type: plain\n  content: ${CLIENT_FOLDER}\n  friendlyName: client\n`);

		expect(requestsCarrying(run.home, CLIENT_FOLDER)).toEqual([]);
	});

	it("keeps a regex entry matching part of the folder name out of every request body, the sub-agent's included", async () => {
		const run = await runSubagentSession(`- type: regex\n  content: "Tessel-[A-Za-z]+"\n  friendlyName: client\n`);

		expect(requestsCarrying(run.home, "Tessel-Harbor")).toEqual([]);
	});

	it("control: with secrets disabled, the sub-agent's request carries the folder name", async () => {
		const run = await runSubagentSession(undefined);

		// The cases above only test masking if the sub-agent's request carries the folder name when nothing is masked.
		expect(requestsCarrying(run.home, CLIENT_FOLDER)).toContain(run.index);
	});
});

describe("working directory with secrets disabled", () => {
	it("sends the real working directory, as before", async () => {
		const home = await contract.home({ secretsEnabled: false });
		const projectDir = path.join(home.base, "clients", CLIENT_FOLDER, "project");
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(path.join(projectDir, "AGENTS.md"), "# Project notes\n\nReply briefly.\n");
		const child = await contract.child(home);
		await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const { sessionId } = await child.connection.newSession({ cwd: projectDir, mcpServers: [] });
		home.model.enqueue({ content: ["noted"] });
		await child.connection.prompt({ sessionId, prompt: [{ type: "text", text: "remember the project" }] });

		// The first request carries the folder name in the system prompt and in the reminder: nothing is masked.
		expect(requestsCarrying(home, CLIENT_FOLDER)).toEqual([0]);
	});
});
