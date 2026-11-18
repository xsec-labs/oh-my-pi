import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import type { Context, Message, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { SecretObfuscator } from "../../src/secrets";
import { DEFAULT_MIN_OBFUSCATE_LENGTH, setMinObfuscateLength } from "../../src/xsec/secret-min-length";
import { maskOutboundContext, maskOutboundMessages } from "../../src/xsec/outbound-context";
import {
	DERIVED_VALUE_MARKER,
	DERIVED_VALUE_NOTICE,
	maskDerivedText,
	withDerivedValueNotice,
} from "../../src/xsec/secret-derived-forms";

// Desktop starts OMP with `secrets.minObfuscateLength: 1`, so a five-character password is masked.
beforeAll(() => setMinObfuscateLength(1));
afterAll(() => setMinObfuscateLength(DEFAULT_MIN_OBFUSCATE_LENGTH));

/** Made-up five-character password, the length that a digest lets anyone brute-force. */
const PASSWORD = "Tk4#z";

function obfuscator(content = PASSWORD): SecretObfuscator {
	return new SecretObfuscator([{ type: "plain", content, mode: "obfuscate" }]);
}

const digest = (algorithm: string, input: string | Buffer): Buffer =>
	crypto.createHash(algorithm).update(input).digest();

function toolResult(text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "call_1",
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	};
}

function resultText(messages: Message[]): string {
	const message = messages[0];
	if (message?.role !== "toolResult") throw new Error("expected a tool result");
	return message.content.map(block => (block.type === "text" ? block.text : "")).join("");
}

/** Every derived form of the password that the pass promises to mask, by name. */
function forms(secret: string): Record<string, string> {
	const bytes = Buffer.from(secret);
	const withNewline = Buffer.concat([bytes, Buffer.from("\n")]);
	return {
		"sha256 hex": digest("sha256", bytes).toString("hex"),
		"sha256 hex, uppercase": digest("sha256", bytes).toString("hex").toUpperCase(),
		"sha256 of the value and a newline": digest("sha256", withNewline).toString("hex"),
		"sha256 prefix, 8 bytes": digest("sha256", bytes).toString("hex").slice(0, 16),
		"sha256 prefix, 8 characters": digest("sha256", bytes).toString("hex").slice(0, 8),
		"sha256 suffix": digest("sha256", bytes).toString("hex").slice(-12),
		"sha256 base64": digest("sha256", bytes).toString("base64"),
		"sha1 hex": digest("sha1", bytes).toString("hex"),
		"md5 hex": digest("md5", bytes).toString("hex"),
		"sha512 prefix": digest("sha512", bytes).toString("hex").slice(0, 20),
		base64: bytes.toString("base64"),
		"base64 without padding": bytes.toString("base64").replace(/=+$/, ""),
		base64url: bytes.toString("base64url"),
		hex: bytes.toString("hex"),
		"hex, uppercase": bytes.toString("hex").toUpperCase(),
		"percent-encoded": encodeURIComponent(secret),
	};
}

