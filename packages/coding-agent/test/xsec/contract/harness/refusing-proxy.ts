import * as http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local forward proxy that refuses every request and CONNECT it receives, and records each one. A
 * contract test points the child's proxy variables here, so any attempt to leave the machine is visible
 * in `seen`.
 */
export interface RefusingProxy {
	readonly url: string;
	/** One entry per request line or CONNECT target, in arrival order. */
	readonly seen: string[];
	stop(): Promise<void>;
}

export async function startRefusingProxy(): Promise<RefusingProxy> {
	const seen: string[] = [];
	const server = http.createServer((request, response) => {
		seen.push(`${request.method} ${request.url}`);
		response.writeHead(403, { "content-type": "text/plain" });
		response.end("refused by the contract harness");
	});
	server.on("connect", (request, socket) => {
		seen.push(`CONNECT ${request.url}`);
		socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
	});
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		seen,
		stop: () =>
			new Promise<void>(resolve => {
				server.close(() => resolve());
				server.closeAllConnections();
			}),
	};
}
