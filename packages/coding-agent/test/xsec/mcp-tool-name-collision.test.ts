import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import { type } from "@oh-my-pi/omptype";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { bindEffects } from "@oh-my-pi/pi-coding-agent/config/registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { deduplicateMCPToolsByName } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import { type CustomTool, createAgentSession, discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { logger, TempDir } from "@oh-my-pi/pi-utils";

/** Both origins mint this name: the server names differ only in `.` versus `_`. */
const COLLIDING_NAME = "mcp__foo_bar_lookup";
const dotted = { name: COLLIDING_NAME, mcpServerName: "foo.bar", mcpToolName: "lookup" };
const underscored = { name: COLLIDING_NAME, mcpServerName: "foo_bar", mcpToolName: "lookup" };

/** Message of the error a synchronous call throws; fails the test if the call returns. */
function thrownMessage(run: () => unknown): string {
	try {
		run();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("expected the call to throw");
}

/** Message of the error a promise rejects with; fails the test if it resolves. */
async function rejectionMessage(run: () => Promise<unknown>): Promise<string> {
	try {
		await run();
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("expected the call to reject");
}

function mcpTool(serverName: string): CustomTool {
	return {
		name: COLLIDING_NAME,
		label: `${serverName}/lookup`,
		description: `Lookup served by ${serverName}`,
		parameters: type({}),
		mcpServerName: serverName,
		mcpToolName: "lookup",
		async execute() {
			return { content: [{ type: "text", text: serverName }] };
		},
	};
}

/** Loads `yaml` as a `--config` overlay, through the same loader the flag uses. */
async function loadOverlay(tempDir: TempDir, yaml: string): Promise<Settings> {
	const overlay = tempDir.join("overlay.yml");
	await Bun.write(overlay, yaml);
	return Settings.loadIsolated({
		inMemory: true,
		agentDir: tempDir.join("agent"),
		cwd: tempDir.path(),
		configFiles: [overlay],
	});
}

afterEach(() => {
	// Process-wide effects keep their last applied value after a release; reset them to the defaults.
	resetSettingsForTest();
	vi.restoreAllMocks();
});

describe("deduplicateMCPToolsByName under mcp.toolNameCollision", () => {
	it("keeps the stable winner and warns by default", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

		expect(deduplicateMCPToolsByName([underscored, dotted])).toEqual([dotted]);
		expect(warn).toHaveBeenCalledWith(
			"MCP tool name collision; keeping stable winner",
			expect.objectContaining({ name: COLLIDING_NAME, keptServer: "foo.bar", ignoredServer: "foo_bar" }),
		);
	});

	it("fails naming the tool and both origins in error mode, and does not warn", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const release = bindEffects(Settings.isolated({ "mcp.toolNameCollision": "error" }));
		try {
			const message = thrownMessage(() => deduplicateMCPToolsByName([underscored, dotted]));

			expect(message).toContain(COLLIDING_NAME);
			expect(message).toContain("foo.bar:lookup");
			expect(message).toContain("foo_bar:lookup");
			expect(warn).not.toHaveBeenCalled();
		} finally {
			release();
		}
	});

	it("lets a re-reported origin and distinct tool names through in error mode", () => {
		const release = bindEffects(Settings.isolated({ "mcp.toolNameCollision": "error" }));
		try {
			const other = { name: "mcp__other_lookup", mcpServerName: "other", mcpToolName: "lookup" };

			// The same origin twice is a reconnect's re-registration, not a collision.
			expect(deduplicateMCPToolsByName([dotted, { ...dotted }, other])).toEqual([dotted, other]);
		} finally {
			release();
		}
	});

	it("reads error from a --config overlay file", async () => {
		const tempDir = TempDir.createSync("@xsec-mcp-overlay-");
		try {
			const settings = await loadOverlay(tempDir, "mcp:\n  toolNameCollision: error\n");

			const release = bindEffects(settings);
			try {
				expect(thrownMessage(() => deduplicateMCPToolsByName([underscored, dotted]))).toContain(COLLIDING_NAME);
			} finally {
				release();
			}
		} finally {
			tempDir.removeSync();
		}
	});

	it("ignores an unknown mode in a --config overlay like any enum setting: keep-first applies and a warning names it", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const tempDir = TempDir.createSync("@xsec-mcp-overlay-");
		try {
			const settings = await loadOverlay(tempDir, "mcp:\n  toolNameCollision: fail\n");

			const release = bindEffects(settings);
			try {
				expect(deduplicateMCPToolsByName([underscored, dotted])).toEqual([dotted]);
				expect(warn).toHaveBeenCalledWith(
					expect.any(String),
					expect.objectContaining({ setting: "mcp.toolNameCollision" }),
				);
			} finally {
				release();
			}
		} finally {
			tempDir.removeSync();
		}
	});

	it("fails a live session's tool refresh when a --config overlay selects error, and leaves the registry unchanged", async () => {
		const tempDir = TempDir.createSync("@xsec-mcp-session-");
		fs.mkdirSync(tempDir.join("auth"), { recursive: true });
		const modelRegistry = new ModelRegistry(await discoverAuthStorage(tempDir.join("auth")));
		try {
			const settings = await loadOverlay(tempDir, "mcp:\n  toolNameCollision: error\n");
			const { session } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				modelRegistry,
				sessionManager: SessionManager.inMemory(),
				settings,
				model: getBundledModel("openai", "gpt-4o-mini"),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				rules: [],
				workspaceTree: {
					rootPath: tempDir.path(),
					rendered: "",
					truncated: false,
					totalLines: 0,
					agentsMdFiles: [],
				},
			});
			try {
				const message = await rejectionMessage(() =>
					session.refreshMCPTools([mcpTool("foo.bar"), mcpTool("foo_bar")]),
				);

				expect(message).toContain(COLLIDING_NAME);
				expect(message).toContain("foo.bar:lookup");
				expect(message).toContain("foo_bar:lookup");
				expect(session.getToolByName(COLLIDING_NAME)).toBeUndefined();
			} finally {
				await session.dispose();
			}
		} finally {
			modelRegistry.authStorage.close();
			tempDir.removeSync();
		}
	});
});
