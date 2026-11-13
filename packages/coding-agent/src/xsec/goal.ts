import type { GoalStatus } from "@oh-my-pi/pi-tui/tools/goal";
import { RequestError } from "@oh-my-pi/pi-utils/acp";
import { cfgGoalEnabled } from "../goals/settings";
import { type GoalModeState, goalFromModeData } from "../goals/state";
import type { AgentSession } from "../session/agent-session";

/** The tool goal mode turns on. It is active only while the session's goal is enabled. */
const GOAL_TOOL_NAME = "goal";

const GOAL_CONTROL_ACTIONS = ["create", "edit", "pause", "resume", "drop"] as const;

export type GoalControlAction = (typeof GOAL_CONTROL_ACTIONS)[number];

export function isGoalControlAction(value: unknown): value is GoalControlAction {
	return typeof value === "string" && (GOAL_CONTROL_ACTIONS as readonly string[]).includes(value);
}

/** The goal fields Desktop reads. `startedAt` is the goal's `createdAt`. */
export interface GoalSnapshot {
	objective: string;
	status: GoalStatus;
	startedAt: number;
}

/** A control request that has passed parameter validation. Objectives are trimmed. */
export type GoalControlRequest =
	| { action: "create" | "edit"; objective: string }
	| { action: "pause" | "resume" | "drop" };

/**
 * The session's goal, reconciled with its transcript first: the session keeps its goal
 * state across a transcript switch, so the state is rebuilt from the transcript now.
 * While the session is busy the in-memory state is returned unchanged, because a running
 * turn may still be writing to the transcript.
 */
export async function readGoal(session: AgentSession): Promise<GoalSnapshot | null> {
	if (session.isBusyForSnapshot) return snapshotOf(session.getGoalModeState());
	return snapshotOf(await reconcile(session));
}

/**
 * Runs one lifecycle action on the session's goal and returns the goal it leaves behind
 * (null after a drop). Refused while the session is busy, so the transcript does not
 * change under a running turn. An action that does not fit the goal's current state is an
 * invalid request, and the state is left as it was.
 */
export async function controlGoal(session: AgentSession, request: GoalControlRequest): Promise<GoalSnapshot | null> {
	const { action } = request;
	if (!cfgGoalEnabled.get(session.settings)) {
		throw RequestError.invalidRequest({ action }, "goal mode is disabled in OMP settings");
	}
	assertIdle(session, action);
	const state = await reconcile(session);
	// reconcile awaits (the tool set, the goal runtime's restore), so a submission can be admitted
	// in the meantime. Check again here; no await separates this check from the first mutation.
	assertIdle(session, action);
	switch (request.action) {
		case "create": {
			assertNotInPlanMode(session, action);
			const existing = state?.goal;
			if (existing && existing.status !== "complete" && existing.status !== "dropped") {
				throw RequestError.invalidRequest(
					{ action },
					"this session already has a goal; drop it before creating another",
				);
			}
			const created = await session.goalRuntime.createGoal({ objective: request.objective });
			await setGoalTool(session, created.enabled);
			return snapshotOf(created);
		}
		case "edit": {
			const status = state?.goal.status;
			if (status !== "active" && status !== "budget-limited") {
				throw RequestError.invalidRequest({ action }, "resume the goal before editing it");
			}
			const updated = await session.goalRuntime.replaceGoal({ objective: request.objective });
			await setGoalTool(session, updated.enabled);
			return snapshotOf(updated);
		}
		case "pause": {
			if (!state?.enabled) throw RequestError.invalidRequest({ action }, "no active goal to pause");
			const paused = await session.goalRuntime.pauseGoal();
			if (!paused?.goal) throw RequestError.internalError({ action }, "the goal pause was not persisted");
			await setGoalTool(session, false);
			return snapshotOf(paused);
		}
		case "resume": {
			assertNotInPlanMode(session, action);
			if (state?.goal.status !== "paused" || state.enabled) {
				throw RequestError.invalidRequest({ action }, "no paused goal to resume");
			}
			const resumed = await session.goalRuntime.resumeGoal();
			await setGoalTool(session, resumed.enabled);
			return snapshotOf(resumed);
		}
		case "drop": {
			if (!state) throw RequestError.invalidRequest({ action }, "no goal to drop");
			const dropped = await session.goalRuntime.dropGoal();
			if (!dropped) throw RequestError.internalError({ action }, "the goal drop was not persisted");
			await setGoalTool(session, false);
			return null;
		}
	}
}

/**
 * Rebuilds the session's goal state from its transcript, as the TUI does when it reattaches.
 * A transcript without a persisted goal clears the state. A paused goal is restored
 * disabled, and an active goal keeps running through the goal runtime's restore path.
 */
async function reconcile(session: AgentSession): Promise<GoalModeState | undefined> {
	const context = session.sessionManager.buildSessionContext();
	const persisted =
		cfgGoalEnabled.get(session.settings) && (context.mode === "goal" || context.mode === "goal_paused");
	if (!persisted) {
		session.goalRuntime.clearAccounting();
		session.setGoalModeState(undefined);
		await setGoalTool(session, false);
		return undefined;
	}
	const goal = goalFromModeData(context.modeData);
	if (!goal) throw RequestError.internalError(undefined, "the transcript's goal state is malformed");
	const enabled = context.mode === "goal" && (goal.status === "active" || goal.status === "budget-limited");
	const state: GoalModeState = { enabled, mode: "active", goal };
	session.setGoalModeState(state);
	if (!enabled) {
		session.goalRuntime.clearAccounting();
		await setGoalTool(session, false);
		return state;
	}
	const restored = await session.goalRuntime.onThreadResumed({ preserveActiveGoal: true });
	if (!restored?.goal)
		throw RequestError.internalError(undefined, "the goal could not be restored from the transcript");
	await setGoalTool(session, restored.enabled);
	return restored;
}

/** Adds or removes the goal tool, leaving the rest of the enabled set as it is. */
async function setGoalTool(session: AgentSession, enabled: boolean): Promise<void> {
	const names = session.getEnabledToolNames();
	if (names.includes(GOAL_TOOL_NAME) === enabled) return;
	const others = names.filter(name => name !== GOAL_TOOL_NAME);
	await session.setActiveToolsByName(enabled ? [...others, GOAL_TOOL_NAME] : others);
}

function assertIdle(session: AgentSession, action: GoalControlAction): void {
	if (!isIdle(session)) throw RequestError.sessionBusy(`cannot ${action} a goal while the session is busy`);
}

function isIdle(session: AgentSession): boolean {
	return (
		!session.isBusyForSnapshot &&
		!session.hasAdmittedSubmission &&
		session.queuedMessageCount === 0 &&
		!session.isSessionTransitioning
	);
}

function assertNotInPlanMode(session: AgentSession, action: GoalControlAction): void {
	if (session.getPlanModeState()?.enabled) {
		throw RequestError.invalidRequest({ action }, "exit plan mode before starting a goal");
	}
}

function snapshotOf(state: GoalModeState | undefined): GoalSnapshot | null {
	const goal = state?.goal;
	if (!goal) return null;
	return { objective: goal.objective, status: goal.status, startedAt: goal.createdAt };
}
