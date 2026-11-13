import * as fs from "node:fs";
import * as path from "node:path";

/** The `.log` files the child wrote under a test's base directory. */
export function logFiles(base: string): string[] {
	return (fs.readdirSync(base, { recursive: true }) as string[])
		.filter(entry => entry.endsWith(".log"))
		.map(entry => path.join(base, entry));
}

/** Every line of every log file the child wrote under a test's base directory. */
export function logLines(base: string): string[] {
	return logFiles(base).flatMap(file => fs.readFileSync(file, "utf8").split("\n"));
}

/** The last `count` lines of each log file under a test's base directory, each under a heading with its path. */
export function logTails(base: string, count: number): string {
	return logFiles(base)
		.map(file => {
			const lines = fs.readFileSync(file, "utf8").split("\n");
			return `--- ${file}: last ${Math.min(count, lines.length)} of ${lines.length} lines ---\n${lines.slice(-count).join("\n")}`;
		})
		.join("\n\n");
}
