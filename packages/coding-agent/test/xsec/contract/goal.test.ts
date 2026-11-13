import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { rejectionOf, useContractSession } from "./harness";

setDefaultTimeout(120_000);

const contract = useContractSession();
const GOAL_GET = "_xsec/session/goal/get";
const GOAL_CONTROL = "_xsec/session/goal/control";
const INVALID_REQUEST_CODE = -32600;
const INVALID_PARAMS_CODE = -32602;
const SESSION_BUSY_CODE = -32003;

describe("_xsec/session/goal/get and _xsec/session/goal/control", () => {
	it("creates, pauses, resumes, edits and drops the goal, and accepts a new goal after the drop", async () => {
		const home = await contract.home();
		const child = await contract.child(home);
		await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const { sessionId } = await child.connection.newSession({ cwd: home.workspace, mcpServers: [] });

		expect(await child.connection.extMethod(GOAL_GET, { sessionId })).toEqual({ goal: null });

		// The goal carries exactly the fields Desktop reads: objective, status and startedAt.
		const created = await child.connection.extMethod(GOAL_CONTROL, {
			sessionId,
			action: "create",
			objective: "ship the parser",
		});
		expect(created).toEqual({
			goal: { objective: "ship the parser", status: "active", startedAt: expect.any(Number) },
		});
		expect(await child.connection.extMethod(GOAL_GET, { sessionId })).toEqual(created);

		expect(await child.connection.extMethod(GOAL_CONTROL, { sessionId, action: "pause" })).toMatchObject({
			goal: { objective: "ship the parser", status: "paused" },
		});
		expect(await child.connection.extMethod(GOAL_CONTROL, { sessionId, action: "resume" })).toMatchObject({
			goal: { status: "active" },
		});
		expect(
			await child.connection.extMethod(GOAL_CONTROL, { sessionId, action: "edit", objective: "ship the lexer" }),
		).toMatchObject({ goal: { objective: "ship the lexer", status: "active" } });

		expect(await child.connection.extMethod(GOAL_CONTROL, { sessionId, action: "drop" })).toEqual({ goal: null });
		expect(await child.connection.extMethod(GOAL_GET, { sessionId })).toEqual({ goal: null });

		// A dropped goal no longer blocks a new one.
		expect(
			await child.connection.extMethod(GOAL_CONTROL, { sessionId, action: "create", objective: "ship the emitter" }),
		).toMatchObject({ goal: { objective: "ship the emitter", status: "active" } });
	});

	it("refuses an action that does not fit the goal's state, and leaves the goal as it was", async () => {
		const home = await contract.home();
		const child = await contract.child(home);
		await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const { sessionId } = await child.connection.newSession({ cwd: home.workspace, mcpServers: [] });

		const withoutGoal = [
			{ action: "pause" },
			{ action: "resume" },
			{ action: "drop" },
			{ action: "edit", objective: "no goal yet" },
		];
		for (const params of withoutGoal) {
			const error = await rejectionOf(child.connection.extMethod(GOAL_CONTROL, { sessionId, ...params }));
			expect(error).toMatchObject({ code: INVALID_REQUEST_CODE });
		}

		await child.connection.extMethod(GOAL_CONTROL, { sessionId, action: "create", objective: "first" });
		const second = await rejectionOf(
			child.connection.extMethod(GOAL_CONTROL, { sessionId, action: "create", objective: "second" }),
		);
		expect(second).toMatchObject({ code: INVALID_REQUEST_CODE });
		const activeResume = await rejectionOf(child.connection.extMethod(GOAL_CONTROL, { sessionId, action: "resume" }));
		expect(activeResume).toMatchObject({ code: INVALID_REQUEST_CODE });

		await child.connection.extMethod(GOAL_CONTROL, { sessionId, action: "pause" });
		const pausedEdit = await rejectionOf(
			child.connection.extMethod(GOAL_CONTROL, { sessionId, action: "edit", objective: "while paused" }),
		);
		expect(pausedEdit).toMatchObject({ code: INVALID_REQUEST_CODE });
		const pausedPause = await rejectionOf(child.connection.extMethod(GOAL_CONTROL, { sessionId, action: "pause" }));
		expect(pausedPause).toMatchObject({ code: INVALID_REQUEST_CODE });

		expect(await child.connection.extMethod(GOAL_GET, { sessionId })).toMatchObject({
			goal: { objective: "first", status: "paused" },
		});
	});

	it("rejects a malformed control request as invalid params, and creates nothing", async () => {
		const home = await contract.home();
		const child = await contract.child(home);
		await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const { sessionId } = await child.connection.newSession({ cwd: home.workspace, mcpServers: [] });

		const malformed = [
			{ action: "explode" },
			{ action: "create" },
			{ action: "create", objective: "   " },
			{ action: "edit", objective: 42 },
			{ action: "pause", objective: "not accepted" },
		];
		for (const params of malformed) {
			const error = await rejectionOf(child.connection.extMethod(GOAL_CONTROL, { sessionId, ...params }));
			expect(error).toMatchObject({ code: INVALID_PARAMS_CODE });
		}
		expect(await rejectionOf(child.connection.extMethod(GOAL_GET, {}))).toMatchObject({
			code: INVALID_PARAMS_CODE,
		});

		expect(await child.connection.extMethod(GOAL_GET, { sessionId })).toEqual({ goal: null });
	});

	it("refuses control while a turn is running, and accepts it once the turn has ended", async () => {
		const home = await contract.home();
		const child = await contract.child(home);
		await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const { sessionId } = await child.connection.newSession({ cwd: home.workspace, mcpServers: [] });

		// The model holds its answer, so the turn is still running when the control request arrives.
		home.model.enqueue({ content: [], hold: true });
		const running = child.connection.prompt({ sessionId, prompt: [{ type: "text", text: "work" }] });
		await home.model.waitForRequests(1);

		const busy = await rejectionOf(
			child.connection.extMethod(GOAL_CONTROL, { sessionId, action: "create", objective: "during a turn" }),
		);
		expect(busy).toMatchObject({ code: SESSION_BUSY_CODE });
		expect(await child.connection.extMethod(GOAL_GET, { sessionId })).toEqual({ goal: null });

		await child.connection.cancel({ sessionId });
		expect((await running).stopReason).toBe("cancelled");
		expect(
			await child.connection.extMethod(GOAL_CONTROL, { sessionId, action: "create", objective: "after the turn" }),
		).toMatchObject({ goal: { objective: "after the turn", status: "active" } });
	});

	it("refuses to start a goal when goal mode is off in the settings, and reads no goal", async () => {
		const home = await contract.home({ goalEnabled: false });
		const child = await contract.child(home);
		await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
		const { sessionId } = await child.connection.newSession({ cwd: home.workspace, mcpServers: [] });

		const error = await rejectionOf(
			child.connection.extMethod(GOAL_CONTROL, { sessionId, action: "create", objective: "blocked" }),
		);

		expect(error).toMatchObject({ code: INVALID_REQUEST_CODE });
		expect(String(error)).toContain("goal mode is disabled in OMP settings");
		expect(await child.connection.extMethod(GOAL_GET, { sessionId })).toEqual({ goal: null });
	});
});
