import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { RequestError } from "@oh-my-pi/pi-utils/acp";
import type { AgentSession } from "../session/agent-session";
import { type GoalControlRequest, controlGoal, isGoalControlAction, readGoal } from "./goal";

const SESSION_CAPABILITIES_METHOD = "_xsec/session/capabilities";
const SESSION_GOAL_GET_METHOD = "_xsec/session/goal/get";
const SESSION_GOAL_CONTROL_METHOD = "_xsec/session/goal/control";

/** Resolves an ACP session id to its live session. Throws ACP's not-found error for an unknown id. */
type SessionLookup = (sessionId: string) => AgentSession;

/** Extension request params and results are JSON objects. */
type ExtObject = { [key: string]: unknown };

/** Whether an extension method belongs to the fork's `_xsec/` namespace. */
export function isXsecExtMethod(method: string): boolean {
	return method.startsWith("_xsec/");
}

/**
 * Runs an `_xsec/` extension method. An unknown method throws the error upstream's
 * `extMethod` throws for an unknown method, so clients see the same failure either way.
 */
export async function handleXsecExtMethod(
	method: string,
	params: ExtObject,
	lookupSession: SessionLookup,
): Promise<ExtObject> {
	switch (method) {
		case SESSION_CAPABILITIES_METHOD:
			return sessionCapabilities(params, lookupSession);
		case SESSION_GOAL_GET_METHOD:
			return await sessionGoalGet(params, lookupSession);
		case SESSION_GOAL_CONTROL_METHOD:
			return await sessionGoalControl(params, lookupSession);
		default:
			throw new Error(`Unknown ACP ext method: ${method}`);
	}
}

/**
 * Reads the `sessionId` every `_xsec/session/*` method names. Extension requests reach the
 * agent unvalidated, so params can be null or not an object.
 */
function sessionIdParam(method: string, params: ExtObject): string {
	if (typeof params !== "object" || params === null) {
		throw RequestError.invalidParams({ method }, "params must be an object");
	}
	const sessionId = params.sessionId;
	if (typeof sessionId !== "string" || sessionId.length === 0) {
		throw RequestError.invalidParams({ method }, "sessionId must be a non-empty string");
	}
	return sessionId;
}

/**
 * Lists the tools the session has enabled: `getEnabledToolNames()` filtered over
 * `getAllToolInfos()`. `inputSchema` is the wire JSON Schema of each tool's parameters.
 * `ToolInfo` in this release carries no output schema or annotations, so the entries omit them.
 */
function sessionCapabilities(params: ExtObject, lookupSession: SessionLookup): ExtObject {
	const session = lookupSession(sessionIdParam(SESSION_CAPABILITIES_METHOD, params));
	const enabled = new Set(session.getEnabledToolNames());
	const tools = session
		.getAllToolInfos()
		.filter(tool => enabled.has(tool.name))
		.map(tool => ({
			name: tool.name,
			description: tool.description,
			inputSchema: toolWireSchema(tool),
			source: tool.sourceInfo.source,
		}));
	return { tools };
}

/** `{ goal }`: the session's goal as Desktop reads it, or null when the session has none. */
async function sessionGoalGet(params: ExtObject, lookupSession: SessionLookup): Promise<ExtObject> {
	const session = lookupSession(sessionIdParam(SESSION_GOAL_GET_METHOD, params));
	return { goal: await readGoal(session) };
}

/**
 * `{ goal }` after the action: `{ sessionId, action, objective? }` where `action` is one of
 * create, edit, pause, resume or drop. `objective` is required for create and edit and
 * refused for the other actions.
 */
async function sessionGoalControl(params: ExtObject, lookupSession: SessionLookup): Promise<ExtObject> {
	const sessionId = sessionIdParam(SESSION_GOAL_CONTROL_METHOD, params);
	const request = goalControlRequest(params);
	const session = lookupSession(sessionId);
	return { goal: await controlGoal(session, request) };
}

function goalControlRequest(params: ExtObject): GoalControlRequest {
	const { action, objective } = params;
	const method = SESSION_GOAL_CONTROL_METHOD;
	if (!isGoalControlAction(action)) {
		throw RequestError.invalidParams({ method }, "action must be one of create, edit, pause, resume, drop");
	}
	if (objective !== undefined && objective !== null && typeof objective !== "string") {
		throw RequestError.invalidParams({ method }, "objective must be a string when provided");
	}
	const text = typeof objective === "string" ? objective.trim() : "";
	if (action === "create" || action === "edit") {
		if (!text) throw RequestError.invalidParams({ method }, `${action} needs a non-empty objective`);
		return { action, objective: text };
	}
	if (text) throw RequestError.invalidParams({ method }, `${action} does not accept an objective`);
	return { action };
}
