import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { buildPackObfuscator } from "@oh-my-pi/pi-coding-agent/xsec/session-pack-secrets";
import { closeSessionIndex } from "@oh-my-pi/pi-coding-agent/session/session-index";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { packSession } from "@oh-my-pi/pi-coding-agent/session/session-transfer";
import { getConfigRootDir, setAgentDir } from "@oh-my-pi/pi-utils";
import { readArchiveEntries } from "@oh-my-pi/pi-utils/ar";
import { makeAssistantMessage } from "../session-manager/helpers";

const SECRET = "hunter2hunter2";

function assistant(content: unknown[]) {
	return { ...makeAssistantMessage(), content } as unknown as Parameters<SessionManager["appendMessage"]>[0];
}

describe("omp session pack --restore-secrets", () => {
	let root: string;
	let agent: string;
	let cwd: string;
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

	beforeEach(async () => {
		root = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-restore-secrets-"));
		agent = path.join(root, "agent");
		cwd = path.join(root, "project");
		fs.mkdirSync(cwd, { recursive: true });
		fs.mkdirSync(agent, { recursive: true });
		setAgentDir(agent);
	});

	afterEach(async () => {
		closeSessionIndex();
		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(path.join(getConfigRootDir(), "agent"));
			delete process.env.PI_CODING_AGENT_DIR;
		}
		await fsp.rm(root, { recursive: true, force: true });
	});

	/** A session whose model wrote placeholders everywhere the fork stores model text. */
	async function createSession(obfuscator: SecretObfuscator): Promise<{ file: string; placeholder: string }> {
		const placeholder = obfuscator.obfuscate(SECRET);
		expect(placeholder).toMatch(/^\$\$.+\$\$$/);
		const session = SessionManager.create(cwd);
		session.appendMessage({
			role: "user",
			content: `the password is ${SECRET}, literal $$FAKE_ABCD1234$$ stays`,
			timestamp: 1,
		});
		session.appendMessage(
			assistant([
				{ type: "thinking", thinking: `I will use ${placeholder}`, thinkingSignature: "sig" },
				{ type: "text", text: `Logging in with ${placeholder}.` },
				{
					type: "toolCall",
					id: "t1",
					name: "bash",
					arguments: { command: `login --pw ${placeholder}`, n: 1 },
					intent: `use ${placeholder}`,
				},
			]),
		);
		session.appendMessage({
			role: "toolResult",
			toolCallId: "t1",
			toolName: "bash",
			content: [{ type: "text", text: `ok ${SECRET}` }],
			isError: false,
			timestamp: 2,
		} as unknown as Parameters<SessionManager["appendMessage"]>[0]);
		await session.flush();
		const file = session.getSessionFile();
		if (!file) throw new Error("session has no file");
		await session.close();
		await Bun.write(
			path.join(file.slice(0, -".jsonl".length), "0-Explore.jsonl"),
			`${JSON.stringify({ type: "message", id: "s1", message: assistant([{ type: "text", text: `sub used ${placeholder}` }]) })}\n`,
		);
		return { file, placeholder };
	}

	async function journalOf(archive: string): Promise<string> {
		const members = await readArchiveEntries({ path: archive, format: "tar" });
		return new TextDecoder().decode(members.get("session.jsonl"));
	}

	it("restores model-written text in the packed copy only, and counts what it restored", async () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", content: SECRET, mode: "obfuscate" }], "key-one");
		const { file, placeholder } = await createSession(obfuscator);
		const before = await Bun.file(file).text();
		const archive = path.join(root, "out.tar");

		const packed = await packSession(file, archive, { restoreSecrets: { obfuscator } });

		expect(packed.secrets).toEqual({ restored: 5, unrestored: 0 });
		const journal = await journalOf(archive);
		expect(journal).not.toContain(placeholder);
		expect(journal).toContain(`Logging in with ${SECRET}.`);
		expect(journal).toContain(`login --pw ${SECRET}`);
		expect(journal).toContain(`use ${SECRET}`);
		expect(journal).toContain(`I will use ${SECRET}`);
		// User and tool-result text is stored as written: a placeholder-shaped literal there is not touched.
		expect(journal).toContain("literal $$FAKE_ABCD1234$$ stays");
		expect(journal).toContain(`ok ${SECRET}`);
		// The subagent transcript is restored too, and the local journal is untouched.
		const members = await readArchiveEntries({ path: archive, format: "tar" });
		expect(new TextDecoder().decode(members.get("artifacts/0-Explore.jsonl"))).toContain(`sub used ${SECRET}`);
		expect(await Bun.file(file).text()).toBe(before);
	});

	it("packs byte for byte without the option", async () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", content: SECRET, mode: "obfuscate" }], "key-one");
		const { file, placeholder } = await createSession(obfuscator);
		const archive = path.join(root, "plain.tar");
		const packed = await packSession(file, archive);
		expect(packed.secrets).toBeUndefined();
		expect(await journalOf(archive)).toBe(await Bun.file(file).text());
		expect(await journalOf(archive)).toContain(placeholder);
	});

	it("leaves placeholders it cannot resolve and reports them", async () => {
		const sender = new SecretObfuscator([{ type: "plain", content: SECRET, mode: "obfuscate" }], "key-one");
		const { file, placeholder } = await createSession(sender);
		const otherKey = new SecretObfuscator(
			[{ type: "plain", content: "another-secret-1", mode: "obfuscate" }],
			"key-two",
		);
		const archive = path.join(root, "unresolved.tar");

		const packed = await packSession(file, archive, { restoreSecrets: { obfuscator: otherKey } });
		expect(packed.secrets).toEqual({ restored: 0, unrestored: 5 });
		expect(await journalOf(archive)).toContain(placeholder);

		const none = path.join(root, "none.tar");
		const withoutRules = await packSession(file, none, { restoreSecrets: { obfuscator: undefined } });
		expect(withoutRules.secrets).toEqual({ restored: 0, unrestored: 5 });
	});

	it("builds the obfuscator from the profile's secrets.yml", async () => {
		await Bun.write(path.join(agent, "secrets.yml"), `- type: plain\n  content: ${SECRET}\n  mode: obfuscate\n`);
		const obfuscator = await buildPackObfuscator(await sessionFileWith(), undefined);
		expect(obfuscator?.hasSecrets()).toBe(true);
		const placeholder = obfuscator?.obfuscate(SECRET) ?? "";
		expect(obfuscator?.deobfuscate(`x ${placeholder}`)).toBe(`x ${SECRET}`);
	});

	async function sessionFileWith(): Promise<string> {
		const session = SessionManager.create(cwd);
		session.appendMessage({ role: "user", content: "hi", timestamp: 1 });
		// A session reaches disk only once it has an assistant message.
		session.appendMessage(assistant([{ type: "text", text: "hello" }]));
		await session.flush();
		const file = session.getSessionFile();
		if (!file) throw new Error("session has no file");
		await session.close();
		return file;
	}
});
