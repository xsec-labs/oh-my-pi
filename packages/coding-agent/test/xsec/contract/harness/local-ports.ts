/**
 * Listeners on the local ports that model discovery probes by default. A contract test starts them before
 * its child, so a connection a probe opens to one of these ports is recorded. A port that another process
 * already holds cannot be watched: it is named in `skipped`, and the test prints it.
 */

/**
 * The default ports, as the provider descriptors set them in `src/config/model-discovery.ts`: Ollama
 * (`DEFAULT_OLLAMA_BASE_URL`), LM Studio (its default base URL) and llama.cpp (`LLAMA_CPP_DEFAULT_BASE_URLS`,
 * its legacy and current ports). Every one of them is on 127.0.0.1.
 */
export const DISCOVERY_PORTS: readonly { readonly provider: string; readonly port: number }[] = [
	{ provider: "ollama", port: 11434 },
	{ provider: "lm-studio", port: 1234 },
	{ provider: "llama.cpp (legacy)", port: 8080 },
	{ provider: "llama.cpp (current)", port: 9931 },
];

/** What reached the watched ports, and which ports could not be watched. */
export interface DiscoveryPortWatch {
	/** One entry per connection and per request line that reached a watched port, in arrival order. */
	readonly hits: string[];
	/** Ports another process holds, so nothing on them is watched. */
	readonly skipped: string[];
	stop(): void;
}

/** Opens a listener on each discovery port that is free. Every request is recorded and answered with a 404. */
export function watchDiscoveryPorts(): DiscoveryPortWatch {
	const hits: string[] = [];
	const skipped: string[] = [];
	const listeners: { stop(closeActiveConnections?: boolean): void }[] = [];
	for (const { provider, port } of DISCOVERY_PORTS) {
		const label = `${provider} :${port}`;
		try {
			listeners.push(
				Bun.listen({
					hostname: "127.0.0.1",
					port,
					socket: {
						open() {
							hits.push(`${label} connection`);
						},
						data(socket, data) {
							const requestLine = new TextDecoder().decode(data).split("\r\n")[0] ?? "";
							hits.push(`${label} ${requestLine}`);
							socket.end("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
						},
						error() {},
					},
				}),
			);
		} catch {
			skipped.push(label);
		}
	}
	if (skipped.length > 0) {
		console.log(`discovery ports not watched, already in use: ${skipped.join(", ")}`);
	}
	return {
		hits,
		skipped,
		stop() {
			for (const listener of listeners) listener.stop(true);
		},
	};
}
