/**
 * Finds the occurrences of one `search` in one `text` from left to right (package 14b). `emitChunk` asks for the next
 * occurrence after each chunk, and an `indexOf` per chunk scanned the text once per chunk.
 *
 * A search that starts at `from` and finds `index` shows that nothing matches in `[from, index)`, so a later query
 * from anywhere in `[from, index]` also gets `index`. A search that finds nothing answers every query from `from` on.
 * Any other query searches again, so every answer equals a fresh `indexOf` at that query, whatever order the queries
 * come in.
 */
export interface OccurrenceCursor {
	/** The index of the first occurrence at or after `from`, or -1 when there is none. */
	next(from: number): number;
}

export function createOccurrenceCursor(text: string, search: string): OccurrenceCursor {
	// An empty search matches at every position, which the answer reuse below does not model.
	if (search.length === 0) throw new RangeError("occurrence cursor: the search must not be empty");
	let searched = false;
	let searchedFrom = 0;
	let index = -1;
	return {
		next(from: number): number {
			if (!searched || from < searchedFrom || (index >= 0 && index < from)) {
				searched = true;
				searchedFrom = from;
				index = text.indexOf(search, from);
			}
			return index;
		},
	};
}
