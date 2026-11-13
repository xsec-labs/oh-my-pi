import { afterEach, it as bunIt } from "bun:test";
import { type AcpChild, type AcpChildOptions, startAcpChild } from "./acp-client";
import { logTails } from "./logs";
import { type ContractHome, type ContractHomeOptions, createContractHome } from "./omp-process";

/** The helpers a contract test uses to open its homes and children. */
export interface ContractSession {
	/** A fresh home with its own fake model server and refusing proxy. */
	home(options?: ContractHomeOptions): Promise<ContractHome>;
	/** An `omp acp` child for the home, connected over stdio, with optional arguments and environment. */
	child(home: ContractHome, options?: AcpChildOptions): Promise<AcpChild>;
	/**
	 * Declares a test like `bun:test`'s `it`. When the body fails, the error also carries what the test's omp children
	 * wrote: each child's stderr and the tail of every log under each home. A test that times out gets none of that,
	 * because Bun ends it before the body has finished.
	 */
	it(name: string, body: () => unknown): void;
}

/** How much of an omp child's stderr, and how many lines of each log, a failure report carries. */
const STDERR_TAIL_CHARS = 8000;
const LOG_TAIL_LINES = 80;

/** Registers the cleanup of every home and child the test opens, also on failure, and returns the helpers. */
export function useContractSession(): ContractSession {
	const homes: ContractHome[] = [];
	const children: AcpChild[] = [];
	afterEach(async () => {
		for (const child of children.splice(0)) await child.close();
		for (const home of homes.splice(0)) await home.dispose();
	});
	return {
		async home(options) {
			const home = await createContractHome(options);
			homes.push(home);
			return home;
		},
		async child(home, options) {
			const child = await startAcpChild(home, options);
			children.push(child);
			return child;
		},
		it(name, body) {
			// The report is read here, before afterEach closes the children and disposes the homes.
			bunIt(name, async () => {
				try {
					await body();
				} catch (error) {
					throw withDiagnostics(error, homes, children);
				}
			});
		},
	};
}

/** The failure, with the report appended to its message so the CI log shows it under the assertion. */
function withDiagnostics(error: unknown, homes: readonly ContractHome[], children: readonly AcpChild[]): unknown {
	const report = failureReport(homes, children);
	if (error instanceof Error) {
		error.message = `${error.message}\n\n${report}`;
		return error;
	}
	return new Error(`${String(error)}\n\n${report}`, { cause: error });
}

/**
 * Each omp child's stderr, then the tail of each log under each home. It never throws, so a failure stays a failure.
 * The report lands in the CI logs of a public fork, so contract fixtures use only synthetic values.
 */
function failureReport(homes: readonly ContractHome[], children: readonly AcpChild[]): string {
	const sections: string[] = ["=== contract failure diagnostics ==="];
	if (children.length === 0) sections.push("--- this test started no omp child ---");
	for (const [index, child] of children.entries()) {
		const stderr = child.stderr();
		const shown = stderr.length > STDERR_TAIL_CHARS ? `...${stderr.slice(-STDERR_TAIL_CHARS)}` : stderr;
		sections.push(`--- omp child ${index + 1} stderr ---\n${shown || "(empty)"}`);
	}
	for (const home of homes) {
		try {
			sections.push(logTails(home.base, LOG_TAIL_LINES) || `--- no log files under ${home.base} ---`);
		} catch (error) {
			sections.push(`--- logs under ${home.base} could not be read: ${String(error)} ---`);
		}
	}
	return sections.join("\n\n");
}
