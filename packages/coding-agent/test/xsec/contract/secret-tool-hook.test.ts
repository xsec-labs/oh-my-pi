import { describe, expect, it, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import {
	type AcpChild,
	type ContractHome,
	type ExtensionBridge,
	startExtensionBridge,
	toolResultTexts,
	useContractSession,
} from "./harness";

setDefaultTimeout(120_000);

const contract = useContractSession();
const APPROVAL_GATE = path.join(import.meta.dir, "fixtures", "approval-gate.ts");

/** A made-up credential: the only secret these tests configure. No request the model receives may carry it. */
const SECRET = "xsk_contract_7d41c9e2f0b8a63d5e19";

/** The arguments of a `write` call that creates `filePath` with `content`. */
function writeArguments(filePath: string, content: string): string {
	return JSON.stringify({ path: filePath, content });
}

/** The placeholder the model was given for the secret: the `$$...$$` token in a request's user messages. */
function placeholderIn(body: unknown): string | undefined {
	const messages = isRecord(body) && Array.isArray(body.messages) ? body.messages : [];
	const userText = messages
		.filter((message: unknown) => isRecord(message) && message.role === "user")
		.map((message: unknown) => JSON.stringify(isRecord(message) ? message.content : ""))
		.join("\n");
	return /\$\$[A-Z0-9_]+(?::[ULCM])?\$\$/.exec(userText)?.[0];
}

/** The arguments of every `write` call an assistant message records in the session files, in file order. */
function recordedWriteCalls(base: string): unknown[] {
	const calls: unknown[] = [];
	for (const file of fs.readdirSync(base, { recursive: true }) as string[]) {
		if (!file.endsWith(".jsonl")) continue;
		for (const line of fs.readFileSync(path.join(base, file), "utf8").split("\n")) {
			if (line.trim() === "") continue;
			const entry = JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } };
			if (entry.type !== "message" || entry.message?.role !== "assistant") continue;
			if (!Array.isArray(entry.message.content)) continue;
			for (const block of entry.message.content as { type?: string; name?: string; arguments?: unknown }[]) {
				if (block.type === "toolCall" && block.name === "write") calls.push(block.arguments);
			}
		}
	}
	return calls;
}

/** Starts an `omp acp` child that loads the approval gate, which asks `bridge` about every tool call. */
async function gatedSession(home: ContractHome, bridge: ExtensionBridge) {
	const child = await contract.child(home, {
		args: ["--extension", APPROVAL_GATE],
		env: { XSEC_CONTRACT_BRIDGE_URL: bridge.url },
	});
	await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
	const { sessionId } = await child.connection.newSession({ cwd: home.workspace, mcpServers: [] });
	return { child, sessionId };
}

/** Sends the secret once, so the model has been given its placeholder, and returns that placeholder. */
async function shareSecret(home: ContractHome, child: AcpChild, sessionId: string): Promise<string> {
	home.model.enqueue({ content: ["noted"] });
	await child.connection.prompt({ sessionId, prompt: [{ type: "text", text: `the deploy token is ${SECRET}` }] });
	const placeholder = home.model.requests.map(placeholderIn).find(found => found !== undefined);
	if (placeholder === undefined) throw new Error("no request carried the placeholder for the secret");
	return placeholder;
}

