import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { RequestError } from "@oh-my-pi/pi-utils/acp";
import type { AgentSession } from "../session/agent-session";

export * from "./acp-continue";

const SESSION_CAPABILITIES_METHOD = "_xsec/session/capabilities";

/** Resolves an ACP session id to its live session. Throws ACP's not-found error for an unknown id. */
type SessionLookup = (sessionId: string) => AgentSession;

/** Whether an extension method belongs to the fork's `_xsec/` namespace. */
export function isXsecExtMethod(method: string): boolean {
	return method.startsWith("_xsec/");
}

/**
 * Runs an `_xsec/` extension method. An unknown method throws the error upstream's
 * `extMethod` throws for an unknown method, so clients see the same failure either way.
 */
export function handleXsecExtMethod(
	method: string,
	params: { [key: string]: unknown },
	lookupSession: SessionLookup,
): { [key: string]: unknown } {
	switch (method) {
		case SESSION_CAPABILITIES_METHOD:
			return sessionCapabilities(params, lookupSession);
		default:
			throw new Error(`Unknown ACP ext method: ${method}`);
	}
}

/**
 * Lists the tools the session has enabled: `getEnabledToolNames()` filtered over
 * `getAllToolInfos()`. `inputSchema` is the wire JSON Schema of each tool's parameters.
 * `ToolInfo` in this release carries no output schema or annotations, so the entries omit them.
 */
function sessionCapabilities(
	params: { [key: string]: unknown },
	lookupSession: SessionLookup,
): { [key: string]: unknown } {
	// Extension requests reach the agent unvalidated, so params can be null or not an object.
	if (typeof params !== "object" || params === null) {
		throw RequestError.invalidParams({ method: SESSION_CAPABILITIES_METHOD }, "params must be an object");
	}
	const sessionId = params.sessionId;
	if (typeof sessionId !== "string" || sessionId.length === 0) {
		throw RequestError.invalidParams({ method: SESSION_CAPABILITIES_METHOD }, "sessionId must be a non-empty string");
	}
	const session = lookupSession(sessionId);
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
