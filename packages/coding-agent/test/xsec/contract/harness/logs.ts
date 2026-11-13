import * as fs from "node:fs";
import * as path from "node:path";

/** Every line of every log file the child wrote under a test's base directory. */
export function logLines(base: string): string[] {
	const lines: string[] = [];
	for (const entry of fs.readdirSync(base, { recursive: true }) as string[]) {
		if (!entry.endsWith(".log")) continue;
		lines.push(...fs.readFileSync(path.join(base, entry), "utf8").split("\n"));
	}
	return lines;
}
