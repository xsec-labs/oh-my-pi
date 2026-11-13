import { afterEach } from "bun:test";
import { type AcpChild, startAcpChild } from "./acp-client";
import { type ContractHome, type ContractHomeOptions, createContractHome } from "./omp-process";

/** The helpers a contract test uses to open its homes and children. */
export interface ContractSession {
	/** A fresh home with its own fake model server and refusing proxy. */
	home(options?: ContractHomeOptions): Promise<ContractHome>;
	/** An `omp acp` child for the home, connected over stdio. */
	child(home: ContractHome): Promise<AcpChild>;
}

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
		async child(home) {
			const child = await startAcpChild(home);
			children.push(child);
			return child;
		},
	};
}
