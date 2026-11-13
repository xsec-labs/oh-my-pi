/**
 * MCP state that changes after `session/new` has returned, reported to the ACP client as session updates:
 * a server still connecting when the startup window closed, its later connect or failure, and a tool name
 * collision that a refresh finds once the session is running. Each one reaches the client as an
 * `agent_message_chunk`, the channel that already carries startup failures. Each note also carries a
 * machine-readable marker at `content._meta.xsec.mcpNotice`, so a client can tell it from model text.
 *
 * The reporter changes what the client can see, never when or whether a session starts. Desktop #868
 * (xSecDesktop a1a5e5ec, on main) sets `OMP_MCP_STARTUP_TIMEOUT_MS=0` when it starts omp. That makes a session
 * wait for every server, so it has no late connects to report. The variable takes effect only from OMP 18.20
 * on: Desktop's current 18.0.9 pin ignores it, so until Desktop pins a fork OMP its sessions keep the 250 ms
 * window and do see late state.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { SessionUpdate } from "@oh-my-pi/pi-utils/acp";
import type { MCPManager } from "../mcp/manager";
import type { McpConnectionStatusEvent } from "../mcp/startup-events";
import type { MCPServerConfig } from "../mcp/types";
import {
	describeMCPToolOrigin,
	type MCPToolNameCollisionObservation,
	observeMCPToolNameCollisions,
} from "./mcp-tool-collision";

/** The part of the MCP manager that the reporter follows. */
export type LateMcpManager = Pick<MCPManager, "getConnectionStatus" | "addConnectionStatusListener">;

/** Sends one session update to the client. */
export type LateMcpUpdateSink = (update: SessionUpdate) => Promise<unknown>;

/**
 * The marker on each note, at `content._meta.xsec.mcpNotice`. The three server kinds set `server`. A
 * `tool_collision` sets `tool` (the name the client sees), `winner` and `loser` (`server:tool` origins),
 * and `enforced` (true when the policy fails the tool list instead of keeping the winner).
 */
export type LateMcpNotice =
	| { kind: "server_connecting"; server: string }
	| { kind: "server_connected"; server: string }
	| { kind: "server_failed"; server: string }
	| { kind: "tool_collision"; tool: string; winner: string; loser: string; enforced: boolean };

type ServerConfigs = Readonly<Record<string, MCPServerConfig | undefined>>;

/** Collapses an error message onto one line, so a multi-line error reads as one notice. */
function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

/**
 * Reports one session's late MCP state. A session has one reporter, bound to each MCP manager the session
 * configures: `follow` binds it, `arm` marks the initial tool list as in, `open` marks the client as knowing
 * the session id, and `stop` lets go of a manager that is being replaced. Updates made before `open` wait for it.
 */
export class LateMcpReporter {
	readonly #sink: LateMcpUpdateSink;
	readonly #pending = new Set<string>();
	readonly #reported = new Set<string>();
	#queued: SessionUpdate[] = [];
	#detach: (() => void) | undefined;
	#configs: ServerConfigs = {};
	#opened = false;
	#armed = false;
	#delivery: Promise<void> = Promise.resolve();

	constructor(sink: LateMcpUpdateSink) {
		this.#sink = sink;
	}

	/**
	 * Starts reporting for `manager` and stops reporting for the manager followed before. A server still
	 * connecting when this runs is noted now, and reported when it connects or fails.
	 */
	follow(manager: LateMcpManager, configs: ServerConfigs): void {
		this.stop();
		this.#configs = configs;
		for (const name of Object.keys(configs)) {
			if (manager.getConnectionStatus(name) !== "connecting") continue;
			this.#pending.add(name);
			this.#say(`MCP server "${name}" is still connecting. Its tools will be added when it connects.`, {
				kind: "server_connecting",
				server: name,
			});
		}
		this.#detach = manager.addConnectionStatusListener(event => this.onStatus(event));
	}

	/** Stops following the current manager. Pending servers and updates still waiting for `open` are dropped. */
	stop(): void {
		this.#detach?.();
		this.#detach = undefined;
		this.#pending.clear();
		this.#reported.clear();
		this.#queued = [];
		this.#armed = false;
	}

	/** Marks the initial tool list as in. Collisions seen from now on come from a refresh after the session started. */
	arm(): void {
		this.#armed = true;
	}

	/** Marks the client as knowing the session id. Updates queued until now go out in order, and later ones go out at once. */
	open(): void {
		if (this.#opened) return;
		this.#opened = true;
		for (const update of this.#queued.splice(0)) this.#deliver(update);
	}

	/** Reports a connect or a failure of a server that was still connecting when it was followed. */
	onStatus(event: McpConnectionStatusEvent): void {
		if (event.type === "connected") {
			if (this.#pending.delete(event.serverName)) {
				this.#say(`MCP server "${event.serverName}" connected.`, {
					kind: "server_connected",
					server: event.serverName,
				});
			}
		} else if (event.type === "failed") {
			if (this.#pending.delete(event.serverName)) {
				const reason = oneLine(event.error);
				this.#say(
					`MCP server "${event.serverName}" failed to connect: ${reason}. ${this.#recovery(event.serverName)}`,
					{
						kind: "server_failed",
						server: event.serverName,
					},
				);
			}
		}
	}

	/** Reports a collision that a refresh found once the session was running. Each collision is reported once. */
	onCollision({ collision, enforced }: MCPToolNameCollisionObservation): void {
		if (!this.#armed) return;
		const winner = describeMCPToolOrigin(collision.winner);
		const loser = describeMCPToolOrigin(collision.loser);
		const key = [collision.name, winner, loser, enforced].join("\u0000");
		if (this.#reported.has(key)) return;
		this.#reported.add(key);
		const outcome = enforced
			? `${winner} and ${loser} both provide it, so the tool list was not updated.`
			: `${winner} is kept and ${loser} is not added.`;
		this.#say(`MCP tool name collision on "${collision.name}": ${outcome}`, {
			kind: "tool_collision",
			tool: collision.name,
			winner,
			loser,
			enforced,
		});
	}

	/** Runs `fn`, and reports each collision that `fn` finds, including collisions in the work it starts. */
	observe<T>(fn: () => T): T {
		return observeMCPToolNameCollisions(observation => this.onCollision(observation), fn);
	}

	#recovery(name: string): string {
		const type = this.#configs[name]?.type;
		return type === "http" || type === "sse"
			? `Its tools are unavailable until it is reauthorized (/mcp reauth ${name}) or the client restarts the session.`
			: "Its tools are unavailable until the client restarts the session.";
	}

	/** Queues or sends one note: the text is for people, and the marker is for clients that act on it. */
	#say(text: string, notice: LateMcpNotice): void {
		this.#emit({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text, _meta: { xsec: { mcpNotice: notice } } },
		});
	}

	#emit(update: SessionUpdate): void {
		if (this.#opened) this.#deliver(update);
		else this.#queued.push(update);
	}

	/** Sends updates one after another, so the client receives them in the order they were made. */
	#deliver(update: SessionUpdate): void {
		const sent = this.#delivery.then(() => this.#sink(update));
		this.#delivery = sent.then(
			() => {},
			error => {
				logger.warn("MCP late state update was not delivered", {
					error: error instanceof Error ? error.message : String(error),
				});
			},
		);
	}
}
