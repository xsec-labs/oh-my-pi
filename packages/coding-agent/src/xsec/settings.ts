/**
 * Fork setting: which providers model discovery may contact. Declared under the fork's
 * prefix; `config/all-settings.ts` imports this module. Behaviour lives in `./model-discovery.ts`.
 */
import { register } from "../config/registry";

/**
 * `all` (default): upstream's discovery, which also probes built-in and local providers and the
 * models.dev catalog. `configured`: discovery contacts only the providers listed in models.yml.
 */
export const cfgModelsDiscovery = register({
	id: "models.discovery",
	type: "enum",
	values: ["all", "configured"] as const,
	default: "all",
});
