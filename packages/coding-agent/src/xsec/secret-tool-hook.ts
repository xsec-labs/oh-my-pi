/**
 * Secrets at the extension `tool_call` hook. With `secrets.enabled` the model writes placeholders
 * (`$$NAME_HASH$$`), and a tool runs with the real values because the loop restores them after the hook.
 * Upstream emitted the hook before that restore, so Desktop's approval gate, policy rules and approval card
 * judged placeholders. This module moves that boundary; upstream files only call into it:
 *
 * - the hook sees the real values (`restoreHookArgs`);
 * - a revised input goes back to the loop in placeholder form, because the loop writes it into the assistant
 *   message that is persisted and sent upstream (`protectHookRevision`);
 * - a call the loop did not dispatch (the wrapper's own emit, used by Cursor exec and nested tool calls) arrives
 *   with whatever placeholders its caller left in it, so the wrapper restores it before the gate and the hook see
 *   it (`restoreCallArgs`). The wrapper reaches the session's obfuscator through its runner (`bindHookSecrets`).
 *   A runner no session bound has no secrets to restore from, so a call that still holds a placeholder is refused;
 * - the bridged-call preflight (TTSR rules, whose match excerpts can reach the model) judges the placeholder form,
 *   as the loop's check does (`protectHookRevision`).
 *
 * Block reasons and extra context are not rewritten: they reach the model through the masked provider request,
 * as tool output does.
 *
 * Without an obfuscator, or with one that holds no secrets, the functions return their input unchanged. The one
 * exception is `restoreCallArgs` on a runner no session bound, which refuses a placeholder.
 */
import type { ExtensionRunner } from "../extensibility/extensions/runner";
import { deobfuscateToolArguments, obfuscateToolArguments } from "../secrets/message-transform";
import type { SecretObfuscator } from "../secrets/obfuscator";
import { PLACEHOLDER_RE } from "../secrets/placeholder";

/** Reads the owning session's obfuscator at each call, so a live `secrets.enabled` switch applies to the next call. */
export type HookSecretsSource = () => SecretObfuscator | undefined;

const secretsByRunner = new WeakMap<ExtensionRunner, HookSecretsSource>();

/** A placeholder anywhere in a string. Not global, so `test` keeps no position between calls. */
const PLACEHOLDER_TEXT = new RegExp(PLACEHOLDER_RE.source);

/**
 * Binds the obfuscator of the session that owns `runner`. The first bind wins: a session that shares the runner
 * (an advisor, for example) must not replace the source of the session that created it.
 */
export function bindHookSecrets(runner: ExtensionRunner | undefined, source: HookSecretsSource): void {
	if (runner !== undefined && !secretsByRunner.has(runner)) secretsByRunner.set(runner, source);
}

/** The obfuscator bound to `runner`, or undefined when no session bound one. */
export function hookSecretsOf(runner: ExtensionRunner): SecretObfuscator | undefined {
	return secretsByRunner.get(runner)?.();
}

/** The arguments a hook sees: placeholders restored to the real values. `args` itself when there is nothing to restore. */
export function restoreHookArgs<T>(obfuscator: SecretObfuscator | undefined, args: T): T {
	if (!obfuscator?.hasSecrets()) return args;
	return deobfuscateToolArguments(obfuscator, args as Record<string, unknown>) as T;
}

/**
 * The arguments a call the loop did not dispatch runs with. Placeholders are restored from the session that owns the
 * runner. A runner no session bound has no secrets to restore from, so a call that still holds a placeholder is
 * refused rather than run with it, and a call without one runs unchanged.
 */
export function restoreCallArgs<T>(runner: ExtensionRunner, args: T): T {
	const source = secretsByRunner.get(runner);
	if (source !== undefined) return restoreHookArgs(source(), args);
	if (PLACEHOLDER_TEXT.test(JSON.stringify(args) ?? "")) {
		throw new Error("Tool call refused: its arguments hold a secret placeholder, and no session owns that secret.");
	}
	return args;
}

/**
 * The placeholder form of arguments the loop will persist, send or judge: a real value goes back to its placeholder.
 * `input` itself when there is nothing to protect.
 */
export function protectHookRevision<T>(obfuscator: SecretObfuscator | undefined, input: T): T {
	if (!obfuscator?.hasSecrets()) return input;
	return obfuscateToolArguments(obfuscator, input as Record<string, unknown>) as T;
}
