import { describe, expect, setDefaultTimeout } from "bun:test";
import * as path from "node:path";
import { type AcpChild, logLines, rejectionOf, toolResultTexts, useContractSession } from "./harness";

setDefaultTimeout(120_000);

const contract = useContractSession();
const { it } = contract;
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

/**
 * The MCP startup window Desktop passes when it starts omp. With 0, session/new waits for every configured server to
 * settle, so a collision is reported by the request that starts the session. The first two cases start their child
 * with it; the third case starts one without it, to pin what the default window does.
 */
const DESKTOP_MCP_WINDOW = { OMP_MCP_STARTUP_TIMEOUT_MS: "0" };

/** The names of the echo tools the session lists, read from `_xsec/session/capabilities`. */
async function listedEchoes(child: AcpChild, sessionId: string): Promise<string[]> {
	const { tools } = await child.connection.extMethod("_xsec/session/capabilities", { sessionId });
	return (tools as { name: string }[]).map(tool => tool.name).filter(name => name === COLLIDING_TOOL);
}

/**
 * Polls until the condition holds. ACP sends no event when an MCP tool is registered, so the test asks again. The
 * 30 s bound only turns a server that never answers into a failure: no assertion depends on how long the wait takes.
 */
async function waitUntil(condition: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error("the condition did not hold within 30 seconds");
		await Bun.sleep(20);
	}
}

describe("MCP tool name collision", () => {
	it("with mcp.toolNameCollision error, session/new fails and names the tool and both servers", async () => {
		const home = await contract.home({ toolNameCollision: "error" });
		const child = await contract.child(home, { env: DESKTOP_MCP_WINDOW });
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
		const child = await contract.child(home, { env: DESKTOP_MCP_WINDOW });
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

	it("with the default window, session/new returns with no error before a slow server answers, and the tool appears once it does", async () => {
		const home = await contract.home({ toolNameCollision: "error" });
		// The server answers only after this file exists, so the gate, not the window, keeps its tool out of the session.
		const gate = path.join(home.base, "slow-server.gate");
		// No window override: the default applies, as it does for a Desktop that passes nothing.
		const child = await contract.child(home);
		await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });

		let sessionId = "";
		try {
			({ sessionId } = await child.connection.newSession({
				cwd: home.workspace,
				mcpServers: [{ name: "foo.bar", command: process.execPath, args: [MCP_FIXTURE, "foo.bar", gate], env: [] }],
			}));
			// The server has not answered, so no tool is listed, and session/new did not fail.
			expect(await listedEchoes(child, sessionId)).toEqual([]);
		} finally {
			// The server waits for this file. Writing it on every path lets the server exit, even if an assertion failed.
			await Bun.write(gate, "");
		}

		await waitUntil(async () => (await listedEchoes(child, sessionId)).length === 1);
		const { tools } = await child.connection.extMethod("_xsec/session/capabilities", { sessionId });
		const echoes = (tools as { name: string; description: string }[]).filter(tool => tool.name === COLLIDING_TOOL);
		expect(echoes[0].description).toContain("foo.bar");
	});
});
