/**
 * Golden masking outputs for package 14b. Each case comes from a fixed seed and runs three turns through one
 * obfuscator. Each turn's input is the previous output followed by new raw text, as a session re-sends its
 * history. `masking-golden.json` keeps one digest per case, taken before the masking path changed, so a change
 * that alters any output fails the golden test.
 *
 * Cases from `PLAIN_CASE_COUNT` on also mix in `FAKE_TOKENS`, placeholder-shaped tokens that no obfuscator generated,
 * so the scan rejects candidates in them. Their digests were taken at 24b99c63 as well.
 *
 * Regenerate only in a sync pull request that names the upstream change:
 *   bun packages/coding-agent/test/xsec/masking-golden.ts --write
 */
import { createHash } from "node:crypto";
import * as path from "node:path";
import { type SecretEntry, SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";

/** Fixed, so the placeholders do not depend on a per-install key file. Made up. */
export const GOLDEN_KEY = "golden-masking-key-made-up-for-tests-0001";
/** The cases below this index are the corpus whose digests were committed first. */
const PLAIN_CASE_COUNT = 240;
const REJECTED_CASE_COUNT = 60;
export const GOLDEN_CASE_COUNT = PLAIN_CASE_COUNT + REJECTED_CASE_COUNT;
const TURNS = 3;

const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const LOWER_ALNUM = `${LOWER}0123456789`;
const FILLER = [
	"The build finished and the tests passed.",
	"Résumé 数据 ok — see the log below:",
	"  indented line with\ttabs",
	"Path: /var/tmp/run/out.txt; retry in 5s.",
	"x = y + 1, z = [a, b, c]",
	"Error: connection reset by peer",
	"",
];
const SEPARATORS = ["", "", "", " ", "\n", "  "];
/** Placeholder-shaped and never generated: the scan rejects each one and resumes inside it. */
const FAKE_TOKENS = ["$$WORD_ABCD$$", "$$ABCD$$", "$$K9_QQQQ$$", "$$WORD_ZZZZ:U$$", "$$QQQQ1234$$", "$$WORD_0000$$"];

interface RegexTemplate {
	entry: SecretEntry;
	/** Makes one token that the template's regex matches. */
	token(rand: () => number): string;
}

/** Dashed, so its match runs into a placeholder's expanded secret (which contains `-`) when the two touch. */
const GLUE_TEMPLATE: RegexTemplate = {
	entry: { type: "regex", content: "tok_[A-Za-z0-9-]{5,}", literalPrefixes: ["tok_"] },
	token: rand => `tok_${randomString(rand, ALNUM, between(rand, 2, 8))}`,
};

const REGEX_TEMPLATES: readonly RegexTemplate[] = [
	{
		entry: { type: "regex", content: "tok_[A-Za-z0-9]{20}", literalPrefixes: ["tok_"] },
		token: rand => `tok_${randomString(rand, ALNUM, 20)}`,
	},
	{
		entry: { type: "regex", content: "sk-[A-Za-z0-9]{12,}", literalPrefixes: ["sk-"], friendlyName: "openai" },
		token: rand => `sk-${randomString(rand, ALNUM, between(rand, 8, 24))}`,
	},
	{
		entry: { type: "regex", content: "\\b[A-Za-z0-9]{24}\\b" },
		token: rand => randomString(rand, ALNUM, 24),
	},
	{
		entry: { type: "regex", content: "api_key=[a-z0-9]{6,}", literalPrefixes: ["api_key="], friendlyName: "api_key" },
		token: rand => `api_key=${randomString(rand, LOWER_ALNUM, between(rand, 6, 10))}`,
	},
	{
		// Mostly shorter than the minimum length: the regex runs, and nothing is masked.
		entry: { type: "regex", content: "\\b[a-z]{2,5}\\b" },
		token: rand => randomString(rand, LOWER, between(rand, 2, 5)),
	},
	{
		entry: { type: "regex", content: "ghp_[A-Za-z0-9]{16}\\b", literalPrefixes: ["ghp_"] },
		token: rand => `ghp_${randomString(rand, ALNUM, 16)}`,
	},
	{
		entry: {
			type: "regex",
			content: "password=\\S+",
			literalPrefixes: ["password="],
			mode: "replace",
			replacement: "password=***",
		},
		token: rand => `password=${randomString(rand, ALNUM, between(rand, 6, 12))}`,
	},
	{
		entry: { type: "regex", content: "\\bsecret-[0-9]{4}\\b", literalPrefixes: ["secret-"], mode: "replace" },
		token: rand => `secret-${randomString(rand, "0123456789", 4)}`,
	},
];

export interface GoldenCase {
	id: string;
	entries: SecretEntry[];
	/** Raw text of each turn, without the history that the obfuscated run appends. */
	rawTurns: string[];
}

export interface GoldenRun {
	/** The obfuscated output of each turn. */
	outputs: string[];
	/** `deobfuscate` of each output. */
	deobfuscated: string[];
}

export function buildGoldenCase(index: number): GoldenCase {
	const rand = seededRandom(0x14b00 + index);
	const entries: SecretEntry[] = [];
	const plainSecrets: string[] = [];
	const plainCount = between(rand, 1, 5);
	for (let k = 0; k < plainCount; k++) {
		const secret = `golden-${index}-${k}-${randomString(rand, ALNUM, between(rand, 6, 14))}`;
		entries.push({ type: "plain", content: secret });
		plainSecrets.push(secret);
		if (rand() < 0.25) {
			// A prefix of the secret, listed after it, so the whole secret is masked first.
			const prefix = secret.slice(0, -3);
			entries.push({ type: "plain", content: prefix });
			plainSecrets.push(prefix);
		}
	}
	if (rand() < 0.3) {
		// Shorter than the default minimum length, so it is never masked.
		entries.push({ type: "plain", content: "gold1" });
		plainSecrets.push("gold1");
	}
	if (rand() < 0.2) {
		const replaceSecret = `golden-replace-${index}-${randomString(rand, ALNUM, 8)}`;
		entries.push({ type: "plain", content: replaceSecret, mode: "replace" });
		plainSecrets.push(replaceSecret);
	}
	const templates = [GLUE_TEMPLATE, ...pickDistinct(rand, REGEX_TEMPLATES, between(rand, 1, 4))];
	for (const template of templates) entries.push(template.entry);

	const rejected = index >= PLAIN_CASE_COUNT;
	const rawTurns: string[] = [];
	for (let turn = 0; turn < TURNS; turn++) {
		let text = "";
		for (let piece = between(rand, 8, 18); piece > 0; piece--) {
			const roll = rand();
			let next: string;
			// The extra draw happens only in the rejected cases, so the plain cases keep their sequence.
			if (rejected && rand() < 0.3) next = pick(rand, FAKE_TOKENS);
			else if (roll < 0.35) next = pick(rand, plainSecrets);
			else if (roll < 0.6) next = pick(rand, templates).token(rand);
			else next = pick(rand, FILLER);
			text += next + pick(rand, SEPARATORS);
		}
		// Glue across turns: a token right after the history, and a secret right before the next turn, so a
		// placeholder from an earlier call touches a regex match with no separator between them.
		if (turn > 0 && rand() < 0.6) text = GLUE_TEMPLATE.token(rand) + text;
		if (rand() < 0.6) text += pick(rand, plainSecrets);
		rawTurns.push(text);
	}
	return { id: `c${String(index).padStart(3, "0")}`, entries, rawTurns };
}

export function runGoldenCase(golden: GoldenCase): GoldenRun {
	const obfuscator = new SecretObfuscator(golden.entries, GOLDEN_KEY);
	const outputs: string[] = [];
	let previous = "";
	for (const raw of golden.rawTurns) {
		const output = obfuscator.obfuscate(previous + raw);
		outputs.push(output);
		previous = output;
	}
	return { outputs, deobfuscated: outputs.map(output => obfuscator.deobfuscate(output)) };
}

export function digestGoldenRun(run: GoldenRun): string {
	return createHash("sha256").update(JSON.stringify(run)).digest("hex");
}

/** The digest of every case, keyed by case id, in index order. */
export function goldenDigests(): Record<string, string> {
	const digests: Record<string, string> = {};
	for (let index = 0; index < GOLDEN_CASE_COUNT; index++) {
		const golden = buildGoldenCase(index);
		digests[golden.id] = digestGoldenRun(runGoldenCase(golden));
	}
	return digests;
}

/** mulberry32: a small seeded generator, so every case is the same on every run. */
function seededRandom(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function between(rand: () => number, min: number, max: number): number {
	return min + Math.floor(rand() * (max - min + 1));
}

function pick<T>(rand: () => number, items: readonly T[]): T {
	return items[Math.floor(rand() * items.length)]!;
}

function pickDistinct<T>(rand: () => number, items: readonly T[], count: number): T[] {
	const pool = [...items];
	const chosen: T[] = [];
	while (chosen.length < count && pool.length > 0) {
		const [item] = pool.splice(Math.floor(rand() * pool.length), 1);
		chosen.push(item!);
	}
	return chosen;
}

function randomString(rand: () => number, alphabet: string, length: number): string {
	let out = "";
	for (let i = 0; i < length; i++) out += alphabet.charAt(Math.floor(rand() * alphabet.length));
	return out;
}

if (import.meta.main) {
	if (!process.argv.includes("--write")) {
		console.error("Usage: bun packages/coding-agent/test/xsec/masking-golden.ts --write");
		process.exit(1);
	}
	const digests = goldenDigests();
	await Bun.write(path.join(import.meta.dir, "masking-golden.json"), `${JSON.stringify(digests, null, "\t")}\n`);
	console.log(`wrote ${Object.keys(digests).length} digests`);
}
