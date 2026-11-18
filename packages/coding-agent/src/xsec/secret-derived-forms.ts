/**
 * Masks the common derived forms of the values a session masks, in what goes to the provider.
 *
 * The obfuscator replaces a value it holds (a configured word, a regex match) with a placeholder, and the model
 * writes the placeholder into a tool call, where the loop restores the real value. A tool can then compute
 * anything from that value and print it: a digest, a base64 or hex string, a URL-encoded copy. The tool result
 * goes back to the model, the obfuscator does not recognise a digest as the value, and a short value (a
 * five-character password) is recovered from its digest by brute force. This module closes the forms below for
 * every value the registry holds, in user, developer and tool result messages:
 *
 * - base64 (standard and URL-safe, padded and not) of the value, and of the value embedded at any of the three
 *   byte offsets of a larger base64 text (`user:value` in a Basic authorization header). Only the characters the
 *   value alone determines are matched;
 * - hex (either case) and percent-encoding of the value;
 * - MD5, SHA-1, SHA-256 and SHA-512 of the value, and of the value with a trailing newline (what `echo` hashes),
 *   as hex (whole, or a prefix or suffix of at least {@link MIN_DIGEST_PART} characters) and as base64.
 *
 * What stays open: a form this list does not name (the value reversed, spelt out character by character, a
 * digest cut in the middle, XOR or encryption of it), and a model that sets out to leak. The notice
 * {@link DERIVED_VALUE_NOTICE} asks the model not to derive output from a placeholder; it does not enforce it.
 *
 * The pass works on provider-bound copies. The session file keeps the tool result as the tool wrote it.
 */
import * as crypto from "node:crypto";
import type { Message } from "@oh-my-pi/pi-ai";
import type { SecretObfuscator } from "../secrets/obfuscator";

/** What replaces a derived form in the provider-visible text. */
export const DERIVED_VALUE_MARKER = "[masked derived value]";

/** Appended to the system prompt of a masking session. Constant, so the provider's prompt-cache prefix is stable. */
export const DERIVED_VALUE_NOTICE =
	"Masked values: never print, hash, encode or otherwise derive output from a value written as a `$$…$$` placeholder " +
	"(digests, base64, hex, URL-encoding, character lists). The harness masks the forms it recognises, and a short " +
	"value's digest can be brute-forced. To check a value, compare it inside the command and print only the result.";

/** Shortest base64 or percent-encoded form matched. Shorter strings occur by chance everywhere. */
const MIN_ENCODED = 6;
/** Shortest hex encoding of a value matched. */
const MIN_HEX = 8;
/** Shortest prefix or suffix of a digest matched: 24 bits of a digest already identify a short value. */
const MIN_DIGEST_PART = 6;
/** Longest value derived forms are built for. Longer ones (a private key) keep to digests. */
const MAX_VALUE_LENGTH = 4096;
const DIGESTS = ["md5", "sha1", "sha256", "sha512"] as const;
/** Characters of a base64 group that the embedded value does not alone determine, by byte offset. */
const BASE64_LEADING_MIXED = [0, 2, 3] as const;
const HEX_RUN = /[0-9a-fA-F]{6,}/g;

interface DerivedForms {
	/** Matched as written. */
	exact: string[];
	/** Matched ignoring case. */
	folded: string[];
	/** Lowercase hex digests: matched whole inside a longer run, or as a prefix or suffix. */
	digests: string[];
}

const formsBySecret = new Map<string, DerivedForms>();
const MAX_CACHED_SECRETS = 2048;

function urlSafe(text: string): string {
	return text.replaceAll("+", "-").replaceAll("/", "_");
}

/** Standard and URL-safe, padded and not, for a whole base64 text. */
function base64Variants(bytes: Uint8Array): string[] {
	const padded = Buffer.from(bytes).toString("base64");
	const bare = padded.replace(/=+$/, "");
	return [padded, bare, urlSafe(padded), urlSafe(bare)];
}

/** The characters of the base64 of `value` at each byte offset of a larger text that the value alone fixes. */
function base64Embedded(value: Buffer): string[] {
	const forms: string[] = [];
	for (let offset = 0; offset < 3; offset++) {
		const total = offset + value.length;
		const encoded = Buffer.concat([Buffer.alloc(offset), value])
			.toString("base64")
			.replace(/=+$/, "");
		const end = total % 3 === 0 ? encoded.length : encoded.length - 1;
		const part = encoded.slice(BASE64_LEADING_MIXED[offset], end);
		if (part.length >= MIN_ENCODED) forms.push(part, urlSafe(part));
	}
	return forms;
}

function deriveForms(secret: string): DerivedForms {
	const cached = formsBySecret.get(secret);
	if (cached !== undefined) return cached;
	const exact = new Set<string>();
	const folded = new Set<string>();
	const digests = new Set<string>();
	const value = Buffer.from(secret, "utf8");
	if (value.length <= MAX_VALUE_LENGTH) {
		for (const form of base64Variants(value)) if (form.length >= MIN_ENCODED) exact.add(form);
		for (const form of base64Embedded(value)) exact.add(form);
		const hex = value.toString("hex");
		if (hex.length >= MIN_HEX) folded.add(hex);
		const percent = encodeURIComponent(secret);
		if (percent !== secret && percent.length >= MIN_ENCODED) folded.add(percent);
	}
	for (const input of [value, Buffer.concat([value, Buffer.from("\n")])]) {
		for (const algorithm of DIGESTS) {
			const digest = crypto.createHash(algorithm).update(input).digest();
			digests.add(digest.toString("hex"));
			for (const form of base64Variants(digest)) exact.add(form);
		}
	}
	const forms: DerivedForms = { exact: [...exact], folded: [...folded], digests: [...digests] };
	if (formsBySecret.size >= MAX_CACHED_SECRETS) formsBySecret.clear();
	formsBySecret.set(secret, forms);
	return forms;
}

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One alternation, longest first so a padded form wins over its unpadded prefix. */
function alternation(literals: Iterable<string>, flags: string): RegExp | undefined {
	const unique = [...new Set(literals)].sort((a, b) => b.length - a.length);
	return unique.length === 0 ? undefined : new RegExp(unique.map(escapeRegex).join("|"), flags);
}

