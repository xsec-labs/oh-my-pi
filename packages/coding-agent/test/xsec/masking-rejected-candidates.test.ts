/**
 * Package 14b: a placeholder-shaped token that no obfuscator generated is a rejected candidate. The scan must leave it
 * as it is and resume inside it, so a secret beside it is still masked. These seeded cases put fake tokens next to
 * secret occurrences with no separator, over three turns of one obfuscator, and check what every turn must keep.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { type SecretEntry, SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import { DEFAULT_MIN_OBFUSCATE_LENGTH, setMinObfuscateLength } from "@oh-my-pi/pi-coding-agent/xsec/secret-min-length";

const CASES = 300;
const TURNS = 3;
const KEY = "rejected-candidates-key-made-up-0001";
/** Placeholder-shaped and never generated: PLACEHOLDER_RE matches each one, and the obfuscator refuses it. */
const FAKES = ["$$WORD_ABCD$$", "$$ABCD$$", "$$K9_QQQQ$$", "$$WORD_ZZZZ:U$$", "$$QQQQ1234$$", "$$WORD_0000$$"];
const FRAGMENTS = ["$$", "$", "_", "A", "0", "W", "ORD", "X", " ", "\n", "$_", "$$W"];
/** The fragments without `$`, for the round-trip case below. */
const DOLLAR_FREE_FRAGMENTS = ["_", "A", "0", "W", "ORD", "X", " ", "\n"];
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const SECRET_CHARS = `${LOWER}ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-`;

/**
 * A secret has no `$` and starts with a lowercase letter. Then no occurrence of it can overlap a fake token: an overlap
 * would put the secret over a fake's first or last `$`, and a secret lying inside a fake would need a lowercase letter,
 * which no fake has.
 */
function randomSecret(rand: () => number): string {
	const length = 8 + Math.floor(rand() * 7);
	let secret = LOWER.charAt(Math.floor(rand() * LOWER.length));
	for (let i = 1; i < length; i++) secret += SECRET_CHARS.charAt(Math.floor(rand() * SECRET_CHARS.length));
	return secret;
}

/** mulberry32, so every case is the same on every run. */
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

function pick<T>(rand: () => number, items: readonly T[]): T {
	return items[Math.floor(rand() * items.length)]!;
}

function distinctSecrets(rand: () => number): string[] {
	return [...new Set(Array.from({ length: 1 + Math.floor(rand() * 3) }, () => randomSecret(rand)))];
}

function toEntry(content: string): SecretEntry {
	return { type: "plain", content };
}

/**
 * Secrets, partial secrets, earlier output cut at a random point, and `filler` pieces, with no separators between them.
 */
function buildText(
	rand: () => number,
	secrets: readonly string[],
	history: readonly string[],
	filler: readonly string[],
): string {
	let out = "";
	for (let pieces = 3 + Math.floor(rand() * 14); pieces > 0; pieces--) {
		const roll = rand();
		if (roll < 0.3) {
			out += pick(rand, secrets);
		} else if (roll < 0.45) {
			const secret = pick(rand, secrets);
			const start = Math.floor(rand() * secret.length);
			out += secret.slice(start, start + 1 + Math.floor(rand() * (secret.length - start)));
		} else if (roll < 0.55 && history.length > 0) {
			const earlier = pick(rand, history);
			const start = Math.floor(rand() * earlier.length);
			out += earlier.slice(start, start + 1 + Math.floor(rand() * 24));
		} else {
			out += pick(rand, filler);
		}
	}
	return out;
}

function countOccurrences(text: string, token: string): number {
	return text.split(token).length - 1;
}

describe("masking with rejected candidates", () => {
	beforeAll(() => {
		// `secrets.minObfuscateLength` is process-wide. Every secret here is at least 8 characters long.
		setMinObfuscateLength(DEFAULT_MIN_OBFUSCATE_LENGTH);
	});

	it("masks every secret, with fake tokens beside it, in every turn", () => {
		const leaks: string[] = [];
		let fakeOccurrences = 0;
		for (let c = 0; c < CASES; c++) {
			const rand = seededRandom(0x0ca5e000 + c);
			const secrets = distinctSecrets(rand);
			const obfuscator = new SecretObfuscator(secrets.map(toEntry), KEY);
			let previous = "";
			const history: string[] = [];
			for (let turn = 0; turn < TURNS; turn++) {
				// Each call gets the previous output followed by new text, as a session re-sends its history.
				const input = previous + buildText(rand, secrets, history, [...FAKES, ...FRAGMENTS]);
				const output = obfuscator.obfuscate(input);
				for (const secret of secrets) {
					if (output.includes(secret)) leaks.push(`case ${c} turn ${turn}`);
				}
				for (const fake of FAKES) fakeOccurrences += countOccurrences(input, fake);
				history.push(output);
				previous = output;
			}
		}
		expect(fakeOccurrences).toBeGreaterThan(0);
		expect({ count: leaks.length, first: leaks.slice(0, 5) }).toEqual({ count: 0, first: [] });
	});

	it("leaves a text with fake tokens and no secret exactly as it is", () => {
		// No secret occurrence exists here, so nothing is replaced: any change would come from the rejected candidates.
		let fakeOccurrences = 0;
		const changed: string[] = [];
		for (let c = 0; c < CASES; c++) {
			const rand = seededRandom(0x0ca5e800 + c);
			const secrets = distinctSecrets(rand);
			const obfuscator = new SecretObfuscator(secrets.map(toEntry), KEY);
			let text = "";
			for (let pieces = 3 + Math.floor(rand() * 14); pieces > 0; pieces--)
				text += pick(rand, [...FAKES, ...FRAGMENTS]);
			fakeOccurrences += FAKES.reduce((sum, fake) => sum + countOccurrences(text, fake), 0);
			if (obfuscator.obfuscate(text) !== text) changed.push(`case ${c}`);
		}
		expect(fakeOccurrences).toBeGreaterThan(0);
		expect({ count: changed.length, first: changed.slice(0, 5) }).toEqual({ count: 0, first: [] });
	});

	it("deobfuscates a text with no placeholder of its own back to itself", () => {
		// The text has no `$` outside the placeholders it gets. Fake tokens are left out on purpose: a fake token can join a
		// placeholder at the seam, and deobfuscate then misses the placeholder after it. That gap is already at 24b99c63.
		const failures: string[] = [];
		for (let c = 0; c < CASES; c++) {
			const rand = seededRandom(0x0ca5e000 + c);
			const secrets = distinctSecrets(rand);
			const obfuscator = new SecretObfuscator(secrets.map(toEntry), KEY);
			const text = buildText(rand, secrets, [], DOLLAR_FREE_FRAGMENTS);
			if (obfuscator.deobfuscate(obfuscator.obfuscate(text)) !== text) failures.push(`case ${c}`);
		}
		expect({ count: failures.length, first: failures.slice(0, 5) }).toEqual({ count: 0, first: [] });
	});
});
