/**
 * Restores model text in the ACP event stream, so a client never shows a placeholder (`$$NAME_HASH$$`).
 *
 * The session emits `message_update` deltas as the model wrote them, so a placeholder can arrive split
 * across deltas. Each open text or thinking block keeps the raw text it has seen, restores the part that
 * is complete, and holds back only a trailing piece that a placeholder could still complete. A block
 * that ends sends what it still holds. The session, its persistence and the provider requests are not
 * touched: this module only rewrites the events the ACP client is sent.
 */
import type { AssistantMessage, AssistantMessageEvent } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { AgentSessionEvent } from "../session/agent-session";
import type { SessionContext } from "../session/session-context";
import {
	deobfuscateAssistantContent,
	deobfuscateSessionContext,
	deobfuscateToolArguments,
} from "../secrets/message-transform";
import type { SecretObfuscator } from "../secrets/obfuscator";

/** What the restorer reads from a session: its obfuscator, which `setObfuscator` may replace mid-run. */
export interface AcpSecretOwner {
	readonly obfuscator: SecretObfuscator | undefined;
}

type MessageUpdateEvent = Extract<AgentSessionEvent, { type: "message_update" }>;
type BlockKind = "text" | "thinking";

/** One text or thinking block of the assistant message being streamed. */
interface OpenBlock {
	readonly kind: BlockKind;
	/** Restored text that can no longer change: no placeholder spans a character it cannot contain, or a run with no `$`. */
	head: string;
	/** Raw text after that character. Every character in it is one a placeholder can contain. */
	tail: string;
	/** Length of the restored text already sent to the client. */
	sent: number;
}

/** Open blocks by content index, per session. A message's blocks are cleared when it starts and when it ends. */
const openBlocks = new WeakMap<AcpSecretOwner, Map<number, OpenBlock>>();

/**
 * A trailing piece that a placeholder could still complete: `$`, `$$`, `$$NAME_`, `$$NAME_AB12`, `$$NAME_AB12:U`
 * and `$$NAME_AB12$`. A complete `$$NAME_AB12$$` does not match. Upstream's `stripPendingSecretPlaceholderSuffix`
 * does not hold back the last `$` of `$$NAME_AB12$`, so it is not used here.
 */
const OPEN_PLACEHOLDER_RE = /\$(?:\$(?:[A-Z0-9]+_)?[A-Z0-9]*(?::[ULCM]?)?\$?)?$/;

/** Whether a character can be part of a placeholder: `$`, `A`-`Z`, `0`-`9`, `_` or `:`. */
function isPlaceholderCode(code: number): boolean {
	return (
		code === 0x24 ||
		code === 0x3a ||
		code === 0x5f ||
		(code >= 0x30 && code <= 0x39) ||
		(code >= 0x41 && code <= 0x5a)
	);
}

/** The session's obfuscator when it has secrets to restore, otherwise undefined: the events then pass through. */
function activeObfuscator(owner: AcpSecretOwner): SecretObfuscator | undefined {
	const obfuscator = owner.obfuscator;
	return obfuscator?.hasSecrets() ? obfuscator : undefined;
}

function restoreText(obfuscator: SecretObfuscator | undefined, text: string): string {
	return obfuscator ? obfuscator.deobfuscate(text) : text;
}

function blocksOf(owner: AcpSecretOwner): Map<number, OpenBlock> {
	let blocks = openBlocks.get(owner);
	if (!blocks) {
		blocks = new Map();
		openBlocks.set(owner, blocks);
	}
	return blocks;
}

/** Restored text that may be sent now: the closed head, and the open tail without any trailing placeholder start. */
function readyText(obfuscator: SecretObfuscator, block: OpenBlock): string {
	const restored = obfuscator.deobfuscate(block.tail);
	const open = OPEN_PLACEHOLDER_RE.exec(restored);
	return block.head + (open ? restored.slice(0, open.index) : restored);
}

/** The part of `ready` the client has not seen yet. Never shrinks what was sent. */
function takeUnsent(block: OpenBlock, ready: string): string {
	if (ready.length <= block.sent) return "";
	const text = ready.slice(block.sent);
	block.sent = ready.length;
	return text;
}

