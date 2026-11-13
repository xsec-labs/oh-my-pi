import { describe, expect, it, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type AcpChild, agentMessageText, type ContractHome, useContractSession } from "./harness";

setDefaultTimeout(120_000);

const contract = useContractSession();

/** A made-up value of the kind a secret rule matches. It reaches a request only if masking misses it. */
const SECRET = "ASYNC-PROBE-KEY-7731";
/** Appears only in the sub-agent's task, so the fake model can route the sub-agent's request by it. */
const SUBAGENT_MARKER = "async probe sub-agent marker";
/**
 * The end of the sentence that opens the message carrying a finished single job's result. The session writes that
 * message with `attribution: "agent"`, so it is the harness's own text, not the user's.
 */
const RESULT_MARKER = "has completed.";
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

/** The job's output as the result message carries it: the text between the result marker and the next output block. */
function jobOutputOf(home: ContractHome, index: number): string {
	const raw = home.model.rawRequests[index] ?? "";
	const start = raw.indexOf("<output>", raw.indexOf(RESULT_MARKER));
	const end = raw.indexOf("</output>", start);
	return start < 0 || end < 0 ? "" : raw.slice(start, end);
}

/**
 * Waits until `/jobs` lists no running job. The session answers `/jobs` itself, so each ask costs no model request,
 * and each ask reads only the text the session sent in reply to it. The reply's header counts the running jobs
 * (`Running: N`), and an empty list reads `No background jobs running`.
 */
async function waitForJobsToFinish(child: AcpChild, sessionId: string): Promise<void> {
	for (;;) {
		const before = agentMessageText(child.connection).length;
		await child.connection.prompt({ sessionId, prompt: [{ type: "text", text: "/jobs" }] });
		const reply = agentMessageText(child.connection).slice(before);
		if (reply.length === 0) throw new Error("/jobs sent no reply");
		if (reply.includes("No background jobs running") || /^Running: 0$/m.test(reply)) return;
		await Bun.sleep(20);
	}
}

/**
 * One session in which a background sub-agent answers with the key, and a second turn receives its result.
 * The sub-agent answers one character at a time with the placeholder the session wrote for the key, or with the
 * key itself when secrets are off. The test waits for the sub-agent's request, then for its job to finish, then
 * sends the second turn, so the result reaches that turn's request.
 */
async function runAsyncResult(secretsEnabled: boolean) {
	const home = await contract.home({ secretsEnabled });
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

	home.model.route(SUBAGENT_MARKER, {
		content: () => [...(secretsEnabled ? keyPlaceholder(home) : SECRET)],
	});
	home.model.enqueue({
		content: [],
		toolCall: {
			name: "task",
			arguments: JSON.stringify({ task: `${SUBAGENT_MARKER}: report the key` }),
		},
	});
	home.model.enqueue({ content: ["spawned, waiting"] });
	await child.connection.prompt({ sessionId, prompt: [{ type: "text", text: `the key is ${SECRET}` }] });
	await home.model.waitForUserText(SUBAGENT_MARKER, 1);
	await waitForJobsToFinish(child, sessionId);

	home.model.enqueue({ content: ["nothing yet"] });
	await child.connection.prompt({ sessionId, prompt: [{ type: "text", text: "any results yet" }] });
	await home.model.waitForText(RESULT_MARKER, 1);
	const [resultIndex] = requestsCarrying(home, RESULT_MARKER);
	if (resultIndex === undefined) throw new Error("the async result reached no request");
	return { home, resultIndex };
}

describe("async job results with secrets on", () => {
	it("keeps the real value out of every request body, the async result's included", async () => {
		const run = await runAsyncResult(true);

		expect(requestsCarrying(run.home, SECRET)).toEqual([]);
		// The job's output reached the result request as the placeholder the session wrote for the key.
		expect(jobOutputOf(run.home, run.resultIndex)).toContain(keyPlaceholder(run.home));
		expect(jobOutputOf(run.home, run.resultIndex)).toMatch(PLACEHOLDER);
	});
});

describe("async job results with secrets off", () => {
	it("control: the async result's request carries the real value", async () => {
		const run = await runAsyncResult(false);

		// Without this control, the case above could pass because the result never carried the key.
		expect(requestsCarrying(run.home, SECRET)).toContain(run.resultIndex);
		expect(jobOutputOf(run.home, run.resultIndex)).toContain(SECRET);
	});
});
