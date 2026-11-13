#!/usr/bin/env bun
/**
 * Package 14a of the fork work packages (diagnosis, no behaviour change): how the
 * time of `SecretObfuscator.obfuscate` grows with the number of matches, for plain
 * entries and regex entries. All text is made up.
 *
 * Usage, from the checkout root:
 *   bun scripts/xsec/masking-scaling.ts [--sizes 1000,4000,16000]
 *     [--shapes plain-same,plain-distinct,regex,regex-after-placeholders] [--budget-ms 300000]
 *
 * Shapes, each with N matches in the text:
 * - plain-same: one plain secret occurs N times;
 * - plain-distinct: N different plain secrets occur once each;
 * - regex: one regex entry matches N different tokens, each a new placeholder;
 * - regex-after-placeholders: an earlier call (not timed) masks N tokens into placeholders, then
 *   the timed call masks N new tokens in a text that already holds those N placeholders.
 *
 * Every measurement runs in a child process with a time budget, so a size that
 * takes too long is reported as stopped and the run goes on. Time comes from a
 * child that runs the code unchanged. A second child runs the same input with
 * counters on `String.prototype.slice` and `String.prototype.indexOf`, which exist
 * only in that child: `sliceChars` adds up the length of the string each `slice` is
 * called on. When that string is a rope (the regex path's growing result), V8 copies
 * all of it on the first slice, so the sum is the copy work, though it counts both
 * slices of each replacement, so it is about twice the characters copied. For a flat
 * string (the plain path's input) V8 copies nothing, so the sum overstates that path.
 * `indexOfChars` adds up the characters `indexOf` scans, which is real work on both
 * paths. The checkout is never changed.
 *
 * `exponent` is log(time ratio) / log(size ratio) between two consecutive sizes
 * that both finished: about 1 means linear, 2 quadratic, 3 cubic.
 */
import { parseArgs } from "node:util";
import { $ } from "bun";
import { type SecretEntry, SecretObfuscator } from "../../packages/coding-agent/src/secrets/obfuscator";
import { repoRoot } from "./upstream";

const SHAPES = ["plain-same", "plain-distinct", "regex", "regex-after-placeholders"] as const;
type Shape = (typeof SHAPES)[number];
type Mode = "time" | "count";

const DEFAULT_SIZES = [1000, 4000, 16000];
const DEFAULT_BUDGET_MS = 300_000;
/** Fixed here, so the run reads no per-install key file. Made up. */
const PLACEHOLDER_KEY = "synthetic-placeholder-key-0123456789abcdef";
const SEED = 20261113;
const TOKEN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const FILLER = " lorem ipsum dolor sit amet, consectetur adipiscing elit. ";

interface WorkCounts {
	sliceCalls: number;
	sliceChars: number;
	indexOfCalls: number;
	indexOfChars: number;
}

interface Measurement {
	shape: Shape;
	matches: number;
	mode: Mode;
	inputChars: number;
	outputChars: number;
	/** Placeholders in the output; each match should have become one. */
	placeholders: number;
	ms: number;
	work?: WorkCounts;
}

interface Corpus {
	text: string;
	entries: SecretEntry[];
	/** Text that an earlier call masks before the timed one, for the shapes with existing placeholders. */
	primer?: string;
}

/** A 32-bit linear congruential generator, so every run builds the same text. */
function seededRandom(seed: number): () => number {
	let state = seed;
	return () => {
		state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;
		return state / 0x80000000;
	};
}

function randomToken(next: () => number, length: number): string {
	let token = "";
	for (let i = 0; i < length; i++) {
		token += TOKEN_ALPHABET.charAt(Math.floor(next() * TOKEN_ALPHABET.length));
	}
	return token;
}

