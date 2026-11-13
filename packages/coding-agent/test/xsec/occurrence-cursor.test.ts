/**
 * Package 14b: the occurrence cursor must answer each query as a fresh `indexOf` from that query's position does, in any
 * order of queries. `emitChunk` used to assume that queries never move back: after a miss, a backward query got -1 for
 * an occurrence it had passed, so a masked secret could be left in the output.
 */
import { describe, expect, it } from "bun:test";
import { createOccurrenceCursor } from "@oh-my-pi/pi-coding-agent/xsec/occurrence-cursor";

const ROUNDS = 4000;
const QUERIES_PER_ROUND = 40;

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

describe("occurrence cursor", () => {
	it("answers each query as indexOf from that position does, whatever the order of the queries", () => {
		const mismatches: string[] = [];
		for (let round = 0; round < ROUNDS; round++) {
			const rand = seededRandom(0x0c0a0000 + round);
			const text = randomString(rand, "ab$", Math.floor(rand() * 40));
			const search = randomString(rand, "ab$", 1 + Math.floor(rand() * 3));
			const queries = Array.from({ length: QUERIES_PER_ROUND }, () => Math.floor(rand() * (text.length + 3)));
			// Every other round asks in increasing order, as emitChunk does; the rest ask in any order.
			if (round % 2 === 0) queries.sort((a, b) => a - b);
			const cursor = createOccurrenceCursor(text, search);
			for (const from of queries) {
				if (cursor.next(from) !== text.indexOf(search, from)) {
					mismatches.push(`text=${text} search=${search} from=${from}`);
				}
			}
		}
		expect({ count: mismatches.length, first: mismatches.slice(0, 5) }).toEqual({ count: 0, first: [] });
	});

	it("finds an occurrence before a query that had missed", () => {
		// The miss from 1 shows nothing matches at or after 1. A query from 0 must still find the match at 0.
		const cursor = createOccurrenceCursor("abxxxx", "ab");
		expect(cursor.next(1)).toBe(-1);
		expect(cursor.next(0)).toBe(0);
	});

	it("finds an earlier occurrence after a query that had found a later one", () => {
		const cursor = createOccurrenceCursor("abxxab", "ab");
		expect(cursor.next(3)).toBe(4);
		expect(cursor.next(0)).toBe(0);
	});

	it("rejects an empty search, which indexOf matches at every position", () => {
		expect(() => createOccurrenceCursor("abc", "")).toThrow(RangeError);
	});
});
