/**
 * A stdio MCP server for the contract tests. It exposes one tool, `echo`, and answers with the name this
 * server was started under, so a test can tell which server a tool came from. It is a fixture written for
 * this suite, not an MCP product.
 */

interface JsonRpcRequest {
	id?: number | string;
	method: string;
	params?: { protocolVersion?: string; arguments?: { text?: unknown } };
}

const serverName = process.argv[2] ?? "unnamed";
const echoTool = {
	name: "echo",
	description: `Echoes its text, prefixed with the name of the ${serverName} fixture server.`,
	inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
};

function send(message: unknown): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(request: JsonRpcRequest): void {
	// A notification has no id and gets no answer.
	if (request.id === undefined) return;
	switch (request.method) {
		case "initialize":
			send({
				jsonrpc: "2.0",
				id: request.id,
				result: {
					protocolVersion: request.params?.protocolVersion ?? "2024-11-05",
					capabilities: { tools: {} },
					serverInfo: { name: serverName, version: "0.0.0" },
				},
			});
			return;
		case "tools/list":
			send({ jsonrpc: "2.0", id: request.id, result: { tools: [echoTool] } });
			return;
		case "tools/call": {
			const text = String(request.params?.arguments?.text ?? "");
			const content = [{ type: "text", text: `${serverName}: ${text}` }];
			send({ jsonrpc: "2.0", id: request.id, result: { content } });
			return;
		}
		default:
			send({
				jsonrpc: "2.0",
				id: request.id,
				error: { code: -32601, message: `method not found: ${request.method}` },
			});
	}
}

// A test that needs this server to come up late passes a gate file as the third argument. The server reads nothing
// until that file exists, so the test decides when the server starts answering.
async function serve(): Promise<void> {
	const gatePath = process.argv[3];
	if (gatePath) {
		while (!(await Bun.file(gatePath).exists())) await Bun.sleep(10);
	}
	let pending = "";
	process.stdin.setEncoding("utf8");
	process.stdin.on("data", (chunk: string) => {
		pending += chunk;
		for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
			const line = pending.slice(0, newline).trim();
			pending = pending.slice(newline + 1);
			if (line) handle(JSON.parse(line) as JsonRpcRequest);
		}
	});
}

void serve();