/** Appends a streamed delta to a block and returns the restored text that can be sent now. */
function pushDelta(obfuscator: SecretObfuscator, block: OpenBlock, delta: string): string {
	let boundary = delta.length - 1;
	while (boundary >= 0 && isPlaceholderCode(delta.charCodeAt(boundary))) boundary--;
	if (boundary >= 0) {
		// A character no placeholder contains ends every placeholder before it, so this text is final.
		block.head += obfuscator.deobfuscate(block.tail + delta.slice(0, boundary + 1));
		block.tail = delta.slice(boundary + 1);
	} else {
		block.tail += delta;
	}
	// A placeholder starts with `$`, so a tail without one is final too. Without this, a long run of capitals
	// and digits would be restored again on every delta.
	if (!block.tail.includes("$")) {
		block.head += block.tail;
		block.tail = "";
	}
	return takeUnsent(block, readyText(obfuscator, block));
}

/** The restored text a block still owes the client once it has ended, nothing held back. */
function closeBlockText(obfuscator: SecretObfuscator | undefined, block: OpenBlock): string {
	return takeUnsent(block, block.head + restoreText(obfuscator, block.tail));
}

/** A `message_update` event that carries `text` to the client as one delta of the block. */
function deltaEvent(
	partial: AssistantMessage,
	contentIndex: number,
	kind: BlockKind,
	delta: string,
): AgentSessionEvent {
	const assistantMessageEvent: AssistantMessageEvent =
		kind === "text"
			? { type: "text_delta", contentIndex, delta, partial }
			: { type: "thinking_delta", contentIndex, delta, partial };
	return { type: "message_update", message: partial, assistantMessageEvent };
}

/** Sends what one block still holds, when its end arrives. */
function closeBlock(
	owner: AcpSecretOwner,
	obfuscator: SecretObfuscator | undefined,
	contentIndex: number,
	partial: AssistantMessage,
): AgentSessionEvent[] {
	const blocks = openBlocks.get(owner);
	const block = blocks?.get(contentIndex);
	if (!blocks || !block) return [];
	blocks.delete(contentIndex);
	const delta = closeBlockText(obfuscator, block);
	return delta.length > 0 ? [deltaEvent(partial, contentIndex, block.kind, delta)] : [];
}

/** Sends what every open block of the message still holds, in content order, when the message ends. */
function closeAllBlocks(
	owner: AcpSecretOwner,
	obfuscator: SecretObfuscator | undefined,
	partial: AssistantMessage,
): AgentSessionEvent[] {
	const blocks = openBlocks.get(owner);
	if (!blocks || blocks.size === 0) return [];
	const events: AgentSessionEvent[] = [];
	for (const contentIndex of [...blocks.keys()].sort((a, b) => a - b)) {
		const block = blocks.get(contentIndex);
		if (!block) continue;
		const delta = closeBlockText(obfuscator, block);
		if (delta.length > 0) events.push(deltaEvent(partial, contentIndex, block.kind, delta));
	}
	blocks.clear();
	return events;
}