describe("derived forms of a masked value", () => {
	for (const [name, form] of Object.entries(forms(PASSWORD))) {
		it(`masks the ${name}`, () => {
			const masked = maskDerivedText(obfuscator(), `result: ${form} (done)`);
			expect(masked).toBe(`result: ${DERIVED_VALUE_MARKER} (done)`);
		});
	}

	it("masks a value embedded in base64 text at each byte offset", () => {
		// What `curl -v` prints for Basic authentication, with the value after a user name of each length.
		for (const user of ["u", "us", "usr", "user", "userxx"]) {
			const header = `Authorization: Basic ${Buffer.from(`${user}:${PASSWORD}`).toString("base64")}`;
			const masked = maskDerivedText(obfuscator(), header);
			expect(masked).toContain(DERIVED_VALUE_MARKER);
			expect(masked).not.toBe(header);
		}
	});

	it("masks a base64 text wrapped over several lines", () => {
		// A value over 57 bytes is wrapped by `base64` (76 columns, LF) and `openssl base64` (64 columns).
		const secret = "correct-horse-battery-staple-correct-horse-battery-staple-correct-horse-battery";
		const encoded = Buffer.from(secret).toString("base64");
		const wrap = (width: number, newline: string): string =>
			(encoded.match(new RegExp(`.{1,${width}}`, "g")) ?? []).join(newline);
		for (const [width, newline] of [
			[76, "\n"],
			[64, "\n"],
			[76, "\r\n"],
		] as const) {
			const wrapped = wrap(width, newline);
			expect(wrapped).toContain(newline);
			const text = `before\n${wrapped}\nafter`;
			const masked = maskDerivedText(obfuscator(secret), text);
			expect(masked).toBe(`before\n${DERIVED_VALUE_MARKER}\nafter`);
		}
		// Embedded in a longer wrapped text, at an offset: the user name shifts the base64 alignment.
		const embedded = Buffer.from(`user:${secret}`).toString("base64");
		const lines = (embedded.match(/.{1,76}/g) ?? []).join("\n");
		expect(maskDerivedText(obfuscator(secret), lines)).toContain(DERIVED_VALUE_MARKER);
		expect(maskDerivedText(obfuscator(secret), lines)).not.toContain(embedded.slice(8, 40));
	});

	it("leaves wrapped base64 that holds no form as it is, line breaks included", () => {
		const other = Buffer.from("an unrelated value that is long enough to wrap onto a second line of base64").toString(
			"base64",
		);
		const wrapped = `${other.slice(0, 76)}\n${other.slice(76)}`;
		expect(maskDerivedText(obfuscator(), wrapped)).toBe(wrapped);
	});

	it("masks the forms of a thousand values, which one regular expression cannot hold", () => {
		const secrets = Array.from({ length: 1000 }, (_, i) => `value-${i}-${crypto.randomBytes(6).toString("hex")}`);
		const o = new SecretObfuscator(secrets.map(content => ({ type: "plain", content, mode: "obfuscate" })));
		const first = secrets[0] as string;
		const last = secrets[999] as string;
		const text = `${digest("sha256", first).toString("hex")} ${Buffer.from(last).toString("base64")}`;
		expect(maskDerivedText(o, text)).toBe(`${DERIVED_VALUE_MARKER} ${DERIVED_VALUE_MARKER}`);
	});

	it("handles a value with a lone surrogate, which has no percent-encoding", () => {
		// A tool result cut in the middle of an emoji gives a regex match that ends in half of a surrogate pair.
		const secret = "token-\ud83d";
		const o = new SecretObfuscator([{ type: "plain", content: secret, mode: "obfuscate" }]);
		const hex = Buffer.from(secret).toString("hex");
		expect(() => maskDerivedText(o, `out ${hex}`)).not.toThrow();
		expect(maskDerivedText(o, `out ${digest("sha256", Buffer.from(secret)).toString("hex")}`)).toBe(
			`out ${DERIVED_VALUE_MARKER}`,
		);
	});

	it("masks several forms in one text, and the digest of a longer value", () => {
		const secret = "correct-horse-battery-staple";
		const f = forms(secret);
		const text = `sha256=${f["sha256 hex"]} b64=${f.base64} md5:${f["md5 hex"]}`;
		const masked = maskDerivedText(obfuscator(secret), text);
		expect(masked).toBe(`sha256=${DERIVED_VALUE_MARKER} b64=${DERIVED_VALUE_MARKER} md5:${DERIVED_VALUE_MARKER}`);
	});

	it("leaves text without a derived form alone, including hex that is not a digest part", () => {
		const text = [
			"commit 3f786850e387550fdab836ed7e6dc881de23001b",
			"timestamp 1731900000 and 20261118",
			`the password is ${DERIVED_VALUE_MARKER.length} characters`,
			"aGVsbG8gd29ybGQ=",
		].join("\n");
		expect(maskDerivedText(obfuscator(), text)).toBe(text);
	});

	it("does not mask short encodings that occur by chance", () => {
		// "ab": base64 "YWI=" and hex "6162" are shorter than the floors, so ordinary text keeps them.
		const text = "YWI= 6162 ab";
		expect(maskDerivedText(obfuscator("ab"), text)).toBe(text);
	});

	it("follows a value the registry minted from a regex match", () => {
		const regex = new SecretObfuscator([{ type: "regex", content: "(?<=password=)\\S+", mode: "obfuscate" }]);
		const messages: Message[] = [
			{ role: "user", content: `password=${PASSWORD}`, attribution: "user", timestamp: 1 },
			toolResult(`digest ${forms(PASSWORD)["sha256 hex"]}`),
		];
		// The regex match is minted by the first request; its derived forms are masked in the same request.
		const masked = maskOutboundMessages(regex, messages);
		expect(JSON.stringify(masked)).not.toContain(forms(PASSWORD)["sha256 hex"]);
		expect(JSON.stringify(masked)).not.toContain(PASSWORD);
	});
});

describe("derived forms in a provider request", () => {
	it("masks a digest in a tool result, keeping the real result in the session", () => {
		const o = obfuscator();
		const original = toolResult(`sha256 ${forms(PASSWORD)["sha256 hex"]}\nplain ${PASSWORD}`);
		const masked = maskOutboundMessages(o, [original]);
		const text = resultText(masked);
		expect(text).not.toContain(forms(PASSWORD)["sha256 hex"]);
		expect(text).not.toContain(PASSWORD);
		expect(text).toContain(DERIVED_VALUE_MARKER);
		// The input is not modified: the session keeps what the tool wrote.
		expect(resultText([original])).toContain(forms(PASSWORD)["sha256 hex"]);
	});

	it("keeps the history masked in later requests, and returns the same array when nothing matches", () => {
		const o = obfuscator();
		const clean: Message[] = [toolResult("nothing to hide here")];
		expect(maskOutboundMessages(o, clean)).toBe(clean);
		const dirty: Message[] = [toolResult(`md5 ${forms(PASSWORD)["md5 hex"]}`)];
		expect(resultText(maskOutboundMessages(o, dirty))).toBe(`md5 ${DERIVED_VALUE_MARKER}`);
		expect(resultText(maskOutboundMessages(o, dirty))).toBe(`md5 ${DERIVED_VALUE_MARKER}`);
	});

	it("does nothing when the session obfuscates nothing", () => {
		const o = obfuscator();
		o.setObfuscating(false);
		const text = forms(PASSWORD)["sha256 hex"];
		expect(maskDerivedText(o, text)).toBe(text);
		expect(maskDerivedText(undefined, text)).toBe(text);
	});

	it("adds the notice to the system prompt once, however many times the context is masked", () => {
		const o = obfuscator();
		const context: Context = { systemPrompt: ["You are an agent."], messages: [] };
		const once = maskOutboundContext(o, context);
		const twice = maskOutboundContext(o, once);
		expect(once.systemPrompt).toEqual(["You are an agent.", DERIVED_VALUE_NOTICE]);
		expect(twice.systemPrompt).toEqual(once.systemPrompt);
		expect(withDerivedValueNotice(undefined)).toBeUndefined();
	});

	it("does not add the notice when the session obfuscates nothing", () => {
		const o = obfuscator();
		o.setObfuscating(false);
		const context: Context = { systemPrompt: ["You are an agent."], messages: [] };
		expect(maskOutboundContext(o, context)).toBe(context);
	});
});
