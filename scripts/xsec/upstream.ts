import * as path from "node:path";

/** The repository this fork tracks. */
export const UPSTREAM_REPO_URL = "https://github.com/can1357/oh-my-pi";

export const repoRoot = path.join(import.meta.dir, "..", "..");

/**
 * The upstream release this checkout is based on. The fork never edits package
 * versions, so the coding-agent manifest always carries the version of the
 * upstream tag that was last merged in.
 */
export async function readUpstreamVersion(): Promise<string> {
	const manifestPath = path.join(repoRoot, "packages", "coding-agent", "package.json");
	const manifest = (await Bun.file(manifestPath).json()) as { version?: unknown };
	if (typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+$/.test(manifest.version)) {
		throw new Error(`${manifestPath} has no plain x.y.z version: ${JSON.stringify(manifest.version)}`);
	}
	return manifest.version;
}
