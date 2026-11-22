/**
 * Where a session's context tokens go, by part, for Desktop's token analysis.
 *
 * Desktop stores and shows these numbers; it cannot see the system prompt, the tool definitions or the
 * messages the model really got, so the counts are made here, with the session's own tokenizer. Only names
 * and counts leave this module: no prompt, message or tool result text, and no tool arguments.
 *
 * Two entry points share one builder: `_xsec/context/snapshot` (the session now) and `_xsec/usage/request`
 * (the context one provider request carried, measured at its `message_end`).
 */
import type { AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolCall } from "@oh-my-pi/pi-ai";
import {
	claimPromptSources,
	getToolSchemaMetadataRevision,
	toolSchemaFragments,
} from "@oh-my-pi/pi-tui/status-line/context-usage";
import { stringifyJson } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";

/** Bumped when a field's meaning changes; Desktop ignores a version it does not know. */
export const COMPOSITION_SCHEMA_VERSION = 1;

/**
 * The parts a context is split into. The wire names are stable; Desktop maps them to its labels.
 * `tool_definitions` and `system_prompt` are sent with every request; the rest grow with the conversation.
 */
export type CompositionCategory =
	| "system_prompt"
	| "instruction_files"
	| "skills"
	| "tool_definitions"
	| "tool_calls"
	| "tool_results"
	| "user_messages"
	| "assistant_messages"
	| "assistant_thinking"
	| "compaction_summary";

/**
 * One line of the split. `name` is a tool, skill, file or block name, never content. `source` says where a tool
 * comes from (`builtin`, `mcp:<server>`, `extension`, `sdk`). `variant: "docs"` marks a `read xd://<tool>`
 * (the tool's description read into the context) apart from the tool's own calls and results.
 */
export interface CompositionItem {
	category: CompositionCategory;
	name: string;
	source?: string;
	variant?: "docs";
	/** Estimated tokens of everything this line stands for. */
	tokens: number;
	/** How many calls, results or messages the line sums up; absent for fixed parts. */
	count?: number;
	/** The largest single member, so a heavy tool result stands out from many small ones. */
	maxTokens?: number;
}

export interface ContextComposition {
	/** Sum of every item's tokens: an estimate with the session's tokenizer, not the provider's count. */
	estimatedTokens: number;
	items: CompositionItem[];
}

/** An `xd://` path is how the model reaches an extension-mounted tool; the tool's name follows the scheme. */
const XD_SCHEME = "xd://";

interface ResolvedTool {
	name: string;
	variant?: "docs";
}

