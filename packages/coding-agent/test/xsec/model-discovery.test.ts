import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-ai";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { ModelDiscoveryLimit } from "@oh-my-pi/pi-coding-agent/xsec/model-discovery";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

/**
 * A local endpoint that stands for every local provider. It records every request it receives
 * and serves a model list on `/v1/models`.
 */
interface RecordingEndpoint {
	/** The base URL, `http://127.0.0.1:<port>/v1`. */
	baseUrl: string;
	/** `METHOD /path` of every request received. */
	requests: string[];
	stop(): void;
}

function startRecordingEndpoint(): RecordingEndpoint {
	const requests: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const { pathname } = new URL(request.url);
			requests.push(`${request.method} ${pathname}`);
			if (pathname === "/v1/models") {
				return Response.json({
					object: "list",
					data: [{ id: "discovered-model" }, { id: "gpt-test-only-9" }],
				});
			}
			return new Response("not found", { status: 404 });
		},
	});
	return {
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
		requests,
		stop: () => {
			server.stop(true);
		},
	};
}

/**
 * A proxy that refuses every request and records its target. A request that reaches it left the
 * process for a host the test did not configure.
 */
interface RefusingProxy {
	url: string;
	/** The target of every request received, e.g. `catalog.stencil.so:443` for a CONNECT. */
	targets: string[];
	close(): Promise<void>;
}

