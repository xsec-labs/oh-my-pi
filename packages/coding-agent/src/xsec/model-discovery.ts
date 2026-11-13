/**
 * `models.discovery` (see `./settings.ts`): with `configured`, model discovery contacts only the
 * providers listed in models.yml, each at its own base URL, and every other request is refused
 * before it leaves the process. The models.dev catalog host is not a provider, so the catalog
 * source is dropped in that mode. With `all` (the default) nothing changes.
 *
 * `model-registry.ts` keeps one {@link ModelDiscoveryLimit} and calls it at the points that start
 * discovery: the fetch it hands out, the providers each static load lists, and the filters over
 * the providers and managers a refresh runs.
 */
import type { Api, FetchImpl } from "@oh-my-pi/pi-ai";
import type { ModelManagerOptions } from "@oh-my-pi/pi-catalog/model-manager";
import { logger } from "@oh-my-pi/pi-utils";
import { Settings, settings } from "../config/settings";
import { cfgModelsDiscovery } from "./settings";

export type ModelDiscoveryMode = "all" | "configured";

const warnedKeys = new Set<string>();

/** Logs `message` the first time `key` is seen in this process, so a per-request read cannot flood the log. */
function warnOnce(key: string, message: string, context?: Record<string, unknown>): void {
	if (warnedKeys.has(key)) return;
	warnedKeys.add(key);
	logger.warn(message, context);
}

/**
 * The mode for `settingsInstance` (the global settings when absent). With no settings loaded and none
 * passed, nothing is configured and the default applies, and that fallback is logged once. A loaded
 * instance whose mode cannot be read is `configured`: discovery stays limited, and the failure is logged once.
 */
export function readModelDiscoveryMode(settingsInstance?: Settings): ModelDiscoveryMode {
	if (settingsInstance === undefined && Settings.current === null) {
		warnOnce(
			"no-settings",
			"models.discovery read before any settings were loaded; the default (all) applies. Load settings first.",
		);
		return "all";
	}
	try {
		return cfgModelsDiscovery.get(settingsInstance ?? settings);
	} catch (error) {
		warnOnce(
			"unreadable",
			"models.discovery cannot be read; model discovery stays limited to the configured providers",
			{ error: error instanceof Error ? error.message : String(error) },
		);
		return "configured";
	}
}

/** The origin (`scheme://host:port`) of `target`, or undefined when it is not an HTTP(S) URL. */
function originOf(target: string | URL | Request): string | undefined {
	const href = typeof target === "string" ? target : target instanceof URL ? target.href : target.url;
	try {
		const { origin } = new URL(href);
		return origin === "null" ? undefined : origin;
	} catch {
		return undefined;
	}
}

/**
 * The discovery limit of one registry. The mode is read on every decision, so a changed setting
 * applies from the next discovery pass.
 */
export class ModelDiscoveryLimit {
	readonly #settings: Settings | undefined;
	#configuredProviders: ReadonlySet<string> = new Set();

	constructor(settingsInstance?: Settings) {
		this.#settings = settingsInstance;
	}

	/** Whether discovery is limited to the providers configured in models.yml. */
	get limited(): boolean {
		return readModelDiscoveryMode(this.#settings) === "configured";
	}

	/** Records the providers models.yml lists. Called on every static load; implicit local providers are not among them. */
	setConfiguredProviders(providerIds: ReadonlySet<string>): void {
		this.#configuredProviders = providerIds;
	}

	/** Whether discovery may contact `providerId`. */
	allowsProvider(providerId: string): boolean {
		return !this.limited || this.#configuredProviders.has(providerId);
	}

	/** `options` without the models.dev catalog source when limited, so no catalog request is made. */
	withoutCatalogSource(options: ModelManagerOptions<Api>): ModelManagerOptions<Api> {
		if (options.modelsDev === undefined || !this.limited) return options;
		return { ...options, modelsDev: undefined };
	}

	/**
	 * Wraps `base`, the fetch discovery uses. When limited, a request goes out only to the origin of
	 * a configured provider's base URL; `baseUrlOf` gives a provider's base URL (its configured one,
	 * or the built-in default). Anything else is refused before it reaches `base`.
	 */
	guardFetch(base: FetchImpl, baseUrlOf: (providerId: string) => string | undefined): FetchImpl {
		return (input, init) => {
			if (!this.limited) return base(input, init);
			const origin = originOf(input);
			if (origin !== undefined && this.#configuredOrigins(baseUrlOf).has(origin)) return base(input, init);
			return Promise.reject(
				new Error(
					`model discovery refused ${origin ?? "a request without an HTTP origin"}: models.discovery is "configured" and no configured provider uses that origin`,
				),
			);
		};
	}

	#configuredOrigins(baseUrlOf: (providerId: string) => string | undefined): Set<string> {
		const origins = new Set<string>();
		for (const providerId of this.#configuredProviders) {
			const baseUrl = baseUrlOf(providerId);
			const origin = baseUrl === undefined ? undefined : originOf(baseUrl);
			if (origin !== undefined) origins.add(origin);
		}
		return origins;
	}
}
