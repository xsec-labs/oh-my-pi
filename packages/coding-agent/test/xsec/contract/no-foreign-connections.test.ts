import { describe, expect, it, setDefaultTimeout } from "bun:test";
import {
	type AcpChild,
	type ContractHome,
	type DiscoveryPortWatch,
	logLines,
	useContractSession,
	watchDiscoveryPorts,
} from "./harness";

setDefaultTimeout(120_000);

const contract = useContractSession();

/**
 * Sub-agent runs in one batch. The pool places a run on a worker only once nine runs are in flight
 * (`SUBAGENT_WORKER_THRESHOLD` in `src/thread/subagent-worker.ts`), so the batch has exactly that many.
 */
const SUBAGENT_RUNS = 9;

/** Text every sub-agent's task carries. The fake model holds each sub-agent's request on it. */
const SUBAGENT_MARKER = "answer run";

/** The task tool call that starts the batch: one item per run. */
function subagentBatchArguments(): string {
	const tasks = Array.from({ length: SUBAGENT_RUNS }, (_, index) => ({
		name: `run-${index + 1}`,
		task: `${SUBAGENT_MARKER} ${index + 1}`,
		solutionSpace: "one short sentence",
	}));
	return JSON.stringify({ context: "contract test: each run answers in one sentence", tasks });
}

/** A child for the home, initialized, with one session open. Opening it is the session start the test measures. */
async function openSession(home: ContractHome): Promise<{ child: AcpChild; sessionId: string }> {
	const child = await contract.child(home);
	await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
	const { sessionId } = await child.connection.newSession({ cwd: home.workspace, mcpServers: [] });
	return { child, sessionId };
}

/** One prompt turn, which must end normally. */
async function promptTurn(child: AcpChild, sessionId: string, text: string): Promise<void> {
	const response = await child.connection.prompt({ sessionId, prompt: [{ type: "text", text }] });
	expect(response.stopReason).toBe("end_turn");
}

/**
 * A prompt turn, a tool call and a batch of sub-agent runs. The batch runs in the background, so its turn ends
 * before the runs send anything. The fake model holds every sub-agent request open, which keeps each run in
 * flight until the test closes its child. When the ninth run is placed, all nine are in flight.
 */
async function runEveryKindOfWork(home: ContractHome, child: AcpChild, sessionId: string): Promise<void> {
	home.model.enqueue({ content: ["hello from the fake model"] });
	await promptTurn(child, sessionId, "say hi");

	home.model.enqueue({
		content: [],
		toolCall: { name: "write", arguments: JSON.stringify({ path: "written.txt", content: "written by the model" }) },
	});
	home.model.enqueue({ content: ["the file is written"] });
	await promptTurn(child, sessionId, "write written.txt");

	home.model.route(SUBAGENT_MARKER, { content: [], hold: true });
	home.model.enqueue({ content: [], toolCall: { name: "task", arguments: subagentBatchArguments() } });
	home.model.enqueue({ content: ["the sub-agent runs are started"] });
	await promptTurn(child, sessionId, "run the sub-agents");
	await home.model.waitForUserText(SUBAGENT_MARKER, SUBAGENT_RUNS);
}

/**
 * A port another process holds is never watched, so a probe to it would go unseen. On CI (where `CI` is set) the
 * test fails and names the port. Elsewhere the notice that `watchDiscoveryPorts` prints is the record.
 */
function expectEveryDiscoveryPortWatched(watch: DiscoveryPortWatch): void {
	if (process.env.CI) expect(watch.skipped).toEqual([]);
}

describe("no foreign connections in configured mode", () => {
	it("a session start, a prompt turn, a tool call and an in-thread sub-agent batch contact nothing outside the machine", async () => {
		const home = await contract.home({ discovery: "configured", workerThreads: 0 });
		const watch = watchDiscoveryPorts();
		try {
			expectEveryDiscoveryPortWatched(watch);
			const { child, sessionId } = await openSession(home);
			await runEveryKindOfWork(home, child, sessionId);

			// With no worker threads the batch never boots one, so every run is in the main thread.
			expect(logLines(home.base).some(line => line.includes("Subagent worker booted"))).toBe(false);
			expect(home.proxy.seen).toEqual([]);
			expect(watch.hits).toEqual([]);
		} finally {
			watch.stop();
		}
	});

	it("the same work with the ninth sub-agent run placed on a pooled worker contacts nothing outside the machine", async () => {
		const home = await contract.home({ discovery: "configured", workerThreads: 1 });
		const watch = watchDiscoveryPorts();
		try {
			expectEveryDiscoveryPortWatched(watch);
			const { child, sessionId } = await openSession(home);
			await runEveryKindOfWork(home, child, sessionId);

			// The worker boots for the ninth run. The log line proves that run was placed on it.
			expect(logLines(home.base).some(line => line.includes("Subagent worker booted"))).toBe(true);
			expect(home.proxy.seen).toEqual([]);
			expect(watch.hits).toEqual([]);
		} finally {
			watch.stop();
		}
	});

	it("control: the same session start with models.discovery all reaches the refusing proxy or a discovery port", async () => {
		const home = await contract.home({ discovery: "all" });
		const watch = watchDiscoveryPorts();
		try {
			expectEveryDiscoveryPortWatched(watch);
			await openSession(home);

			console.log(`control recorded: ${[...home.proxy.seen, ...watch.hits].join("; ")}`);
			expect(home.proxy.seen.length + watch.hits.length).toBeGreaterThan(0);
		} finally {
			watch.stop();
		}
	});
});
