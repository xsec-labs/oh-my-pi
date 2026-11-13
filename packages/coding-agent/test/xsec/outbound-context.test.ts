import { describe, expect, it } from "bun:test";
import type { Context, Tool } from "@oh-my-pi/pi-ai";
import { SecretObfuscator } from "../../src/secrets";
import { maskOutboundContext, maskOutboundText } from "../../src/xsec/outbound-context";

/** A project folder name a secret rule matches. Made up for this test. */
const FOLDER = "Tessel-Harbor-Quill";

/** Symbol-keyed metadata on a tool schema, as TypeBox keeps its schema kind. */
const SCHEMA_KIND = Symbol.for("TypeBox.Kind");

const readTool: Tool = {
	name: "read_notes",
	description: `Reads a note from the ${FOLDER} folder.`,
	parameters: {
		type: "object",
		[SCHEMA_KIND]: "Object",
		properties: {
			path: { type: "string", description: `A path under ${FOLDER}.` },
		},
		required: ["path"],
	} as Tool["parameters"],
};

const SYSTEM_PROMPT = [`Project context files: <file path="/clients/${FOLDER}/project/AGENTS.md">`];

const context: Context = {
	systemPrompt: SYSTEM_PROMPT,
	messages: [],
	tools: [readTool],
};

describe("masking outside the messages", () => {
	it("keeps a secret out of the system prompt and the tool descriptions, and restores it from the placeholder", () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", content: FOLDER }]);
		const masked = maskOutboundContext(obfuscator, context);

		// The provider receives neither the system prompt nor the tool definitions with the folder name in them.
		expect(masked.systemPrompt?.join("\n")).not.toContain(FOLDER);
		expect(JSON.stringify(masked.tools)).not.toContain(FOLDER);
		// The placeholders are the session's own, so they restore to exactly the text that was masked.
		expect(obfuscator.deobfuscate(masked.systemPrompt?.join("\n") ?? "")).toBe(SYSTEM_PROMPT.join("\n"));
		expect(obfuscator.deobfuscate(masked.tools?.[0]?.description ?? "")).toBe(readTool.description);
	});

	it("leaves the tool schema's keys and non-description values as they are", () => {
		const obfuscator = new SecretObfuscator([{ type: "plain", content: FOLDER }]);
		const schema = maskOutboundContext(obfuscator, context).tools?.[0]?.parameters as
			| { type: string; required: string[]; properties: Record<string, { type: string }> }
			| undefined;

		expect(schema).toMatchObject({ type: "object", required: ["path"] });
		expect(Object.keys(schema?.properties ?? {})).toEqual(["path"]);
		expect(schema?.properties.path?.type).toBe("string");
		expect((schema as unknown as Record<symbol, unknown>)[SCHEMA_KIND]).toBe("Object");
	});

	it("returns the context unchanged when the session obfuscates nothing", () => {
		expect(maskOutboundContext(undefined, context)).toBe(context);
		expect(maskOutboundContext(new SecretObfuscator([]), context)).toBe(context);
		expect(maskOutboundText(undefined, `in ${FOLDER}`)).toBe(`in ${FOLDER}`);
	});
});