async function startRefusingProxy(): Promise<RefusingProxy> {
	const targets: string[] = [];
	const server = net.createServer(socket => {
		let head = "";
		socket.on("data", (chunk: Buffer) => {
			if (head.length > 0) return;
			head = chunk.toString("latin1");
			targets.push(head.split(" ")[1] ?? head);
			socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
		});
		socket.on("error", () => {});
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("refusing proxy has no TCP address");
	return {
		url: `http://127.0.0.1:${address.port}`,
		targets,
		close: () => {
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			return closed.promise;
		},
	};
}

/**
 * The fetch the registry uses in these tests: loopback requests go out directly, every other
 * request goes through the refusing proxy, so anything sent to a foreign host is recorded there.
 */
function fetchVia(proxyUrl: string): FetchImpl {
	return (input, init) => {
		const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const { hostname } = new URL(href);
		if (hostname === "127.0.0.1" || hostname === "localhost") return fetch(input, init);
		return fetch(input, { ...init, proxy: proxyUrl });
	};
}

/** The env variables that point the implicit local providers (ollama, LM Studio, llama.cpp) somewhere. */
const LOCAL_PROVIDER_ENDPOINT_ENV = ["OLLAMA_BASE_URL", "LM_STUDIO_BASE_URL", "LLAMA_CPP_BASE_URL"] as const;

describe("models.discovery", () => {
	let tempDir: string;
	let modelsPath: string;
	let authStorage: AuthStorage;
	let endpoint: RecordingEndpoint;
	let proxy: RefusingProxy;
	let savedEnv: Record<string, string | undefined>;

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-xsec-model-discovery-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsPath = path.join(tempDir, "models.yml");
		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		endpoint = startRecordingEndpoint();
		proxy = await startRefusingProxy();
		// Point the implicit local providers at the recording endpoint: a probe of any of them is then recorded.
		savedEnv = Object.fromEntries(LOCAL_PROVIDER_ENDPOINT_ENV.map(name => [name, Bun.env[name]]));
		for (const name of LOCAL_PROVIDER_ENDPOINT_ENV) Bun.env[name] = endpoint.baseUrl;
		fs.writeFileSync(
			modelsPath,
			[
				"providers:",
				"  local-discovered:",
				`    baseUrl: ${endpoint.baseUrl}`,
				"    api: openai-completions",
				"    auth: none",
				"    discovery:",
				"      type: openai-models-list",
				"  local-static:",
				`    baseUrl: ${endpoint.baseUrl}`,
				"    api: openai-completions",
				"    auth: none",
				"    models:",
				"      - id: static-model",
				"        name: Static model",
				"        contextWindow: 8192",
				"        maxTokens: 1024",
			].join("\n"),
		);
	});

	afterEach(async () => {
		for (const name of LOCAL_PROVIDER_ENDPOINT_ENV) {
			const previous = savedEnv[name];
			if (previous === undefined) delete Bun.env[name];
			else Bun.env[name] = previous;
		}
		endpoint.stop();
		await proxy.close();
		authStorage.close();
		if (fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	/** Settings read from a `--config` overlay file, the way Desktop sets the limit. */
	async function loadConfiguredSettings(): Promise<Settings> {
		const overlayDir = path.join(tempDir, "overlay");
		fs.mkdirSync(overlayDir, { recursive: true });
		const overlayPath = path.join(overlayDir, "config.yml");
		fs.writeFileSync(overlayPath, "models:\n  discovery: configured\n");
		return Settings.loadReadOnly({
			configFiles: [overlayPath],
			cwd: overlayDir,
			agentDir: path.join(tempDir, "agent"),
		});
	}

	test("configured: only the configured endpoint is contacted, and its models resolve", async () => {
		const registry = new ModelRegistry(authStorage, modelsPath, {
			fetch: fetchVia(proxy.url),
			settings: await loadConfiguredSettings(),
		});
		await registry.refresh("online");

		// The implicit local providers point at the endpoint too, so a probe of ollama, LM Studio
		// or llama.cpp would appear here: only the configured provider's own request does.
		expect(endpoint.requests).toEqual(["GET /v1/models"]);
		expect(proxy.targets).toEqual([]);
		expect(registry.getProviderDiscoveryState("local-discovered")?.status).toBe("ok");
		expect(registry.find("local-discovered", "discovered-model")).toBeDefined();
		expect(registry.find("local-static", "static-model")).toBeDefined();
	});

	test("configured: a configured built-in provider uses its own endpoint and never requests the catalog", async () => {
		fs.writeFileSync(
			modelsPath,
			["providers:", "  openai:", `    baseUrl: ${endpoint.baseUrl}`, "    apiKey: test-key"].join("\n"),
		);
		const registry = new ModelRegistry(authStorage, modelsPath, {
			fetch: fetchVia(proxy.url),
			settings: await loadConfiguredSettings(),
		});
		await registry.refresh("online");

		expect(endpoint.requests).toEqual(["GET /v1/models"]);
		expect(proxy.targets).toEqual([]);
		// A refused catalog request would surface as a failed discovery of this provider.
		const state = registry.getProviderDiscoveryState("openai");
		expect(state?.error).toBeUndefined();
		expect(state?.status).not.toBe("unavailable");
		// An id only the endpoint lists: it resolves only if the built-in discovery used the endpoint.
		expect(registry.find("openai", "gpt-test-only-9")).toBeDefined();
	});

	test("configured: a configured catalog-only provider keeps its bundled models and makes no catalog request", async () => {
		fs.writeFileSync(
			modelsPath,
			["providers:", "  minimax:", `    baseUrl: ${endpoint.baseUrl}`, "    apiKey: test-key"].join("\n"),
		);
		const [bundled] = getBundledModels("minimax");
		if (bundled === undefined) throw new Error("the bundled catalog has no minimax model");
		const registry = new ModelRegistry(authStorage, modelsPath, {
			fetch: fetchVia(proxy.url),
			settings: await loadConfiguredSettings(),
		});
		await registry.refresh("online");

		expect(endpoint.requests).toEqual([]);
		expect(proxy.targets).toEqual([]);
		// Without the catalog source dropped, the refused catalog request leaves this provider unavailable.
		const state = registry.getProviderDiscoveryState("minimax");
		expect(state?.error).toBeUndefined();
		expect(state?.status).not.toBe("unavailable");
		expect(registry.find("minimax", bundled.id)).toBeDefined();
	});

	test("all (default): the same registry probes the local providers and attempts the built-in catalog", async () => {
		const registry = new ModelRegistry(authStorage, modelsPath, {
			fetch: fetchVia(proxy.url),
			settings: Settings.isolated({}),
		});
		await registry.refresh("online");

		// Without the limit, the implicit ollama provider probes its endpoint and the models.dev
		// catalog (a host no provider configures) is requested through the proxy.
		expect(endpoint.requests).toContain("GET /api/tags");
		expect(proxy.targets).toContain("catalog.stencil.so:443");
		expect(registry.find("local-discovered", "discovered-model")).toBeDefined();
		expect(registry.find("local-static", "static-model")).toBeDefined();
	});
});

describe("ModelDiscoveryLimit.guardFetch", () => {
	const alphaBaseUrl = "https://alpha.example.test/v1";

	test("configured: refuses an origin no configured provider owns before the base fetch sees it", async () => {
		const limit = new ModelDiscoveryLimit(Settings.isolated({ "models.discovery": "configured" }));
		limit.setConfiguredProviders(new Set(["alpha"]));
		const reached: string[] = [];
		const base: FetchImpl = input => {
			reached.push(String(input));
			return Promise.resolve(new Response("{}"));
		};
		const guarded = limit.guardFetch(base, providerId => (providerId === "alpha" ? alphaBaseUrl : undefined));

		await expect(guarded("https://catalog.stencil.so/models.json.zstd")).rejects.toThrow(
			"refused https://catalog.stencil.so",
		);
		expect((await guarded(`${alphaBaseUrl}/models`)).status).toBe(200);
		expect(reached).toEqual([`${alphaBaseUrl}/models`]);
	});

	test("all: passes every request to the base fetch", async () => {
		const limit = new ModelDiscoveryLimit(Settings.isolated({}));
		const reached: string[] = [];
		const base: FetchImpl = input => {
			reached.push(String(input));
			return Promise.resolve(new Response("{}"));
		};
		const guarded = limit.guardFetch(base, () => undefined);

		await guarded("https://catalog.stencil.so/models.json.zstd");
		expect(reached).toEqual(["https://catalog.stencil.so/models.json.zstd"]);
	});
});
