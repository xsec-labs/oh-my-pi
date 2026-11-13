import { describe, expect, setDefaultTimeout } from "bun:test";
import { rejectionOf, useContractSession } from "./harness";

setDefaultTimeout(120_000);

const contract = useContractSession();
const { it } = contract;
const CAPABILITIES = "_xsec/session/capabilities";

describe("_xsec/session/capabilities", () => {
	it("lists the enabled tools with name, description, inputSchema and source", async () => {
		const home = await contract.home();
		const child = await contract.child(home);
		await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const { sessionId } = await child.connection.newSession({ cwd: home.workspace, mcpServers: [] });

		const result = await child.connection.extMethod(CAPABILITIES, { sessionId });

		expect(Array.isArray(result.tools)).toBe(true);
		const tools: unknown[] = Array.isArray(result.tools) ? result.tools : [];
		expect(tools.length).toBeGreaterThan(0);
		for (const tool of tools) {
			expect(tool).toMatchObject({
				name: expect.any(String),
				description: expect.any(String),
				inputSchema: expect.any(Object),
				source: expect.any(String),
			});
		}
	});

	it("fails an unknown _xsec method as an unknown method", async () => {
		const home = await contract.home();
		const child = await contract.child(home);
		await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });

		const error = await rejectionOf(child.connection.extMethod("_xsec/no/such/method", {}));

		expect(error).toMatchObject({ code: -32601 });
	});

	it("fails a missing sessionId as invalid params", async () => {
		const home = await contract.home();
		const child = await contract.child(home);
		await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });

		const error = await rejectionOf(child.connection.extMethod(CAPABILITIES, {}));

		expect(error).toMatchObject({ code: -32602 });
	});

	it("fails an unknown session id as not found", async () => {
		const home = await contract.home();
		const child = await contract.child(home);
		await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });

		const error = await rejectionOf(child.connection.extMethod(CAPABILITIES, { sessionId: "no-such-session" }));

		expect(error).toMatchObject({ code: -32002 });
	});
});
