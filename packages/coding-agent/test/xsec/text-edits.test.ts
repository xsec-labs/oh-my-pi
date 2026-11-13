/**
 * Package 14b: `applyTextEdits` must give the text and origin tags of one `replaceRange` call per edit, for every edit
 * list. The masking obfuscator applies a regex entry's edits in one pass on that promise, so a difference here would
 * change masked output.
 */
import { describe, expect, it } from "bun:test";
import { replaceRange } from "@oh-my-pi/pi-coding-agent/secrets/placeholder-scan";
import { applyTextEdits, isDescendingDisjoint, type TextEdit } from "@oh-my-pi/pi-coding-agent/xsec/text-edits";

const ROUNDS = 3000;

function applyEachEdit(text: string, origin: string, edits: readonly TextEdit[]): { text: string; origin: string } {
	let result = text;
	let tags = origin;
	for (const edit of edits) {
		result = replaceRange(result, edit.start, edit.end, edit.text);
		tags = replaceRange(tags, edit.start, edit.end, edit.origin);
	}
	return { text: result, origin: tags };
}

/** mulberry32, so every round is the same on every run. */
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

function randomString(rand: () => number, alphabet: string, length: number): string {
	let out = "";
	for (let i = 0; i < length; i++) out += alphabet.charAt(Math.floor(rand() * alphabet.length));
	return out;
}

function edit(start: number, end: number, text: string): TextEdit {
	return { start, end, text, origin: "F".repeat(text.length) };
}

/** Disjoint edits, left to right with gaps or none between them (empty ones too), listed in descending order. */
function disjointDescendingEdits(rand: () => number, length: number): TextEdit[] {
	const edits: TextEdit[] = [];
	let cursor = 0;
	while (edits.length < 4) {
		const start = cursor + Math.floor(rand() * 3);
		const end = start + Math.floor(rand() * 3);
		if (end > length) break;
		edits.push(edit(start, end, randomString(rand, "xyz", Math.floor(rand() * 4))));
		cursor = end + (rand() < 0.5 ? 0 : 1);
	}
	return edits.reverse();
}

/** Arbitrary edits, which overlap and come in any order more often than not. */
function arbitraryEdits(rand: () => number, length: number): TextEdit[] {
	const edits: TextEdit[] = [];
	for (let i = Math.floor(rand() * 5); i > 0; i--) {
		const start = Math.floor(rand() * (length + 1));
		const end = start + Math.floor(rand() * (length - start + 1));
		edits.push(edit(start, end, randomString(rand, "xyz", Math.floor(rand() * 4))));
	}
	return edits;
}

describe("applyTextEdits", () => {
	it("gives the text and origin tags of one replaceRange per edit, for disjoint and arbitrary edit lists", () => {
		const rand = seededRandom(20261113);
		const mismatches: string[] = [];
		let onePass = 0;
		for (let round = 0; round < ROUNDS; round++) {
			const length = Math.floor(rand() * 25);
			const text = randomString(rand, "abc", length);
			const origin = randomString(rand, "IF", length);
			const edits = round % 2 === 0 ? disjointDescendingEdits(rand, length) : arbitraryEdits(rand, length);
			if (isDescendingDisjoint(edits)) onePass++;
			const expected = applyEachEdit(text, origin, edits);
			const actual = applyTextEdits(text, origin, edits);
			if (actual.text !== expected.text || actual.origin !== expected.origin) {
				mismatches.push(`round ${round}: text=${text} edits=${JSON.stringify(edits)}`);
			}
		}
		expect(mismatches).toEqual([]);
		// The disjoint lists must reach the one-pass path, and the arbitrary ones must include some that do not.
		expect(onePass).toBeGreaterThan(ROUNDS / 4);
		expect(onePass).toBeLessThan(ROUNDS);
	});

	it("replaces each span and its origin tags, in a descending disjoint list", () => {
		const edits = [edit(4, 5, "XY"), edit(1, 2, "")];
		expect(applyTextEdits("abcdef", "IIIIII", edits)).toEqual({ text: "acdXYf", origin: "IIIFFI" });
	});

	it("applies an overlapping list edit by edit, as the second edit sees the first one's output", () => {
		// The first edit leaves "Xdef", so the second one, over [2, 4), replaces "ef" of that text.
		const edits = [edit(0, 3, "X"), edit(2, 4, "Y")];
		expect(applyTextEdits("abcdef", "IIIIII", edits).text).toBe("XdY");
	});
});

describe("isDescendingDisjoint", () => {
	it("accepts descending lists whose ranges touch or are empty, and rejects overlap, ascending order and inverted ranges", () => {
		expect(isDescendingDisjoint([])).toBe(true);
		expect(isDescendingDisjoint([{ start: 0, end: 0 }])).toBe(true);
		expect(
			isDescendingDisjoint([
				{ start: 5, end: 6 },
				{ start: 2, end: 5 },
			]),
		).toBe(true);
		expect(
			isDescendingDisjoint([
				{ start: 5, end: 6 },
				{ start: 2, end: 4 },
			]),
		).toBe(true);
		expect(
			isDescendingDisjoint([
				{ start: 2, end: 5 },
				{ start: 4, end: 6 },
			]),
		).toBe(false);
		expect(
			isDescendingDisjoint([
				{ start: 2, end: 4 },
				{ start: 5, end: 6 },
			]),
		).toBe(false);
		expect(isDescendingDisjoint([{ start: 3, end: 2 }])).toBe(false);
	});
});
