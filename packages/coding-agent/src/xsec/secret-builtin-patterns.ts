/**
 * Fork policy for `secrets.disabledBuiltinPatterns` (declared in `./settings.ts`). A built-in pattern
 * named there is left out of the obfuscator. The `Credential` shapes are also left out of pi-ai's
 * provider-boundary credential rewrite: it matches the same tokens (`SENSITIVE_TOKEN_RE`) and rewrites
 * them irreversibly to `[*_token_redacted]`, so a disabled `Credential` pattern would still lose them.
 *
 * The policy is process-wide, like `mcp.toolNameCollision`: `buildSecretObfuscator` takes no settings
 * handle, so the effects in `./settings.ts` and `secrets/settings.ts` reach this module.
 */
import { configureCredentialRedaction } from "@oh-my-pi/pi-ai/providers/transform-messages";

/** The built-in pattern whose shapes pi-ai's provider-boundary rewrite also matches (`SENSITIVE_TOKEN_RE`). */
const CREDENTIAL_PATTERN_NAME = "Credential";

let disabledPatterns: ReadonlySet<string> = new Set();
let secretsEnabled = false;

/** Applies `secrets.disabledBuiltinPatterns`. Called by the `effect` that `./settings.ts` declares. */
export function setDisabledBuiltinSecretPatterns(names: readonly string[]): void {
	disabledPatterns = new Set(names);
	applyCredentialRedaction();
}

/** Applies `secrets.enabled` to pi-ai's process-wide switch. Called by the `effect` in `secrets/settings.ts`. */
export function setSecretsEnabledForRedaction(enabled: boolean): void {
	secretsEnabled = enabled;
	applyCredentialRedaction();
}

/**
 * Whether pi-ai's credential rewrite runs for a request whose session has `secrets.enabled` as given.
 * Sessions pass the result to `withCredentialRedaction`, and the process-wide switch uses it too.
 */
export function credentialShapeRedaction(sessionSecretsEnabled: boolean): boolean {
	return sessionSecretsEnabled && !disabledPatterns.has(CREDENTIAL_PATTERN_NAME);
}

function applyCredentialRedaction(): void {
	configureCredentialRedaction(credentialShapeRedaction(secretsEnabled));
}

/**
 * The built-in entries the obfuscator keeps, given all of them (each entry's `friendlyName` is its
 * pattern's name). Throws, naming the value, when a configured name is not one of them: building the
 * obfuscator then fails, so the session does not start with a pattern switched on or off by mistake.
 */
export function enabledBuiltinSecretEntries<T extends { readonly friendlyName?: string }>(builtins: readonly T[]): T[] {
	const known = new Set(builtins.map(entry => entry.friendlyName));
	for (const name of disabledPatterns) {
		if (!known.has(name)) {
			throw new Error(`secrets.disabledBuiltinPatterns names an unknown built-in secret pattern: ${name}`);
		}
	}
	return builtins.filter(entry => !disabledPatterns.has(entry.friendlyName ?? ""));
}
