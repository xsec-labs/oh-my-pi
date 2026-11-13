/**
 * Fork policy for MCP tool name collisions, chosen by `mcp.toolNameCollision` (declared in
 * `./settings.ts`). Upstream keeps the stable winner and warns. The `error` mode fails tool loading
 * instead, naming the tool and both origins, so Desktop never runs a tool it did not expect.
 *
 * The policy is process-wide: `deduplicateMCPToolsByName` runs without a settings scope, so the
 * setting reaches it through `effect` (the same way `mcp.renderMarkdownResults` reaches its module).
 */

/** Values of `mcp.toolNameCollision`. */
export const MCP_TOOL_NAME_COLLISION_MODES = ["keep-first", "error"] as const;
export type MCPToolNameCollisionMode = (typeof MCP_TOOL_NAME_COLLISION_MODES)[number];

let mode: MCPToolNameCollisionMode = "keep-first";

/** Applies the setting. Called by the `effect` that `./settings.ts` declares. */
export function setMCPToolNameCollisionMode(next: MCPToolNameCollisionMode): void {
	mode = next;
}

/** The origin of an MCP tool: the server it came from and the name that server gave it. */
export interface MCPToolCollisionOrigin {
	readonly mcpServerName?: unknown;
	readonly mcpToolName?: unknown;
}

/** Two distinct MCP origins that minted the same tool name. `winner` is the one upstream keeps. */
export interface MCPToolNameCollision {
	readonly name: string;
	readonly winner: MCPToolCollisionOrigin;
	readonly loser: MCPToolCollisionOrigin;
}

function describeOrigin(origin: MCPToolCollisionOrigin): string {
	return `${String(origin.mcpServerName)}:${String(origin.mcpToolName)}`;
}

/**
 * Runs just before the caller warns about a collision. In `error` mode it throws, so the tool list
 * build or refresh fails with the tool name and both origins. In `keep-first` mode it returns and the
 * caller keeps the stable winner, as upstream does.
 */
export function enforceMCPToolNameCollisionPolicy(collision: MCPToolNameCollision): void {
	if (mode !== "error") return;
	const { name, winner, loser } = collision;
	throw new Error(`OMP MCP Tool name collision: ${name} (${describeOrigin(winner)}, ${describeOrigin(loser)})`);
}
