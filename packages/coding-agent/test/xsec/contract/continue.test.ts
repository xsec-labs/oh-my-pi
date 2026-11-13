import { describe, expect, setDefaultTimeout } from "bun:test";
import {
	agentMessageText,
	type AcpChild,
	type ContractHome,
	rejectionOf,
	useContractSession,
	userMessageTexts,
} from "./harness";

setDefaultTimeout(120_000);

const contract = useContractSession();
const { it } = contract;
const CONTINUE = { xsec: { continue: true } };

async function openSession(child: AcpChild, home: ContractHome): Promise<string> {
	const { sessionId } = await child.connection.newSession({ cwd: home.workspace, mcpServers: [] });
	return sessionId;
}

describe("session/prompt with _meta.xsec.continue", () => {
	it("resumes a cancelled turn without sending the request text", async () => {
		const home = await contract.home();
		const child = await contract.child(home);
		await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const sessionId = await openSession(child, home);

		// Leave an unfinished turn: the model holds its answer until the turn is cancelled.
		home.model.enqueue({ content: [], hold: true });
		const interrupted = child.connection.prompt({ sessionId, prompt: [{ type: "text", text: "write the parser" }] });
		await home.model.waitForRequests(1);
		await child.connection.cancel({ sessionId });
		expect((await interrupted).stopReason).toBe("cancelled");

		home.model.enqueue({ content: ["picked up where it stopped"] });
		const resumed = await child.connection.prompt({
			sessionId,
			prompt: [{ type: "text", text: "not sent" }],
			_meta: CONTINUE,
		});

		expect(resumed.stopReason).toBe("end_turn");
		const sent = userMessageTexts(home.model.requests.at(-1));
		expect(sent).toContain("write the parser");
		expect(sent).not.toContain("not sent");
		expect(agentMessageText(child.connection)).toContain("picked up where it stopped");
	});

	it("rejects a continue on a session with nothing to resume, without calling the model", async () => {
		const home = await contract.home();
		const child = await contract.child(home);
		await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const sessionId = await openSession(child, home);

		const error = await rejectionOf(
			child.connection.prompt({ sessionId, prompt: [{ type: "text", text: "not sent" }], _meta: CONTINUE }),
		);

		expect(JSON.stringify(error)).toContain("Nothing to resume");
		expect(home.model.requests).toHaveLength(0);
	});

	it("sends the request text as an ordinary prompt when the flag is absent or not the boolean true", async () => {
		const home = await contract.home();
		const child = await contract.child(home);
		await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });

		for (const meta of [undefined, { xsec: { continue: false } }, { xsec: { continue: "true" } }]) {
			const sessionId = await openSession(child, home);
			home.model.enqueue({ content: ["done"] });

			const response = await child.connection.prompt({
				sessionId,
				prompt: [{ type: "text", text: "ordinary text" }],
				_meta: meta,
			});

			expect(response.stopReason).toBe("end_turn");
			expect(userMessageTexts(home.model.requests.at(-1))).toContain("ordinary text");
		}
	});
});
