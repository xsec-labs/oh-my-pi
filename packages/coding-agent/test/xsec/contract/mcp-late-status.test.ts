import { describe, expect, setDefaultTimeout } from "bun:test";
import * as path from "node:path";
import { type AcpChild, agentMessageText, useContractSession } from "./harness";

setDefaultTimeout(120_000);

const contract = useContractSession();
const { it } = contract;
const MCP_FIXTURE = path.join(import.meta.dir, "fixtures", "mcp-fixture-server.ts");
const COLLIDING_TOOL = "mcp__foo_bar_echo";

/**
 * Two stdio MCP servers whose names differ only in `.` and `_`, so both mint `mcp__foo_bar_echo`. `foo.bar` answers
 * at once. `foo_bar` answers only after `gate` exists, so it reaches the session after session/new has returned.
 */
function collidingServers(gate: string) {
	return [
		{ name: "foo.bar", command: process.execPath, args: [MCP_FIXTURE, "foo.bar"], env: [] },
		{ name: "foo_bar", command: process.execPath, args: [MCP_FIXTURE, "foo_bar", gate], env: [] },
	];
}

/** The tools the session lists, read from `_xsec/session/capabilities`. */
async function listedTools(child: AcpChild, sessionId: string): Promise<{ name: string; description: string }[]> {
	const { tools } = await child.connection.extMethod("_xsec/session/capabilities", { sessionId });
	return tools as { name: string; description: string }[];
}

async function listedEchoes(child: AcpChild, sessionId: string): Promise<{ name: string; description: string }[]> {
	return (await listedTools(child, sessionId)).filter(tool => tool.name === COLLIDING_TOOL);
}

/**
 * Polls until the condition holds. Notices and tool registrations arrive on the server's own schedule, and the client
 * gets no event for either, so the test asks again. The 30 s bound only turns a server that never answers into a failure.
 */
async function waitUntil(condition: () => Promise<boolean> | boolean): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error("the condition did not hold within 30 seconds");
		await Bun.sleep(20);
	}
}

describe("MCP late state reported as session updates", () => {
	it("reports a server still connecting after session/new, then reports it connected once it answers", async () => {
		const home = await contract.home();
		const gate = path.join(home.base, "late-connect.gate");
		const child = await contract.child(home);
		await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });

		let sessionId = "";
		try {
			({ sessionId } = await child.connection.newSession({
				cwd: home.workspace,
				mcpServers: [
					{ name: "late.server", command: process.execPath, args: [MCP_FIXTURE, "late.server", gate], env: [] },
				],
			}));
			await waitUntil(() =>
				agentMessageText(child.connection).includes('MCP server "late.server" is still connecting.'),
			);
			// The server has not answered, so session/new returned without its tools.
			expect((await listedTools(child, sessionId)).some(tool => tool.description.includes("late.server"))).toBe(
				false,
			);
		} finally {
			// The server waits for this file. Writing it on every path lets the server answer, even if an assertion failed.
			await Bun.write(gate, "");
		}

		await waitUntil(() => agentMessageText(child.connection).includes('MCP server "late.server" connected.'));
		// The notice can arrive before the tool refresh it triggers has applied, so the test waits for the tools themselves.
		await waitUntil(async () =>
			(await listedTools(child, sessionId)).some(tool => tool.description.includes("late.server")),
		);
	});

	it("with OMP_MCP_STARTUP_TIMEOUT_MS=0, session/new waits for every server and sends no MCP notice", async () => {
		const home = await contract.home();
		const child = await contract.child(home, { env: { OMP_MCP_STARTUP_TIMEOUT_MS: "0" } });
		await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });

		const { sessionId } = await child.connection.newSession({
			cwd: home.workspace,
			mcpServers: [
				{ name: "quick.server", command: process.execPath, args: [MCP_FIXTURE, "quick.server"], env: [] },
			],
		});
		expect((await listedTools(child, sessionId)).some(tool => tool.description.includes("quick.server"))).toBe(true);

		// The bootstrap updates follow session/new. Once they have arrived, no MCP notice can still be on its way.
		await waitUntil(() =>
			child.connection.updates.some(({ update }) => update.sessionUpdate === "available_commands_update"),
		);
		expect(agentMessageText(child.connection)).not.toContain("MCP server");
	});

	it("with keep-first, a collision a late server brings is reported, and the first server's tool stays", async () => {
		const home = await contract.home({ toolNameCollision: "keep-first" });
		const gate = path.join(home.base, "late-keep-first.gate");
		const child = await contract.child(home);
		await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });

		let sessionId = "";
		try {
			({ sessionId } = await child.connection.newSession({
				cwd: home.workspace,
				mcpServers: collidingServers(gate),
			}));
			await waitUntil(async () => (await listedEchoes(child, sessionId)).length === 1);
		} finally {
			await Bun.write(gate, "");
		}

		await waitUntil(() => agentMessageText(child.connection).includes("is not added"));
		expect(agentMessageText(child.connection)).toContain(
			`MCP tool name collision on "${COLLIDING_TOOL}": foo.bar:echo is kept and foo_bar:echo is not added.`,
		);
		const echoes = await listedEchoes(child, sessionId);
		expect(echoes).toHaveLength(1);
		expect(echoes[0].description).toContain("foo.bar");
	});

	it("with error, a collision a late server brings is reported, and the tool list keeps its tools", async () => {
		const home = await contract.home({ toolNameCollision: "error" });
		const gate = path.join(home.base, "late-error.gate");
		const child = await contract.child(home);
		await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });

		let sessionId = "";
		try {
			({ sessionId } = await child.connection.newSession({
				cwd: home.workspace,
				mcpServers: collidingServers(gate),
			}));
			await waitUntil(async () => (await listedEchoes(child, sessionId)).length === 1);
		} finally {
			await Bun.write(gate, "");
		}

		await waitUntil(() => agentMessageText(child.connection).includes("both provide it"));
		expect(agentMessageText(child.connection)).toContain(
			`MCP tool name collision on "${COLLIDING_TOOL}": foo.bar:echo and foo_bar:echo both provide it, so the tool list was not updated.`,
		);
		const echoes = await listedEchoes(child, sessionId);
		expect(echoes).toHaveLength(1);
		expect(echoes[0].description).toContain("foo.bar");
	});
});