/** Longest text kept in the per-matcher result cache, and how many texts. */
const MAX_MEMO_TEXT = 1 << 20;
const MAX_MEMO_ENTRIES = 512;

class DerivedMatcher {
	readonly revision: number;
	readonly #exact: RegExp | undefined;
	readonly #folded: RegExp | undefined;
	readonly #prefixes = new Map<string, string[]>();
	readonly #suffixes = new Map<string, string[]>();
	readonly #memo = new Map<string, string>();

	constructor(revision: number, secrets: readonly string[]) {
		this.revision = revision;
		const exact: string[] = [];
		const folded: string[] = [];
		for (const secret of secrets) {
			if (secret.length === 0) continue;
			const forms = deriveForms(secret);
			exact.push(...forms.exact);
			folded.push(...forms.folded, ...forms.digests);
			for (const digest of forms.digests) {
				addTo(this.#prefixes, digest.slice(0, MIN_DIGEST_PART), digest);
				addTo(this.#suffixes, digest.slice(-MIN_DIGEST_PART), digest);
			}
		}
		this.#exact = alternation(exact, "g");
		this.#folded = alternation(folded, "gi");
	}

	/** Whether any form is known: a registry with only empty values has nothing to look for. */
	get empty(): boolean {
		return this.#exact === undefined && this.#folded === undefined;
	}

	mask(text: string): string {
		if (text.length < MIN_DIGEST_PART) return text;
		const memoized = this.#memo.get(text);
		if (memoized !== undefined) return memoized;
		const masked = this.#maskNow(text);
		if (text.length <= MAX_MEMO_TEXT) {
			if (this.#memo.size >= MAX_MEMO_ENTRIES) this.#memo.clear();
			this.#memo.set(text, masked);
		}
		return masked;
	}

	#maskNow(text: string): string {
		let result = text;
		if (this.#exact !== undefined) result = result.replace(this.#exact, DERIVED_VALUE_MARKER);
		if (this.#folded !== undefined) result = result.replace(this.#folded, DERIVED_VALUE_MARKER);
		return result.replace(HEX_RUN, run => (this.#isDigestPart(run.toLowerCase()) ? DERIVED_VALUE_MARKER : run));
	}

	/** Whether a hex run is a prefix or suffix of a digest (a whole digest inside a run was matched above). */
	#isDigestPart(run: string): boolean {
		for (const digest of this.#prefixes.get(run.slice(0, MIN_DIGEST_PART)) ?? []) {
			if (digest.startsWith(run)) return true;
		}
		for (const digest of this.#suffixes.get(run.slice(-MIN_DIGEST_PART)) ?? []) {
			if (digest.endsWith(run)) return true;
		}
		return false;
	}
}

function addTo(map: Map<string, string[]>, key: string, value: string): void {
	const list = map.get(key);
	if (list === undefined) map.set(key, [value]);
	else list.push(value);
}

const matchers = new WeakMap<SecretObfuscator, DerivedMatcher>();

function matcherOf(obfuscator: SecretObfuscator): DerivedMatcher {
	const { revision, values } = obfuscator.secretValues();
	const known = matchers.get(obfuscator);
	if (known !== undefined && known.revision === revision) return known;
	const built = new DerivedMatcher(revision, values);
	matchers.set(obfuscator, built);
	return built;
}

/** Masks the derived forms of the session's masked values in one piece of text. */
export function maskDerivedText(obfuscator: SecretObfuscator | undefined, text: string): string {
	if (!obfuscator?.obfuscates()) return text;
	const matcher = matcherOf(obfuscator);
	return matcher.empty ? text : matcher.mask(text);
}

/**
 * Masks the derived forms in the user, developer and tool result messages of a request: where a tool's output
 * comes back. Returns the given array itself when nothing in it matches.
 */
export function maskDerivedMessages(obfuscator: SecretObfuscator | undefined, messages: Message[]): Message[] {
	if (!obfuscator?.obfuscates()) return messages;
	const matcher = matcherOf(obfuscator);
	if (matcher.empty) return messages;
	let changed = false;
	const masked = messages.map((message): Message => {
		if (message.role !== "user" && message.role !== "developer" && message.role !== "toolResult") return message;
		if (typeof message.content === "string") {
			const content = matcher.mask(message.content);
			if (content === message.content) return message;
			changed = true;
			return { ...message, content } as Message;
		}
		let blocksChanged = false;
		const content = message.content.map(block => {
			if (block.type !== "text") return block;
			const text = matcher.mask(block.text);
			if (text === block.text) return block;
			blocksChanged = true;
			return { ...block, text };
		});
		if (!blocksChanged) return message;
		changed = true;
		return { ...message, content } as Message;
	});
	return changed ? masked : messages;
}

/** The system prompt of a masking session with {@link DERIVED_VALUE_NOTICE} added once. */
export function withDerivedValueNotice(systemPrompt: string[] | undefined): string[] | undefined {
	if (systemPrompt === undefined || systemPrompt.includes(DERIVED_VALUE_NOTICE)) return systemPrompt;
	return [...systemPrompt, DERIVED_VALUE_NOTICE];
}
