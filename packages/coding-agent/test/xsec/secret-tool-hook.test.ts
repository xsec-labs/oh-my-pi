import { describe, expect, it } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Type } from "@oh-my-pi/omptype/typebox";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import { bindHookSecrets } from "@oh-my-pi/pi-coding-agent/xsec/secret-tool-hook";

/** A made-up credential. Only this file's obfuscator knows it. */
const SECRET = "xsk_unit_4b9e0c7a1d6f83e25a02";

/** A tool that records the arguments it runs with. */
function recordingTool(ran: unknown[]): AgentTool {
	return {
		name: "write",
		label: "write",
		description: "records the arguments it is given",
		parameters: Type.Object({ path: Type.String(), content: Type.String() }),
		async execute(_toolCallId: string, params: Record<string, unknown>) {
			ran.push(params);
			return { content: [{ type: "text", text: "ok" }], details: undefined };
		},
	} as unknown as AgentTool;
}

/** The tool context of a call made outside the loop: approval comes from settings, and nothing can be asked. */
function directCallContext(): never {
	return { settings: Settings.isolated({ "tools.approvalMode": "yolo" }) } as never;
}

/** A runner whose `tool_call` handler records the input it sees and lets the call run. */
function runnerRecording(seen: unknown[]): ExtensionRunner {
	return {
		hasHandlers: (event: string) => event === "tool_call",
		consumeLoopToolCall: () => false,
		consumeToolCallEmitted: () => false,
		hasSessionApproval: () => false,
		hasUI: () => false,
		async emitToolCall(event: { input: unknown }) {
			seen.push(event.input);
			return undefined;
		},
		sessionId: "secret-tool-hook-unit",
		runScoped<T>(fn: () => T): T {
			return fn();
		},
	} as unknown as ExtensionRunner;
}

describe("secrets on a tool call the loop did not dispatch", () => {
	it("restores the placeholder before the hook and the tool see the call", async () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", content: SECRET, mode: "obfuscate" }], "unit-key");
		const placeholder = obfuscator.obfuscate(SECRET);
		const seen: unknown[] = [];
		const ran: unknown[] = [];
		const runner = runnerRecording(seen);
		bindHookSecrets(runner, () => obfuscator);
		const wrapped = new ExtensionToolWrapper(recordingTool(ran), runner);

		await wrapped.execute(
			"call-direct",
			{ path: "deploy.txt", content: placeholder },
			undefined,
			undefined,
			directCallContext(),
		);

		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ content: SECRET });
		expect(ran).toEqual([{ path: "deploy.txt", content: SECRET }]);
	});

	it("passes the placeholder through when no session bound secrets to the runner", async () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", content: SECRET, mode: "obfuscate" }], "unit-key");
		const placeholder = obfuscator.obfuscate(SECRET);
		const seen: unknown[] = [];
		const ran: unknown[] = [];
		const wrapped = new ExtensionToolWrapper(recordingTool(ran), runnerRecording(seen));

		await wrapped.execute(
			"call-unbound",
			{ path: "deploy.txt", content: placeholder },
			undefined,
			undefined,
			directCallContext(),
		);

		expect(seen[0]).toMatchObject({ content: placeholder });
		expect(ran).toEqual([{ path: "deploy.txt", content: placeholder }]);
	});
});
