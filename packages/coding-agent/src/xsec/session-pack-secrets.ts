/**
 * The obfuscator `omp session pack --restore-secrets` restores placeholders with: the one a session of this
 * profile would have been started with (secrets.yml of the profile and of the session's project, the environment,
 * the built-in rules, and the profile's placeholder key).
 */
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import { buildSecretObfuscator, type SecretObfuscator } from "../secrets";
import { loadEntriesFromFile } from "../session/session-loader";

/**
 * Builds the obfuscator for `sessionFile`. `configFiles` are the `--config` overlays the session was started
 * with: they carry the policies (`secrets.disabledBuiltinPatterns`, `secrets.minObfuscateLength`) that decide
 * which values were turned into placeholders. `secrets.enabled` is not consulted: a session that had it on
 * keeps its placeholders after it is turned off, and they must still be restored.
 */
export async function buildPackObfuscator(
	sessionFile: string,
	configFiles: string[] | undefined,
): Promise<SecretObfuscator | undefined> {
	const header = (await loadEntriesFromFile(sessionFile))[0];
	if (header?.type !== "session") return undefined;
	await Settings.loadReadOnly({ cwd: header.cwd, configFiles });
	return buildSecretObfuscator(header.cwd, getAgentDir());
}
