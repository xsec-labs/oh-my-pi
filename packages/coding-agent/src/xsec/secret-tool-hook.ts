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
 *   it. The wrapper reaches the session's obfuscator through its runner (`bindHookSecrets`, `hookSecretsOf`).
 *
 * Block reasons and extra context are not rewritten: they reach the model through the masked provider request,
 * as tool output does.
 *
 * Without an obfuscator, or with one that holds no secrets, every function returns its input unchanged.
 */
import type { ExtensionRunner } from "../extensibility/extensions/runner";
import { deobfuscateToolArguments, obfuscateToolArguments } from "../secrets/message-transform";
import type { SecretObfuscator } from "../secrets/obfuscator";

/** Reads the owning session's obfuscator at each call, so a live `secrets.enabled` switch applies to the next call. */
export type HookSecretsSource = () => SecretObfuscator | undefined;

const secretsByRunner = new WeakMap<ExtensionRunner, HookSecretsSource>();

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

/** A revised input the loop will persist and send: real values the hook wrote go back to placeholders. */
export function protectHookRevision(
	obfuscator: SecretObfuscator | undefined,
	input: Record<string, unknown>,
): Record<string, unknown> {
	if (!obfuscator?.hasSecrets()) return input;
	return obfuscateToolArguments(obfuscator, input);
}