/** The tool a `write`/`read` of an `xd://` device really addresses, so plugin tools count under their own names. */
function resolveToolCall(call: ToolCall): ResolvedTool {
	const args = call.arguments as Record<string, unknown> | undefined;
	const path = typeof args?.path === "string" ? args.path : undefined;
	if (path === undefined || path.slice(0, XD_SCHEME.length).toLowerCase() !== XD_SCHEME) return { name: call.name };
	const target =
		path
			.slice(XD_SCHEME.length)
			.split(/[?#]/, 1)[0]
			?.replace(/^\/+|\/+$/g, "") ?? "";
	if (!target) return { name: call.name };
	if (call.name === "read") return { name: target, variant: "docs" };
	if (call.name === "write") {
		// An empty content, "?" or "help" reads the tool's description rather than running it.
		const content = typeof args?.content === "string" ? args.content.trim() : "";
		return content === "" || content === "?" || content === "help"
			? { name: target, variant: "docs" }
			: { name: target };
	}
	return { name: call.name };
}

/** Accumulates items by (category, name, source, variant). */
class ItemBook {
	readonly #byKey = new Map<string, CompositionItem>();

	add(
		category: CompositionCategory,
		name: string,
		tokens: number,
		extra?: Pick<CompositionItem, "source" | "variant">,
	) {
		if (!(tokens > 0) && category !== "tool_definitions") return;
		const key = `${category}\0${name}\0${extra?.source ?? ""}\0${extra?.variant ?? ""}`;
		let item = this.#byKey.get(key);
		if (!item) {
			item = { category, name, tokens: 0, count: 0, maxTokens: 0 };
			if (extra?.source !== undefined) item.source = extra.source;
			if (extra?.variant !== undefined) item.variant = extra.variant;
			this.#byKey.set(key, item);
		}
		item.tokens += tokens;
		item.count = (item.count ?? 0) + 1;
		item.maxTokens = Math.max(item.maxTokens ?? 0, tokens);
	}

	/** Fixed parts are one line each: a count of 1 says nothing, so they carry none. */
	addFixed(category: CompositionCategory, name: string, tokens: number, source?: string) {
		this.add(category, name, tokens, source === undefined ? undefined : { source });
		const key = `${category}\0${name}\0${source ?? ""}\0`;
		const item = this.#byKey.get(key);
		if (item) {
			delete item.count;
			delete item.maxTokens;
		}
	}

	merge(items: readonly CompositionItem[]) {
		for (const item of items)
			this.#byKey.set(`${item.category}\0${item.name}\0${item.source ?? ""}\0${item.variant ?? ""}`, { ...item });
	}

	items(): CompositionItem[] {
		return [...this.#byKey.values()];
	}
}

/** What the system prompt and the tool roster contribute, cached while neither changes. */
interface FixedPart {
	systemPrompt: readonly string[];
	sources: unknown;
	tools: unknown;
	settingsRevision: number;
	toolsRevision: number;
	tokenizer: Tokenizer;
	modelKey: string;
	items: CompositionItem[];
}

const FIXED_CACHE = new WeakMap<AgentSession, FixedPart>();

function toolSource(info: { sourceInfo: { source: string }; mcpServerName?: string } | undefined): string {
	if (!info) return "unknown";
	return info.sourceInfo.source === "mcp" && info.mcpServerName ? `mcp:${info.mcpServerName}` : info.sourceInfo.source;
}

function buildFixedPart(session: AgentSession): CompositionItem[] {
	const tokenizer = session.agent.tokenizer;
	const book = new ItemBook();

	const blocks = session.systemPrompt;
	const { byBlock } = claimPromptSources(blocks, session.systemPromptSources);
	for (const [index, block] of blocks.entries()) {
		let remaining = "";
		let cursor = 0;
		for (const source of byBlock.get(index) ?? []) {
			remaining += block.slice(cursor, source.start);
			const tokens = tokenizer.countTokens(block.slice(source.start, source.end));
			if (source.kind === "skills") book.addFixed("skills", source.label, tokens);
			else book.addFixed("instruction_files", source.path ?? source.label, tokens);
			cursor = source.end;
		}
		const rest = cursor === 0 ? block : remaining + block.slice(cursor);
		book.addFixed("system_prompt", `block-${index}`, tokenizer.countTokens(rest));
	}

	const infoByName = new Map(session.getAllToolInfos().map(info => [info.name, info]));
	const model = session.model;
	const prune = session.agent.prunesToolDescriptions(model);
	for (const tool of session.agent.state.tools) {
		const { fragments } = toolSchemaFragments(tool, { pruneDescriptions: prune });
		const tokens = model?.toolSchemasInContext === false ? 0 : tokenizer.countTokens(fragments);
		book.addFixed("tool_definitions", tool.name, tokens, toolSource(infoByName.get(tool.name)));
	}
	return book.items();
}

function fixedPart(session: AgentSession): CompositionItem[] {
	const tools = session.agent.state.tools;
	const tokenizer = session.agent.tokenizer;
	const model = session.model;
	const modelKey = model ? `${model.provider}/${model.id}/${model.toolSchemasInContext === false ? "0" : "1"}` : "";
	const systemPrompt = session.systemPrompt;
	const sources = session.systemPromptSources;
	const settingsRevision = session.settings.revision;
	const toolsRevision = getToolSchemaMetadataRevision(tools);
	const cached = FIXED_CACHE.get(session);
	if (
		cached &&
		cached.tools === tools &&
		cached.settingsRevision === settingsRevision &&
		cached.toolsRevision === toolsRevision &&
		cached.tokenizer === tokenizer &&
		cached.modelKey === modelKey &&
		cached.sources === sources &&
		cached.systemPrompt.length === systemPrompt.length &&
		cached.systemPrompt.every((block, index) => block === systemPrompt[index])
	) {
		return cached.items;
	}
	const items = buildFixedPart(session);
	FIXED_CACHE.set(session, {
		systemPrompt: [...systemPrompt],
		sources,
		tools,
		settingsRevision,
		toolsRevision,
		tokenizer,
		modelKey,
		items,
	});
	return items;
}

/** The size of an assistant reply's own blocks; what the blocks do not account for is replayed reasoning. */
function addAssistantMessage(
	book: ItemBook,
	tokenizer: Tokenizer,
	message: AssistantMessage,
	tools: Map<string, ResolvedTool>,
) {
	let counted = 0;
	for (const block of message.content) {
		if (block.type === "text") {
			const tokens = tokenizer.countTokens(block.text);
			counted += tokens;
			book.add("assistant_messages", "assistant", tokens);
		} else if (block.type === "toolCall") {
			let tokens: number;
			try {
				// Same serializer as Tokenizer.countMessage, so the reasoning residual stays exact.
				tokens = tokenizer.countTokens([block.name, stringifyJson(block.arguments) ?? "null"]);
			} catch {
				tokens = tokenizer.countTokens(block.name);
			}
			counted += tokens;
			const resolved = resolveToolCall(block);
			tools.set(block.id, resolved);
			book.add("tool_calls", resolved.name, tokens, resolved.variant ? { variant: resolved.variant } : undefined);
		}
	}
	// Thinking text, signatures and provider payloads: whatever the message weighs beyond its text and calls.
	const thinking = Math.max(0, tokenizer.countMessage(message) - counted);
	book.add("assistant_thinking", "assistant", thinking);
}

function addMessage(book: ItemBook, tokenizer: Tokenizer, message: AgentMessage, tools: Map<string, ResolvedTool>) {
	switch (message.role) {
		case "assistant":
			addAssistantMessage(book, tokenizer, message, tools);
			return;
		case "toolResult": {
			const resolved = tools.get(message.toolCallId) ?? { name: message.toolName };
			book.add(
				"tool_results",
				resolved.name,
				tokenizer.countMessage(message),
				resolved.variant ? { variant: resolved.variant } : undefined,
			);
			return;
		}
		case "bashExecution":
			book.add("tool_results", "bash", tokenizer.countMessage(message));
			return;
		case "pythonExecution":
			book.add("tool_results", "python", tokenizer.countMessage(message));
			return;
		case "compactionSummary":
		case "branchSummary":
			book.add("compaction_summary", message.role, tokenizer.countMessage(message));
			return;
		default:
			book.add("user_messages", "user", tokenizer.countMessage(message));
	}
}

/**
 * The split of the context `session` would send, or, with `before`, of the context that request carried:
 * the messages that come before `before`, which is the assistant reply the request produced.
 */
export function buildContextComposition(session: AgentSession, before?: AgentMessage): ContextComposition {
	const tokenizer = session.agent.tokenizer;
	const book = new ItemBook();
	book.merge(fixedPart(session));
	const messages = session.agent.state.messages;
	const found = before === undefined ? -1 : messages.lastIndexOf(before);
	const end = found < 0 ? messages.length : found;
	const tools = new Map<string, ResolvedTool>();
	for (let index = 0; index < end; index++) addMessage(book, tokenizer, messages[index]!, tools);
	const items = book.items();
	return { estimatedTokens: items.reduce((sum, item) => sum + item.tokens, 0), items };
}
