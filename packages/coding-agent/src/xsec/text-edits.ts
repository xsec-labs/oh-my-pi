/**
 * Batched replacements for the masking obfuscator (package 14b). `replaceRange` copies the whole string on every
 * call, so one call per regex match made the regex phase quadratic in the number of matches. These helpers apply
 * a whole batch of replacements to a text and its parallel origin tags in one pass, with the same result.
 */
import { replaceRange } from "../secrets/placeholder-scan";

/** Replaces `text[start, end)` with `text`, and the origin tags over the same range with `origin`. */
export interface TextEdit {
	start: number;
	end: number;
	text: string;
	origin: string;
}

/**
 * Whether every range starts no later than it ends, and each one ends at or before the start of the range before it.
 * Such a list can be applied in one pass, and every span of it can be read from the text as it was before any edit.
 */
export function isDescendingDisjoint(ranges: readonly { start: number; end: number }[]): boolean {
	for (let i = 0; i < ranges.length; i++) {
		const range = ranges[i]!;
		if (range.start > range.end) return false;
		if (i > 0 && range.end > ranges[i - 1]!.start) return false;
	}
	return true;
}

/**
 * Applies `edits` in the order given, with the same result as one `replaceRange` call per edit on `text` and on
 * `origin`. A descending, disjoint list is applied in one pass; any other list is applied edit by edit, so the result
 * is the same for every input.
 */
export function applyTextEdits(
	text: string,
	origin: string,
	edits: readonly TextEdit[],
): { text: string; origin: string } {
	if (edits.length === 0) return { text, origin };
	if (!isDescendingDisjoint(edits)) {
		let result = text;
		let tags = origin;
		for (const edit of edits) {
			result = replaceRange(result, edit.start, edit.end, edit.text);
			tags = replaceRange(tags, edit.start, edit.end, edit.origin);
		}
		return { text: result, origin: tags };
	}
	let outText = "";
	let outOrigin = "";
	let cursor = 0;
	// The list is descending, so walking it backwards visits the spans left to right.
	for (let i = edits.length - 1; i >= 0; i--) {
		const edit = edits[i]!;
		outText += text.slice(cursor, edit.start) + edit.text;
		outOrigin += origin.slice(cursor, edit.start) + edit.origin;
		cursor = edit.end;
	}
	return { text: outText + text.slice(cursor), origin: outOrigin + origin.slice(cursor) };
}
