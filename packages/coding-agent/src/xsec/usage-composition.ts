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
import { isEstimateCacheable, messageEstimateVersion } from "@oh-my-pi/pi-agent-core/compaction/message-cache";
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

/** What a tool name is reported as when it is not one the session registered. */
export const UNKNOWN_NAME = "unknown";
/** No name is longer than this: the cap keeps a registered-but-odd name from growing a host's tables. */
const MAX_NAME_LENGTH = 100;

/**
 * Only names the session itself registered leave this module. A tool call's name, an `xd://` path and a result's
 * `toolName` are written by the model (or echo what it wrote), so an unregistered one, which may hold anything the
 * model chose to say, is reported as {@link UNKNOWN_NAME}.
 */
function reportableName(name: string, known: ReadonlySet<string>): string {
	return known.has(name) ? name.slice(0, MAX_NAME_LENGTH) : UNKNOWN_NAME;
}

/** The tool names the session registered: enabled ones, `xd://` mounted devices and MCP tools included. */
function registeredToolNames(session: AgentSession): ReadonlySet<string> {
	const names = new Set<string>();
	for (const tool of session.agent.state.tools) names.add(tool.name);
	for (const info of session.getAllToolInfos()) names.add(info.name);
	return names;
}

/** The tool a `write`/`read` of an `xd://` device really addresses, so plugin tools count under their own names. */
function resolveToolCall(call: ToolCall, known: ReadonlySet<string>): ResolvedTool {
	const args = call.arguments as Record<string, unknown> | undefined;
	const path = typeof args?.path === "string" ? args.path : undefined;
	if (path === undefined || path.slice(0, XD_SCHEME.length).toLowerCase() !== XD_SCHEME) {
		return { name: reportableName(call.name, known) };
	}
	const target =
		path
			.slice(XD_SCHEME.length)
			.split(/[?#]/, 1)[0]
			?.replace(/^\/+|\/+$/g, "") ?? "";
	if (!target) return { name: reportableName(call.name, known) };
	const name = reportableName(target, known);
	if (call.name === "read") return { name, variant: "docs" };
	if (call.name === "write") {
		// An empty content, "?" or "help" reads the tool's description rather than running it.
		const content = typeof args?.content === "string" ? args.content.trim() : "";
		return content === "" || content === "?" || content === "help" ? { name, variant: "docs" } : { name };
	}
	return { name: reportableName(call.name, known) };
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
		name = name.slice(0, MAX_NAME_LENGTH);
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

/** One contribution of a message to the split. */
interface Line {
	category: CompositionCategory;
	name: string;
	tokens: number;
	variant?: "docs";
}

/** Token counts of an assistant message's blocks, kept with the message while its estimate stays valid. */
interface AssistantCounts {
	tokenizer: Tokenizer;
	version: number;
	/** Per block: its text or call, counted; thinking and other blocks count 0 here. */
	blocks: number[];
	/** What the message weighs beyond its text and calls: thinking, signatures and provider payloads. */
	thinking: number;
}

const ASSISTANT_COUNTS = new WeakMap<AssistantMessage, AssistantCounts>();

/**
 * Tokenizing is the cost of a request's split, and an assistant message never changes once settled, so its
 * counts are kept per message and tokenizer. A prune or shake bumps the message's estimate version, which
 * drops them; an unsettled message is never kept.
 */
function assistantCounts(tokenizer: Tokenizer, message: AssistantMessage): AssistantCounts {
	const cacheable = isEstimateCacheable(message);
	const version = messageEstimateVersion(message);
	const cached = cacheable ? ASSISTANT_COUNTS.get(message) : undefined;
	if (cached && cached.tokenizer === tokenizer && cached.version === version) return cached;
	let counted = 0;
	const blocks = message.content.map(block => {
		let tokens = 0;
		if (block.type === "text") {
			tokens = tokenizer.countTokens(block.text);
		} else if (block.type === "toolCall") {
			try {
				// Same serializer as Tokenizer.countMessage, so the reasoning residual stays exact.
				tokens = tokenizer.countTokens([block.name, stringifyJson(block.arguments) ?? "null"]);
			} catch {
				tokens = tokenizer.countTokens(block.name);
			}
		}
		counted += tokens;
		return tokens;
	});
	const counts: AssistantCounts = {
		tokenizer,
		version,
		blocks,
		thinking: Math.max(0, tokenizer.countMessage(message) - counted),
	};
	if (cacheable) ASSISTANT_COUNTS.set(message, counts);
	return counts;
}

function assistantLines(
	tokenizer: Tokenizer,
	message: AssistantMessage,
	tools: Map<string, ResolvedTool>,
	known: ReadonlySet<string>,
): Line[] {
	const counts = assistantCounts(tokenizer, message);
	const lines: Line[] = [];
	for (const [index, block] of message.content.entries()) {
		const tokens = counts.blocks[index] ?? 0;
		if (block.type === "text") {
			lines.push({ category: "assistant_messages", name: "assistant", tokens });
		} else if (block.type === "toolCall") {
			const resolved = resolveToolCall(block, known);
			tools.set(block.id, resolved);
			lines.push({ category: "tool_calls", name: resolved.name, tokens, variant: resolved.variant });
		}
	}
	lines.push({ category: "assistant_thinking", name: "assistant", tokens: counts.thinking });
	return lines;
}

function messageLines(
	tokenizer: Tokenizer,
	message: AgentMessage,
	tools: Map<string, ResolvedTool>,
	known: ReadonlySet<string>,
): Line[] {
	switch (message.role) {
		case "assistant":
			return assistantLines(tokenizer, message, tools, known);
		case "toolResult": {
			const resolved = tools.get(message.toolCallId) ?? { name: reportableName(message.toolName, known) };
			return [
				{
					category: "tool_results",
					name: resolved.name,
					tokens: tokenizer.countMessage(message),
					variant: resolved.variant,
				},
			];
		}
		case "bashExecution":
			return [{ category: "tool_results", name: "bash", tokens: tokenizer.countMessage(message) }];
		case "pythonExecution":
			return [{ category: "tool_results", name: "python", tokens: tokenizer.countMessage(message) }];
		case "compactionSummary":
		case "branchSummary":
			return [{ category: "compaction_summary", name: message.role, tokens: tokenizer.countMessage(message) }];
		default:
			return [{ category: "user_messages", name: "user", tokens: tokenizer.countMessage(message) }];
	}
}

function addLines(book: ItemBook, lines: readonly Line[]) {
	for (const line of lines) {
		book.add(line.category, line.name, line.tokens, line.variant ? { variant: line.variant } : undefined);
	}
}

/**
 * The split of the context `session` would send, or, with `before`, of the context that request carried:
 * the messages that come before `before`, which is the assistant reply the request produced.
 */
export function buildContextComposition(session: AgentSession, before?: AgentMessage): ContextComposition {
	return scanContext(session, before, undefined).composition;
}

/** One provider request seen from outside: the context it carried, what that context gained, what came back. */
export interface RequestComposition {
	composition: ContextComposition;
	/**
	 * The messages new in this request's context: those after the reply to the previous request (tool results,
	 * the user's message). A host sums these to learn how many results a tool produced and how big they were,
	 * which the whole-context split cannot say because it repeats old results on every request.
	 */
	added: CompositionItem[];
	/** The reply's own blocks: the output side of the request (text, thinking, tool calls by tool). */
	reply: CompositionItem[];
}

/**
 * The split of the context `reply`'s request carried. `previousReply` is the reply to the request before, when
 * this process saw it; without it the messages after the last earlier reply count as new, which is right for a
 * session resumed from disk and for one whose history was compacted.
 */
export function buildRequestComposition(
	session: AgentSession,
	reply: AssistantMessage,
	previousReply: AgentMessage | undefined,
): RequestComposition {
	const messages = session.agent.state.messages;
	const end = replyIndex(messages, reply);
	let baseline = previousReply === undefined ? -1 : messages.lastIndexOf(previousReply);
	if (baseline < 0 || baseline >= end) baseline = messages.slice(0, end).findLastIndex(m => m.role === "assistant");
	const scanned = scanContext(session, reply, baseline + 1);
	const replyBook = new ItemBook();
	addLines(replyBook, assistantLines(session.agent.tokenizer, reply, new Map(), registeredToolNames(session)));
	return { composition: scanned.composition, added: scanned.added, reply: replyBook.items() };
}

function replyIndex(messages: readonly AgentMessage[], reply: AgentMessage | undefined): number {
	const found = reply === undefined ? -1 : messages.lastIndexOf(reply);
	return found < 0 ? messages.length : found;
}

function scanContext(
	session: AgentSession,
	before: AgentMessage | undefined,
	addedFrom: number | undefined,
): { composition: ContextComposition; added: CompositionItem[] } {
	const tokenizer = session.agent.tokenizer;
	const book = new ItemBook();
	const addedBook = new ItemBook();
	book.merge(fixedPart(session));
	const messages = session.agent.state.messages;
	const end = replyIndex(messages, before);
	const tools = new Map<string, ResolvedTool>();
	const known = registeredToolNames(session);
	for (let index = 0; index < end; index++) {
		const lines = messageLines(tokenizer, messages[index]!, tools, known);
		addLines(book, lines);
		if (addedFrom !== undefined && index >= addedFrom) addLines(addedBook, lines);
	}
	const items = book.items();
	return {
		composition: { estimatedTokens: items.reduce((sum, item) => sum + item.tokens, 0), items },
		added: addedBook.items(),
	};
}
