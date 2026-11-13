/**
 * Settings the fork declares. `config/all-settings.ts` imports this module, so these settings exist
 * wherever the registry does, including `--config` overlays. They have no settings-panel entry:
 * Desktop sets them through the `--config` file it passes to OMP.
 */
import { effect, register } from "../config/registry";
import { MCP_TOOL_NAME_COLLISION_MODES, setMCPToolNameCollisionMode } from "./mcp-tool-collision";

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
