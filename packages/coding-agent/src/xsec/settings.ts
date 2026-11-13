/**
 * Settings the fork declares. `config/all-settings.ts` imports this module, so these settings exist
 * wherever the registry does, including `--config` overlays. They have no settings-panel entry:
 * Desktop sets them through the `--config` file it passes to OMP.
 */
import { effect, register } from "../config/registry";
import { MCP_TOOL_NAME_COLLISION_MODES, setMCPToolNameCollisionMode } from "./mcp-tool-collision";
import { setDisabledBuiltinSecretPatterns } from "./secret-builtin-patterns";
import { DEFAULT_MIN_OBFUSCATE_LENGTH, setMinObfuscateLength } from "./secret-min-length";

/**
 * `keep-first` (default): warn and keep the stable winner, as upstream does. `error`: fail tool loading.
 * An unknown value in a config file follows upstream's rule for every enum setting: a warning, and the
 * default applies. The fork adds no validation of its own.
 */
export const cfgMcpToolNameCollision = register({
	id: "mcp.toolNameCollision",
	type: "enum",
	values: MCP_TOOL_NAME_COLLISION_MODES,
	default: "keep-first",
});
effect(cfgMcpToolNameCollision, setMCPToolNameCollisionMode);

/**
 * `all` (default): upstream's discovery, which also probes built-in and local providers and the
 * models.dev catalog. `configured`: discovery contacts only the providers listed in models.yml.
 * The behaviour lives in `./model-discovery.ts`.
 */
export const cfgModelsDiscovery = register({
	id: "models.discovery",
	type: "enum",
	values: ["all", "configured"] as const,
	default: "all",
});

const NO_BUILTIN_PATTERNS: readonly string[] = [];

/**
 * Built-in secret patterns (`secrets/patterns.ts`, by `name`) that the obfuscator leaves out. Default: none.
 * A name that is not a built-in pattern makes building the obfuscator throw, so the session does not start.
 * `Credential` also turns off pi-ai's credential rewrite for the same shapes. The behaviour lives in
 * `./secret-builtin-patterns.ts`.
 */
export const cfgSecretsDisabledBuiltinPatterns = register({
	id: "secrets.disabledBuiltinPatterns",
	type: "array",
	default: NO_BUILTIN_PATTERNS,
});
effect(cfgSecretsDisabledBuiltinPatterns, setDisabledBuiltinSecretPatterns);

/**
 * The shortest plain or regex match, in UTF-16 units, the obfuscator masks. Default 8, upstream's value. Any value
 * that is not an integer of 1 or more makes building the obfuscator throw, so the session does not start. The
 * behaviour lives in `./secret-min-length.ts`.
 */
export const cfgSecretsMinObfuscateLength = register({
	id: "secrets.minObfuscateLength",
	type: "number",
	default: DEFAULT_MIN_OBFUSCATE_LENGTH,
});
effect(cfgSecretsMinObfuscateLength, setMinObfuscateLength);