function restoreMessageUpdate(
	owner: AcpSecretOwner,
	obfuscator: SecretObfuscator | undefined,
	event: MessageUpdateEvent,
): AgentSessionEvent[] {
	const update = event.assistantMessageEvent;
	switch (update.type) {
		case "text_start":
		case "thinking_start":
			if (obfuscator) {
				const kind: BlockKind = update.type === "text_start" ? "text" : "thinking";
				blocksOf(owner).set(update.contentIndex, { kind, head: "", tail: "", sent: 0 });
			}
			return [event];
		case "text_delta":
		case "thinking_delta": {
			if (!obfuscator) return [event];
			const kind: BlockKind = update.type === "text_delta" ? "text" : "thinking";
			const blocks = blocksOf(owner);
			let block = blocks.get(update.contentIndex);
			if (!block) {
				block = { kind, head: "", tail: "", sent: 0 };
				blocks.set(update.contentIndex, block);
			}
			const delta = pushDelta(obfuscator, block, update.delta);
			return [{ ...event, assistantMessageEvent: { ...update, delta } }];
		}
		case "text_end":
			return [...closeBlock(owner, obfuscator, update.contentIndex, update.partial), event];
		case "thinking_end": {
			const flushed = closeBlock(owner, obfuscator, update.contentIndex, update.partial);
			if (!obfuscator) return [...flushed, event];
			// A narration block is sent whole when it ends, so its full content is restored here.
			const restored = { ...update, content: obfuscator.deobfuscate(update.content) };
			return [...flushed, { ...event, assistantMessageEvent: restored }];
		}
		case "done": {
			const flushed = closeAllBlocks(owner, obfuscator, update.message);
			if (!obfuscator) return [...flushed, event];
			const message = {
				...update.message,
				content: deobfuscateAssistantContent(obfuscator, update.message.content),
			};
			return [...flushed, { ...event, assistantMessageEvent: { ...update, message } }];
		}
		case "error": {
			const flushed = closeAllBlocks(owner, obfuscator, update.error);
			if (!obfuscator) return [...flushed, event];
			const error = {
				...update.error,
				errorMessage:
					update.error.errorMessage === undefined ? undefined : obfuscator.deobfuscate(update.error.errorMessage),
			};
			return [...flushed, { ...event, assistantMessageEvent: { ...update, error } }];
		}
		default:
			return [event];
	}
}

/**
 * The events the ACP client is sent in place of `event`, in order. Streamed text is restored and its
 * placeholder-shaped tails are held back until they resolve or their block ends. Tool arguments and the
 * tool intent are restored. A session with no secrets gets its events back unchanged.
 */
export function restoreAcpSessionEvents(owner: AcpSecretOwner, event: AgentSessionEvent): AgentSessionEvent[] {
	const obfuscator = activeObfuscator(owner);
	switch (event.type) {
		case "message_start":
			openBlocks.get(owner)?.clear();
			return [event];
		case "message_update":
			return restoreMessageUpdate(owner, obfuscator, event);
		case "message_end":
			if (event.message.role !== "assistant") return [event];
			return [...closeAllBlocks(owner, obfuscator, event.message), event];
		case "tool_execution_start":
			if (!obfuscator) return [event];
			return [
				{
					...event,
					args: restoreArguments(obfuscator, event.args),
					intent: event.intent === undefined ? undefined : obfuscator.deobfuscate(event.intent),
				},
			];
		case "tool_execution_update":
			if (!obfuscator) return [event];
			return [{ ...event, args: restoreArguments(obfuscator, event.args) }];
		default:
			return [event];
	}
}

function restoreArguments(obfuscator: SecretObfuscator, args: unknown): unknown {
	return isRecord(args) ? deobfuscateToolArguments(obfuscator, args) : args;
}

/** Restores a whole text the client receives in one chunk, such as a fallback reply from the last turn. */
export function restoreAcpText<T extends string | undefined>(owner: AcpSecretOwner, text: T): T {
	const obfuscator = activeObfuscator(owner);
	if (!obfuscator || text === undefined) return text;
	return obfuscator.deobfuscate(text) as T;
}

/** A session whose stored history is replayed to a client: its obfuscator, and the context its entries build. */
export interface AcpReplaySession extends AcpSecretOwner {
	readonly sessionManager: { buildSessionContext(): SessionContext };
}

/**
 * The stored history of a session with its placeholders restored, for replaying it to the client. Thinking blocks
 * are restored here too: `deobfuscateSessionContext` leaves them alone, but the replay sends them as text. The
 * stored entries are not changed, so the session file and the provider requests stay as they are.
 */
export function restoredSessionContext(session: AcpReplaySession): SessionContext {
	const obfuscator = activeObfuscator(session);
	const context = deobfuscateSessionContext(session.sessionManager.buildSessionContext(), obfuscator);
	if (!obfuscator) return context;
	const messages = context.messages.map(message => {
		if (message.role !== "assistant") return message;
		const content = message.content.map(block =>
			block.type === "thinking" ? { ...block, thinking: obfuscator.deobfuscate(block.thinking) } : block,
		);
		return { ...message, content };
	});
	return { ...context, messages };
}
