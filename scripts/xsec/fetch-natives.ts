#!/usr/bin/env bun
/**
 * Installs upstream's prebuilt native addons for the release this checkout is
 * based on, so the fork's CI never compiles Rust.
 *
 * Upstream publishes one npm package per platform
 * (`@oh-my-pi/pi-natives-<tag>`) with every release, stamped with the release
 * version. A compiled binary only embeds an addon whose stamp equals the
 * package version, and the fork never edits versions, so the addon for
 * `v<package version>` is always the right one.
 *
 * Usage: bun scripts/xsec/fetch-natives.ts <tag>... [--dest <dir>]
 *   tags: linux-x64 linux-arm64 darwin-x64 darwin-arm64 win32-x64 win32-arm64
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readUpstreamVersion, repoRoot } from "./upstream";

const REGISTRY_URL = "https://registry.npmjs.org";
/** Registry metadata is a small JSON document; a slower response has stalled. */
const METADATA_TIMEOUT_MS = 60_000;
/** Addons are tens of megabytes; this only stops a stalled transfer. */
const TARBALL_TIMEOUT_MS = 600_000;
const ADDON_ENTRY = /^package\/[^/]+\.node$/;
const KNOWN_TAGS: readonly string[] = [
	"linux-x64",
	"linux-arm64",
	"darwin-x64",
	"darwin-arm64",
	"win32-x64",
	"win32-arm64",
];

interface CliArgs {
	tags: string[];
	dest: string;
}

/** Parses the command line; throws on an unknown platform tag or a missing value. */
export function parseArgs(argv: readonly string[]): CliArgs {
	const tags: string[] = [];
	let dest = path.join(repoRoot, "packages", "natives", "native");
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--dest") {
			const value = argv[++i];
			if (!value) throw new Error("--dest requires a directory");
			dest = path.resolve(value);
		} else if (KNOWN_TAGS.includes(arg)) {
			tags.push(arg);
		} else {
			throw new Error(`Unknown platform tag "${arg}". Known tags: ${KNOWN_TAGS.join(", ")}`);
		}
	}
	if (tags.length === 0) throw new Error(`No platform tag given. Known tags: ${KNOWN_TAGS.join(", ")}`);
	return { tags, dest };
}

/**
 * Checks tarball bytes against an npm `dist.integrity` value
 * (`sha512-<base64>`). Throws when the algorithm is not sha512 or the digest
 * differs.
 */
export function verifyIntegrity(bytes: Uint8Array, integrity: string, label: string): void {
	const match = /^sha512-(.+)$/.exec(integrity);
	if (!match) throw new Error(`${label}: unsupported integrity value "${integrity}"`);
	const actual = new Bun.CryptoHasher("sha512").update(bytes).digest("base64");
	if (actual !== match[1]) {
		throw new Error(`${label}: integrity mismatch, registry says ${integrity} but the download is sha512-${actual}`);
	}
}

/**
 * Copies every `.node` file at the top of one package tarball into `dest` and
 * returns their names. The bytes must already have passed `verifyIntegrity`.
 */
export async function installAddons(tarball: Uint8Array, dest: string, label: string): Promise<string[]> {
	const files = await new Bun.Archive(tarball).files();
	const addons = [...files].filter(([entry]) => ADDON_ENTRY.test(entry));
	if (addons.length === 0) throw new Error(`${label}: package contains no .node file`);
	await fs.mkdir(dest, { recursive: true });
	const names: string[] = [];
	for (const [entry, file] of addons) {
		const name = path.posix.basename(entry);
		await Bun.write(path.join(dest, name), file);
		names.push(name);
	}
	return names;
}

async function fetchLeaf(tag: string, version: string, dest: string): Promise<string[]> {
	const name = `@oh-my-pi/pi-natives-${tag}`;
	const label = `${name}@${version}`;
	const metadataResponse = await fetch(`${REGISTRY_URL}/${name}/${version}`, {
		signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
	});
	if (!metadataResponse.ok) throw new Error(`${label}: registry returned HTTP ${metadataResponse.status}`);
	const metadata = (await metadataResponse.json()) as { dist?: { tarball?: string; integrity?: string } };
	const tarballUrl = metadata.dist?.tarball;
	const integrity = metadata.dist?.integrity;
	if (!tarballUrl || !integrity) throw new Error(`${label}: registry metadata has no tarball or integrity`);

	const tarballResponse = await fetch(tarballUrl, { signal: AbortSignal.timeout(TARBALL_TIMEOUT_MS) });
	if (!tarballResponse.ok) throw new Error(`${label}: tarball download returned HTTP ${tarballResponse.status}`);
	const bytes = new Uint8Array(await tarballResponse.arrayBuffer());
	verifyIntegrity(bytes, integrity, label);
	return installAddons(bytes, dest, label);
}

async function main(): Promise<void> {
	const { tags, dest } = parseArgs(process.argv.slice(2));
	const version = await readUpstreamVersion();
	for (const tag of tags) {
		const addons = await fetchLeaf(tag, version, dest);
		console.log(`${tag}@${version}: ${addons.join(", ")} -> ${dest}`);
	}
}

if (import.meta.main) await main();
