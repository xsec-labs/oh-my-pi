import { describe, expect, it } from "bun:test";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { McpConnectionStatusEvent } from "@oh-my-pi/pi-coding-agent/mcp/startup-events";
import { type LateMcpManager, LateMcpReporter } from "@oh-my-pi/pi-coding-agent/xsec/mcp-late-status";
import type { MCPToolNameCollisionObservation } from "@oh-my-pi/pi-coding-agent/xsec/mcp-tool-collision";
import type { SessionUpdate } from "@oh-my-pi/pi-utils/acp";

type ConnectionState = "connected" | "connecting" | "disconnected";

/** A manager stand-in: `states` answers `getConnectionStatus`, and `emit` delivers an event to every listener. */
function fakeManager(states: Record<string, ConnectionState>) {
	const listeners = new Set<(event: McpConnectionStatusEvent) => void>();
	const manager: LateMcpManager = {
		getConnectionStatus: name => states[name] ?? "disconnected",
		addConnectionStatusListener: listener => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
	return {
		manager,
		emit: (event: McpConnectionStatusEvent) => {
			for (const listener of listeners) listener(event);
		},
		listenerCount: () => listeners.size,
	};
}

/**
 * Records what the reporter sends. `done` settles once `expected` updates have arrived, so a test waits on the
 * updates it expects and never on a delay.
 */
function recordingSink(expected: number) {
	const sent: SessionUpdate[] = [];
	const { promise, resolve } = Promise.withResolvers<void>();
	return {
		sink: async (update: SessionUpdate) => {
			sent.push(update);
			if (sent.length === expected) resolve();
		},
		done: promise,
		texts: () =>
			sent.flatMap(update =>
				update.sessionUpdate === "agent_message_chunk" && update.content.type === "text"
					? [update.content.text]
					: [],
			),
	};
}

function stdio(command: string): MCPServerConfig {
	return { type: "stdio", command, args: [], env: {} };
}

function http(url: string): MCPServerConfig {
	return { type: "http", url };
}

function collision(enforced: boolean): MCPToolNameCollisionObservation {
	return {
		enforced,
		collision: {
			name: "mcp__foo_bar_echo",
			winner: { mcpServerName: "foo.bar", mcpToolName: "echo" },
			loser: { mcpServerName: "foo_bar", mcpToolName: "echo" },
		},
	};
}

describe("LateMcpReporter", () => {
	it("notes a server still connecting, then reports only that server's connect", async () => {
		const { manager, emit } = fakeManager({ slow: "connecting", fast: "connected" });
		const { sink, done, texts } = recordingSink(2);
		const reporter = new LateMcpReporter(sink);
		reporter.follow(manager, { slow: stdio("slow"), fast: stdio("fast") });
		reporter.open();

		emit({ type: "connected", serverName: "fast" });
		emit({ type: "connected", serverName: "slow" });
		await done;

		expect(texts()).toEqual([
			'MCP server "slow" is still connecting. Its tools will be added when it connects.',
			'MCP server "slow" connected.',
		]);
	});

	it("reports a late failure with the recovery that fits the server's transport", async () => {
		const { manager, emit } = fakeManager({ remote: "connecting", local: "connecting" });
		const { sink, done, texts } = recordingSink(4);
		const reporter = new LateMcpReporter(sink);
		reporter.follow(manager, { remote: http("https://example.test/mcp"), local: stdio("local") });
		reporter.open();

		emit({ type: "failed", serverName: "remote", error: "401\nUnauthorized" });
		emit({ type: "failed", serverName: "local", error: "spawn ENOENT" });
		await done;

		expect(texts().slice(2)).toEqual([
			'MCP server "remote" failed to connect: 401 Unauthorized. Its tools are unavailable until it is reauthorized (/mcp reauth remote) or the client restarts the session.',
			'MCP server "local" failed to connect: spawn ENOENT. Its tools are unavailable until the client restarts the session.',
		]);
	});

	it("reports a collision once while armed, with the outcome the policy enforces", async () => {
		const { manager } = fakeManager({});
		const { sink, done, texts } = recordingSink(2);
		const reporter = new LateMcpReporter(sink);
		reporter.follow(manager, {});
		reporter.open();

		// Before arm, the initial tool list is being built, so its collisions are not late.
		reporter.onCollision(collision(false));
		reporter.arm();
		reporter.onCollision(collision(false));
		reporter.onCollision(collision(false));
		reporter.onCollision(collision(true));
		await done;

		expect(texts()).toEqual([
			'MCP tool name collision on "mcp__foo_bar_echo": foo.bar:echo is kept and foo_bar:echo is not added.',
			'MCP tool name collision on "mcp__foo_bar_echo": foo.bar:echo and foo_bar:echo both provide it, so the tool list was not updated.',
		]);
	});

	it("stop lets go of the manager and forgets its pending servers", async () => {
		const first = fakeManager({ old: "connecting" });
		const second = fakeManager({ next: "connecting" });
		const { sink, done, texts } = recordingSink(2);
		const reporter = new LateMcpReporter(sink);
		reporter.follow(first.manager, { old: stdio("old") });
		reporter.open();
		reporter.stop();
		expect(first.listenerCount()).toBe(0);

		// After stop, the old manager's failure is dropped, so the second note sent is the new server's note.
		first.emit({ type: "failed", serverName: "old", error: "gone" });
		reporter.follow(second.manager, { next: stdio("next") });
		await done;

		expect(texts()).toEqual([
			'MCP server "old" is still connecting. Its tools will be added when it connects.',
			'MCP server "next" is still connecting. Its tools will be added when it connects.',
		]);
	});
});
