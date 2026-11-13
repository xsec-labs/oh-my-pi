/**
 * Fork policy for MCP tool name collisions, chosen by `mcp.toolNameCollision` (declared in
 * `./settings.ts`). Upstream keeps the stable winner and warns. The `error` mode fails tool loading
 * instead, naming the tool and both origins, so Desktop never runs a tool it did not expect.
 *
 * The policy is process-wide: `deduplicateMCPToolsByName` runs without a settings scope, so the
 * setting reaches it through `effect` (the same way `mcp.renderMarkdownResults` reaches its module).
 */
import { AsyncLocalStorage } from "node:async_hooks";

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

/** A collision as an observer sees it. `enforced` is true when the policy fails the tool list build or refresh. */
export interface MCPToolNameCollisionObservation {
	readonly collision: MCPToolNameCollision;
	readonly enforced: boolean;
}

const collisionObservers = new AsyncLocalStorage<(observation: MCPToolNameCollisionObservation) => void>();

/**
 * Runs `fn` with `observer` attached. Every collision the policy sees while `fn` runs, including the
 * work `fn` starts and awaits, also reaches `observer`. Code outside the scope is not observed.
 */
export function observeMCPToolNameCollisions<T>(
	observer: (observation: MCPToolNameCollisionObservation) => void,
	fn: () => T,
): T {
	return collisionObservers.run(observer, fn);
}

/** `<server>:<tool>` for an origin, as the policy's error names it. */
export function describeMCPToolOrigin(origin: MCPToolCollisionOrigin): string {
	return `${String(origin.mcpServerName)}:${String(origin.mcpToolName)}`;
}

/**
 * Runs just before the caller warns about a collision. In `error` mode it throws, so the tool list
 * build or refresh fails with the tool name and both origins. In `keep-first` mode it returns and the
 * caller keeps the stable winner, as upstream does. An observer in scope hears about the collision first.
 */
export function enforceMCPToolNameCollisionPolicy(collision: MCPToolNameCollision): void {
	const enforced = mode === "error";
	collisionObservers.getStore()?.({ collision, enforced });
	if (!enforced) return;
	const { name, winner, loser } = collision;
	throw new Error(
		`OMP MCP Tool name collision: ${name} (${describeMCPToolOrigin(winner)}, ${describeMCPToolOrigin(loser)})`,
	);
}
