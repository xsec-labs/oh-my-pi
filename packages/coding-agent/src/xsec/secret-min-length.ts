/**
 * Fork policy for `secrets.minObfuscateLength` (declared in `./settings.ts`): the shortest plain or regex match,
 * in UTF-16 units, that the obfuscator masks. Upstream fixes it at 8, and shorter matches stay as written.
 *
 * The value is process-wide, like `secrets.disabledBuiltinPatterns`: `buildSecretObfuscator` takes no settings
 * handle, so the effect in `./settings.ts` reaches this module.
 */

/** Upstream's threshold, and the default of `secrets.minObfuscateLength`. */
export const DEFAULT_MIN_OBFUSCATE_LENGTH = 8;

let minObfuscateLength = DEFAULT_MIN_OBFUSCATE_LENGTH;

/** Applies `secrets.minObfuscateLength`. Called by the `effect` that `./settings.ts` declares. */
export function setMinObfuscateLength(length: number): void {
	minObfuscateLength = length;
}

/**
 * The shortest match the obfuscator masks. Throws, naming the value, unless it is an integer of 1 or more. The
 * obfuscator calls it when it is built, so the session does not start with a value it cannot apply.
 */
export function obfuscateMinLength(): number {
	if (!Number.isInteger(minObfuscateLength) || minObfuscateLength < 1) {
		throw new Error(`secrets.minObfuscateLength must be an integer of 1 or more, got ${minObfuscateLength}`);
	}
	return minObfuscateLength;
}