function buildCorpus(shape: Shape, matches: number): Corpus {
	const next = seededRandom(SEED);
	const entries: SecretEntry[] = [];
	const parts: string[] = [];
	let primer: string[] | undefined;
	if (shape === "plain-same") {
		const secret = "synthetic-plain-secret-0001";
		entries.push({ type: "plain", content: secret });
		for (let i = 0; i < matches; i++) parts.push(secret + FILLER);
	} else if (shape === "plain-distinct") {
		for (let i = 0; i < matches; i++) {
			const secret = `synthetic-plain-${i}-${randomToken(next, 12)}`;
			entries.push({ type: "plain", content: secret });
			parts.push(secret + FILLER);
		}
	} else {
		// Both regex shapes share the entry. The second one masks a primer text first (see `measure`).
		entries.push({ type: "regex", content: "tok_[A-Za-z0-9]{20}", literalPrefixes: ["tok_"] });
		if (shape === "regex-after-placeholders") {
			primer = [];
			for (let i = 0; i < matches; i++) primer.push(`tok_${randomToken(next, 20)}${FILLER}`);
		}
		for (let i = 0; i < matches; i++) parts.push(`tok_${randomToken(next, 20)}${FILLER}`);
	}
	return { text: parts.join(""), entries, primer: primer?.join("") };
}

/** Counts the characters `slice` and `indexOf` handle in this process until `stop` runs. */
function startCountingStringWork(): { counts: WorkCounts; stop: () => void } {
	const counts: WorkCounts = { sliceCalls: 0, sliceChars: 0, indexOfCalls: 0, indexOfChars: 0 };
	const originalSlice = String.prototype.slice;
	const originalIndexOf = String.prototype.indexOf;
	String.prototype.slice = function slice(this: string, start?: number, end?: number): string {
		counts.sliceCalls++;
		counts.sliceChars += this.length;
		return originalSlice.call(this, start, end);
	};
	String.prototype.indexOf = function indexOf(this: string, search: string, position?: number): number {
		const from = Math.min(Math.max(position ?? 0, 0), this.length);
		const found = originalIndexOf.call(this, search, from);
		counts.indexOfCalls++;
		counts.indexOfChars += (found === -1 ? this.length : found) - from;
		return found;
	};
	return {
		counts,
		stop: () => {
			String.prototype.slice = originalSlice;
			String.prototype.indexOf = originalIndexOf;
		},
	};
}

function measure(shape: Shape, matches: number, mode: Mode): Measurement {
	const corpus = buildCorpus(shape, matches);
	// The obfuscator is built outside the timed call; the product builds it once per session.
	const obfuscator = new SecretObfuscator(corpus.entries, PLACEHOLDER_KEY);
	// The primer is masked by an earlier call that is not timed, and its work is not counted either.
	const input = corpus.primer === undefined ? corpus.text : obfuscator.obfuscate(corpus.primer) + corpus.text;
	const counter = mode === "count" ? startCountingStringWork() : undefined;
	const started = performance.now();
	const output = obfuscator.obfuscate(input);
	const ms = performance.now() - started;
	counter?.stop();
	const placeholders = (output.split("$$").length - 1) / 2;
	// Each new match becomes one placeholder; the placeholders of the primer stay in the output.
	const expected = corpus.primer === undefined ? matches : 2 * matches;
	if (placeholders !== expected) {
		throw new Error(
			`${shape} with ${matches} matches: ${placeholders} placeholders in the output, expected ${expected}`,
		);
	}
	return {
		shape,
		matches,
		mode,
		inputChars: input.length,
		outputChars: output.length,
		placeholders,
		ms: Math.round(ms * 10) / 10,
		work: counter?.counts,
	};
}

interface Outcome {
	status: "ok" | "stopped" | "failed";
	measurement?: Measurement;
	detail?: string;
}

async function runChild(shape: Shape, matches: number, mode: Mode, budgetMs: number): Promise<Outcome> {
	const child = Bun.spawn([process.execPath, import.meta.path, "--measure", `${shape}:${matches}:${mode}`], {
		cwd: repoRoot,
		stdout: "pipe",
		stderr: "pipe",
		timeout: budgetMs,
	});
	const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
	await child.exited;
	if (child.signalCode !== null) {
		return { status: "stopped", detail: `killed by ${child.signalCode} at the ${budgetMs} ms budget` };
	}
	if (child.exitCode !== 0) {
		return { status: "failed", detail: stderr.trim().split("\n").slice(-2).join(" | ") };
	}
	const line = stdout.trim().split("\n").at(-1) ?? "";
	return { status: "ok", measurement: JSON.parse(line) as Measurement };
}

