import type { Context, Tool } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import { obfuscateProviderContext } from "../secrets/message-transform";
import type { SecretObfuscator } from "../secrets/obfuscator";

// `obfuscateProviderContext` rewrites the conversation messages only. The system prompt and the tool
// descriptions reach the provider as they are, so a value a rule matches there (the name of the project
// folder, which the project context file paths repeat) left the machine. The placeholders are the
// session's own: a value gets the same placeholder in every part of a request, and a tool call the model
// writes with one is restored before the tool runs, as it already is for messages.

/** Masks one piece of outbound text. Identity unless the session has secrets to obfuscate. */
export function maskOutboundText(obfuscator: SecretObfuscator | undefined, text: string): string {
	return obfuscator?.obfuscates() ? obfuscator.obfuscate(text) : text;
}

/**
 * Masks a provider context: its messages as `obfuscateProviderContext` does, and its system prompt and tool
 * descriptions. Returns the given context itself when the session obfuscates nothing or nothing in it matches.
 */
export function maskOutboundContext(obfuscator: SecretObfuscator | undefined, context: Context): Context {
	if (!obfuscator?.obfuscates()) return context;
	const messaged = obfuscateProviderContext(obfuscator, context);
	const systemPrompt = maskStrings(obfuscator, messaged.systemPrompt);
	const tools = maskTools(obfuscator, messaged.tools);
	const inactiveTools = maskTools(obfuscator, messaged.inactiveTools);
	if (systemPrompt === messaged.systemPrompt && tools === messaged.tools && inactiveTools === messaged.inactiveTools) {
		return messaged;
	}
	return {
		...messaged,
		...(systemPrompt === undefined ? {} : { systemPrompt }),
		...(tools === undefined ? {} : { tools }),
		...(inactiveTools === undefined ? {} : { inactiveTools }),
	};
}

/** Masks each string of a list, keeping the list itself when none of them changes. */
function maskStrings(obfuscator: SecretObfuscator, values: string[] | undefined): string[] | undefined {
	if (values === undefined) return undefined;
	const masked = values.map(value => obfuscator.obfuscate(value));
	return masked.every((value, index) => value === values[index]) ? values : masked;
}

/** Masks each tool's description and the description of every field in its parameter schema. */
function maskTools(obfuscator: SecretObfuscator, tools: Tool[] | undefined): Tool[] | undefined {
	if (tools === undefined) return undefined;
	const masked = tools.map(tool => {
		const description = obfuscator.obfuscate(tool.description);
		const parameters = maskSchemaDescriptions(obfuscator, tool.parameters);
		return description === tool.description && parameters === tool.parameters
			? tool
			: { ...tool, description, parameters };
	});
	return masked.every((tool, index) => tool === tools[index]) ? tools : masked;
}

/** Masks every `description` string of a JSON schema. Keys and all other values are kept as they are. */
function maskSchemaDescriptions<T>(obfuscator: SecretObfuscator, schema: T): T {
	const value: unknown = schema;
	if (Array.isArray(value)) {
		const masked: unknown[] = value.map(item => maskSchemaDescriptions(obfuscator, item));
		return (masked.every((item, index) => item === value[index]) ? value : masked) as T;
	}
	if (!isRecord(value)) return schema;
	// The copy keeps symbol-keyed metadata (TypeBox's `Kind`, for one), which only spreading carries over.
	const masked: Record<string, unknown> = { ...value };
	let changed = false;
	for (const [key, field] of Object.entries(value)) {
		const next =
			key === "description" && typeof field === "string"
				? obfuscator.obfuscate(field)
				: maskSchemaDescriptions(obfuscator, field);
		if (next === field) continue;
		changed = true;
		masked[key] = next;
	}
	return (changed ? masked : value) as T;
}
