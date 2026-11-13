/**
 * Package 14b: the masking output of a seeded corpus must not change, and obfuscation must stay reversible.
 *
 * A digest that differs names the case whose output changed. The committed digests come from xsec 24b99c63, before
 * the batched regex edits and the cached `emitChunk` search. Failing here means a masking change altered output, not
 * that the digest is stale; regenerate only in a sync pull request that names the upstream change.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { type SecretEntry, SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets/obfuscator";
import { DEFAULT_MIN_OBFUSCATE_LENGTH, setMinObfuscateLength } from "@oh-my-pi/pi-coding-agent/xsec/secret-min-length";
import committedJson from "./masking-golden.json" with { type: "json" };
import { buildGoldenCase, GOLDEN_CASE_COUNT, GOLDEN_KEY, goldenDigests } from "./masking-golden";

const committed: Record<string, string> = committedJson;

describe("masking golden outputs", () => {
	// `secrets.minObfuscateLength` is process-wide, so the cases run at its default whatever ran before them.
	beforeAll(() => {
		setMinObfuscateLength(DEFAULT_MIN_OBFUSCATE_LENGTH);
	});

	it("reproduces the committed digest of every case", () => {
		const digests = goldenDigests();
		expect(Object.keys(digests)).toHaveLength(GOLDEN_CASE_COUNT);
		expect(Object.keys(digests)).toEqual(Object.keys(committed));
		const changed = Object.keys(digests).filter(id => digests[id] !== committed[id]);
		expect(changed).toEqual([]);
	});

	it("deobfuscates the raw text of each case with no replace-mode entry back to itself", () => {
		let checked = 0;
		const failures: string[] = [];
		for (let index = 0; index < GOLDEN_CASE_COUNT; index++) {
			const golden = buildGoldenCase(index);
			// Replace mode is one-way by design: its output keeps no way back to the matched text.
			if (golden.entries.some((entry: SecretEntry) => entry.mode === "replace")) continue;
			checked++;
			const obfuscator = new SecretObfuscator(golden.entries, GOLDEN_KEY);
			for (const raw of golden.rawTurns) {
				if (obfuscator.deobfuscate(obfuscator.obfuscate(raw)) !== raw) failures.push(golden.id);
			}
		}
		expect(checked).toBeGreaterThan(0);
		expect(failures).toEqual([]);
	});
});
