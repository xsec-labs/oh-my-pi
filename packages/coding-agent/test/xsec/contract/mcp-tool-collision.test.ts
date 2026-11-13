import { describe, expect, it, setDefaultTimeout } from "bun:test";
import * as path from "node:path";
import { logLines, rejectionOf, toolResultTexts, useContractSession } from "./harness";

setDefaultTimeout(120_000);

const contract = useContractSession();
const MCP_FIXTURE = path.join(import.meta.dir, "fixtures", "mcp-fixture-server.ts");

/**
 * Two stdio MCP servers whose names differ only in `.` and `_`. An MCP tool name is built from its server's name
 * with those two characters folded together, so both servers mint `mcp__foo_bar_echo`. Each fixture answers `echo`
 * with the name it was started under, so a test can tell which server ran.
 */
const COLLIDING_SERVERS = [
	{ name: "foo.bar", command: process.execPath, args: [MCP_FIXTURE, "foo.bar"], env: [] },
	{ name: "foo_bar", command: process.execPath, args: [MCP_FIXTURE, "foo_bar"], env: [] },
];
const COLLIDING_TOOL = "mcp__foo_bar_echo";

describe("MCP tool name collision", () => {
	it("with mcp.toolNameCollision error, session/new fails and names the tool and both servers", async () => {
		const home = await contract.home({ toolNameCollision: "error" });
		const child = await contract.child(home);
		await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });

		const error = await rejectionOf(
			child.connection.newSession({ cwd: home.workspace, mcpServers: COLLIDING_SERVERS }),
		);

		expect(error).toMatchObject({
			code: -32603,
			data: { details: `OMP MCP Tool name collision: ${COLLIDING_TOOL} (foo.bar:echo, foo_bar:echo)` },
		});
	});

	it("with keep-first, upstream's default, the session starts, lists one tool and runs the first server's", async () => {
		const home = await contract.home({ toolNameCollision: "keep-first" });
		const child = await contract.child(home);
		await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const { sessionId } = await child.connection.newSession({ cwd: home.workspace, mcpServers: COLLIDING_SERVERS });

		const { tools } = await child.connection.extMethod("_xsec/session/capabilities", { sessionId });
		const echoes = (tools as { name: string; description: string }[]).filter(tool => tool.name === COLLIDING_TOOL);
		expect(echoes).toHaveLength(1);
		expect(echoes[0].description).toContain("foo.bar");

		home.model.enqueue({
			content: [],
			toolCall: { name: COLLIDING_TOOL, arguments: JSON.stringify({ text: "hi" }) },
		});
		home.model.enqueue({ content: ["the tool answered"] });
		const response = await child.connection.prompt({ sessionId, prompt: [{ type: "text", text: "echo hi" }] });

		expect(response.stopReason).toBe("end_turn");
		expect(toolResultTexts(home.model.requests[1])).toEqual(["foo.bar: hi"]);
		expect(logLines(home.base).some(line => line.includes("keeping stable winner"))).toBe(true);
	});
});
