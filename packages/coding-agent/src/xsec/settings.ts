/**
 * Settings the fork declares. `config/all-settings.ts` imports this module, so these settings exist
 * wherever the registry does, including `--config` overlays. They have no settings-panel entry:
 * Desktop sets them through the `--config` file it passes to OMP.
 */
import { effect, register } from "../config/registry";
import { MCP_TOOL_NAME_COLLISION_MODES, setMCPToolNameCollisionMode } from "./mcp-tool-collision";

/**
 * Rejects an unknown mode when it is configured. Without this, a typo would read as the default
 * (`keep-first`) and silently drop the protection Desktop asked for.
 */
function validateMCPToolNameCollision(raw: unknown): void {
	if (raw === undefined || raw === null) return;
	if (!MCP_TOOL_NAME_COLLISION_MODES.some(mode => mode === raw)) {
		throw new Error(
			`Invalid value for mcp.toolNameCollision: ${Bun.inspect(raw)} (expected one of ${MCP_TOOL_NAME_COLLISION_MODES.join(", ")})`,
		);
	}
}

/** `keep-first` (default): warn and keep the stable winner, as upstream does. `error`: fail tool loading. */
export const cfgMcpToolNameCollision = register({
	id: "mcp.toolNameCollision",
	type: "enum",
	values: MCP_TOOL_NAME_COLLISION_MODES,
	default: "keep-first",
	validate: validateMCPToolNameCollision,
});
effect(cfgMcpToolNameCollision, setMCPToolNameCollisionMode);