describe("secrets at the tool_call hook", () => {
	it("hands the hook the real value, and the tool runs with it", async () => {
		const home = await contract.home({ secrets: { enabled: true, values: [SECRET] } });
		const bridge = startExtensionBridge();
		try {
			const { child, sessionId } = await gatedSession(home, bridge);
			const placeholder = await shareSecret(home, child, sessionId);
			home.model.enqueue({
				content: [],
				toolCall: { name: "write", arguments: writeArguments("deploy.txt", placeholder) },
			});
			home.model.enqueue({ content: ["written"] });
			const response = await child.connection.prompt({
				sessionId,
				prompt: [{ type: "text", text: "write the token to deploy.txt" }],
			});

			expect(response.stopReason).toBe("end_turn");
			expect(bridge.approvals).toHaveLength(1);
			expect(bridge.approvals[0]).toMatchObject({ toolName: "write", input: { content: SECRET } });
			expect(fs.readFileSync(path.join(home.workspace, "deploy.txt"), "utf8")).toBe(SECRET);
		} finally {
			bridge.stop();
		}
	});

	it("records a revised input in the transcript as a placeholder, and runs it with the real value", async () => {
		const home = await contract.home({ secrets: { enabled: true, values: [SECRET] } });
		const bridge = startExtensionBridge();
		try {
			const { child, sessionId } = await gatedSession(home, bridge);
			const placeholder = await shareSecret(home, child, sessionId);
			bridge.decide = () => ({ allow: true, input: { path: "revised.txt", content: SECRET } });
			home.model.enqueue({
				content: [],
				toolCall: { name: "write", arguments: writeArguments("deploy.txt", placeholder) },
			});
			home.model.enqueue({ content: ["written"] });
			const response = await child.connection.prompt({
				sessionId,
				prompt: [{ type: "text", text: "write the token to deploy.txt" }],
			});

			expect(response.stopReason).toBe("end_turn");
			expect(fs.existsSync(path.join(home.workspace, "deploy.txt"))).toBe(false);
			expect(fs.readFileSync(path.join(home.workspace, "revised.txt"), "utf8")).toBe(SECRET);
			// The loop writes the revision into the assistant message it persists: the placeholder, not the value.
			expect(recordedWriteCalls(home.base)).toEqual([{ path: "revised.txt", content: placeholder }]);
			expect(home.model.requests.some(body => JSON.stringify(body).includes(SECRET))).toBe(false);
		} finally {
			bridge.stop();
		}
	});

	it("blocks a call whose refusal quotes the real value, and no request carries the value", async () => {
		const home = await contract.home({ secrets: { enabled: true, values: [SECRET] } });
		const bridge = startExtensionBridge();
		try {
			const { child, sessionId } = await gatedSession(home, bridge);
			const placeholder = await shareSecret(home, child, sessionId);
			bridge.decide = () => ({ allow: false, reason: `the contract gate refused ${SECRET}` });
			home.model.enqueue({
				content: [],
				toolCall: { name: "write", arguments: writeArguments("deploy.txt", placeholder) },
			});
			home.model.enqueue({ content: ["the write was refused"] });
			const response = await child.connection.prompt({
				sessionId,
				prompt: [{ type: "text", text: "write the token to deploy.txt" }],
			});

			expect(response.stopReason).toBe("end_turn");
			expect(fs.existsSync(path.join(home.workspace, "deploy.txt"))).toBe(false);
			expect(home.model.requests.some(body => toolResultTexts(body).some(text => text.includes("refused")))).toBe(
				true,
			);
			expect(home.model.requests.some(body => JSON.stringify(body).includes(SECRET))).toBe(false);
		} finally {
			bridge.stop();
		}
	});

	it("passes the hook the arguments as the model wrote them when secrets are off", async () => {
		const home = await contract.home({ secrets: { enabled: false, values: [SECRET] } });
		const bridge = startExtensionBridge();
		try {
			const { child, sessionId } = await gatedSession(home, bridge);
			// Nothing is restored with secrets off, so text shaped like a placeholder reaches the hook unchanged.
			const written = "$$CONTRACTSECRET_0A1B2C3D4E5F$$ is written as the model wrote it";
			home.model.enqueue({
				content: [],
				toolCall: { name: "write", arguments: writeArguments("plain.txt", written) },
			});
			home.model.enqueue({ content: ["written"] });
			const response = await child.connection.prompt({
				sessionId,
				prompt: [{ type: "text", text: "write plain.txt" }],
			});

			expect(response.stopReason).toBe("end_turn");
			expect(bridge.approvals).toHaveLength(1);
			expect(bridge.approvals[0]).toMatchObject({ toolName: "write", input: { content: written } });
			expect(fs.readFileSync(path.join(home.workspace, "plain.txt"), "utf8")).toBe(written);
		} finally {
			bridge.stop();
		}
	});

	it("shows the client the real command in its permission request", async () => {
		const home = await contract.home({ secrets: { enabled: true, values: [SECRET] } });
		const child = await contract.child(home);
		await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const { sessionId } = await child.connection.newSession({ cwd: home.workspace, mcpServers: [] });
		const placeholder = await shareSecret(home, child, sessionId);
		home.model.enqueue({
			content: [],
			toolCall: { name: "bash", arguments: JSON.stringify({ command: `echo ${placeholder}` }) },
		});
		home.model.enqueue({ content: ["the command was not run"] });
		const response = await child.connection.prompt({
			sessionId,
			prompt: [{ type: "text", text: "run the command" }],
		});

		expect(response.stopReason).toBe("end_turn");
		// The client answers "cancelled", so the command does not run; the request still shows what would have.
		expect(child.connection.permissions).toHaveLength(1);
		expect(child.connection.permissions[0]?.toolCall.rawInput).toMatchObject({ command: `echo ${SECRET}` });
	});
});
