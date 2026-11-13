import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { installAddons, parseArgs, verifyIntegrity } from "./fetch-natives";

describe("native addon download", () => {
	it("accepts bytes that match the registry's sha512 integrity and rejects any others", () => {
		const bytes = new TextEncoder().encode("addon bytes");
		const integrity = `sha512-${new Bun.CryptoHasher("sha512").update(bytes).digest("base64")}`;
		expect(() => verifyIntegrity(bytes, integrity, "pkg@1.0.0")).not.toThrow();
		expect(() => verifyIntegrity(new TextEncoder().encode("tampered"), integrity, "pkg@1.0.0")).toThrow(
			"integrity mismatch",
		);
	});

	it("refuses an integrity value it cannot check", () => {
		expect(() => verifyIntegrity(new Uint8Array(), "sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk=", "pkg@1.0.0")).toThrow(
			"unsupported integrity",
		);
	});

	it("rejects an unknown platform tag and an empty tag list", () => {
		expect(() => parseArgs(["linux-x64", "solaris-sparc"])).toThrow('Unknown platform tag "solaris-sparc"');
		expect(() => parseArgs(["--dest", "out"])).toThrow("No platform tag given");
	});
});

describe("native addon install", () => {
	it("copies the addon files of a package tarball and nothing else", async () => {
		const tarball = await new Bun.Archive(
			{
				"package/package.json": "{}",
				"package/pi_natives.linux-x64-modern.node": "modern addon",
				"package/pi_natives.linux-x64-baseline.node": "baseline addon",
				"package/lib/nested.node": "not at the top of the package",
			},
			{ compress: "gzip" },
		).bytes();
		const dest = await fs.mkdtemp(path.join(os.tmpdir(), "xsec-natives-test-"));
		try {
			const names = await installAddons(tarball, dest, "pkg@1.0.0");
			expect([...names].sort()).toEqual(["pi_natives.linux-x64-baseline.node", "pi_natives.linux-x64-modern.node"]);
			expect((await fs.readdir(dest)).sort()).toEqual([...names].sort());
			expect(await Bun.file(path.join(dest, "pi_natives.linux-x64-modern.node")).text()).toBe("modern addon");
		} finally {
			await fs.rm(dest, { recursive: true, force: true });
		}
	});

	it("fails instead of reporting success when a package holds no addon", async () => {
		const tarball = await new Bun.Archive({ "package/index.js": "export {};" }, { compress: "gzip" }).bytes();
		await expect(installAddons(tarball, path.join(os.tmpdir(), "xsec-natives-unused"), "pkg@1.0.0")).rejects.toThrow(
			"pkg@1.0.0: package contains no .node file",
		);
	});
});