function parseShapes(value: string): Shape[] {
	return value.split(",").map(name => {
		const shape = SHAPES.find(candidate => candidate === name.trim());
		if (shape === undefined) throw new Error(`unknown shape "${name}"; use ${SHAPES.join(", ")}`);
		return shape;
	});
}

function parseSizes(value: string): number[] {
	return value.split(",").map(item => {
		const size = Number(item.trim());
		if (!Number.isInteger(size) || size < 1) throw new Error(`a size must be an integer of 1 or more: "${item}"`);
		return size;
	});
}

function formatTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
	const widths = headers.map((header, column) => Math.max(header.length, ...rows.map(row => row[column]!.length)));
	const line = (cells: readonly string[]) => cells.map((cell, column) => cell.padStart(widths[column]!)).join("  ");
	return [line(headers), ...rows.map(line)].join("\n");
}

function count(value: number | undefined): string {
	return value === undefined ? "-" : value.toLocaleString("en-US");
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		args: Bun.argv.slice(2),
		options: {
			sizes: { type: "string" },
			shapes: { type: "string" },
			"budget-ms": { type: "string" },
			measure: { type: "string" },
		},
		strict: true,
	});

	if (values.measure !== undefined) {
		// Child mode: one measurement, printed as one JSON line.
		const [shapeName, matchesText, mode] = values.measure.split(":");
		const shape = parseShapes(shapeName ?? "")[0]!;
		const matches = parseSizes(matchesText ?? "")[0]!;
		if (mode !== "time" && mode !== "count") throw new Error(`mode must be time or count, not "${mode}"`);
		console.log(JSON.stringify(measure(shape, matches, mode)));
		return;
	}

	const shapes = values.shapes === undefined ? [...SHAPES] : parseShapes(values.shapes);
	const sizes = values.sizes === undefined ? DEFAULT_SIZES : parseSizes(values.sizes);
	const budgetMs = values["budget-ms"] === undefined ? DEFAULT_BUDGET_MS : Number(values["budget-ms"]);
	const commit = (await $`git rev-parse --short HEAD`.cwd(repoRoot).quiet().nothrow().text()).trim();

	console.log(
		`masking scaling: checkout ${commit || "unknown"}, bun ${Bun.version}, synthetic text, ` +
			`budget ${budgetMs} ms per child (time and work counts come from separate children)`,
	);

	const rows: string[][] = [];
	for (const shape of shapes) {
		let previous: { matches: number; ms: number } | undefined;
		for (const matches of sizes) {
			const timed = await runChild(shape, matches, "time", budgetMs);
			if (timed.measurement === undefined) {
				rows.push([
					shape,
					count(matches),
					"-",
					"-",
					"-",
					"-",
					"-",
					"-",
					"-",
					`${timed.status}: ${timed.detail ?? ""}`,
				]);
				previous = undefined;
				continue;
			}
			const counted = await runChild(shape, matches, "count", budgetMs);
			const work = counted.measurement?.work;
			const exponent =
				previous === undefined
					? "-"
					: (Math.log(timed.measurement.ms / previous.ms) / Math.log(matches / previous.matches)).toFixed(2);
			rows.push([
				shape,
				count(matches),
				count(timed.measurement.inputChars),
				timed.measurement.ms.toLocaleString("en-US"),
				exponent,
				count(work?.sliceCalls),
				count(work?.sliceChars),
				count(work?.indexOfCalls),
				count(work?.indexOfChars),
				counted.measurement === undefined
					? `work not counted: ${counted.status}`
					: `placeholders ${timed.measurement.placeholders.toLocaleString("en-US")}`,
			]);
			previous = { matches, ms: timed.measurement.ms };
		}
	}

	console.log(
		formatTable(
			[
				"shape",
				"matches",
				"input chars",
				"time ms",
				"exponent",
				"slice calls",
				"slice chars",
				"indexOf calls",
				"indexOf chars",
				"note",
			],
			rows,
		),
	);
}

await main();
