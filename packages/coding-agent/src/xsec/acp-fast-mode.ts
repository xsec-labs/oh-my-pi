/**
 * The ACP `fast` session option. It is offered only while the session's model can take the priority service tier,
 * each model choice reports through `_meta.fastMode` whether that model can take it, and a client sets it through
 * `setSessionConfigOption`. `acp-agent.ts` only calls these functions, so the rule lives in this module and the
 * upstream file keeps its call lines.
 */
import { type Model, serviceTierFamily, shouldSendServiceTier } from "@oh-my-pi/pi-ai";
import type { SessionConfigOption } from "@oh-my-pi/pi-utils/acp";
import type { AgentSession } from "../session/agent-session";

/** The id of the Fast config option. */
export const FAST_CONFIG_ID = "fast";
const FAST_OFF = "off";
const FAST_ON = "on";

/**
 * Family-level acceptance, the same rule `/fast` applies before it sends the priority tier. It says whether the
 * model's service-tier family takes the tier, not whether one request will be served fast: a provider may decline
 * the tier for a particular model, and that request then falls back to the standard tier.
 */
export function modelSupportsFastMode(model: Model): boolean {
	const family = serviceTierFamily(model);
	if (!family) return false;
	return family !== "openai" || shouldSendServiceTier("priority", model);
}

/** The `_meta` a model choice carries, so a client can mark the models that take Fast mode. */
export function fastModeMeta(model: Model): { fastMode: boolean } {
	return { fastMode: modelSupportsFastMode(model) };
}

/** The Fast option, offered only while the session's model can take the priority tier. */
export function buildFastConfigOption(session: AgentSession): SessionConfigOption | undefined {
	const model = session.model;
	if (!model || !modelSupportsFastMode(model)) return undefined;
	return {
		id: FAST_CONFIG_ID,
		name: "Fast",
		type: "select",
		currentValue: session.isFastModeEnabled() ? FAST_ON : FAST_OFF,
		options: [
			{ value: FAST_OFF, name: "Off" },
			{ value: FAST_ON, name: "On", description: "Priority service tier: faster responses, higher cost" },
		],
	};
}

/** Applies a `fast` value. "off" clears the priority tier; "on" sets it, and fails on a model that cannot take it. */
export function setFastModeOption(session: AgentSession, value: string): void {
	if (value === FAST_OFF) {
		if (session.isFastModeEnabled()) session.setFastMode(false);
		return;
	}
	if (value !== FAST_ON) {
		throw new Error(`Unknown ACP fast mode: ${value}`);
	}
	if (!session.setFastMode(true)) {
		throw new Error("Fast mode is unavailable for the current model.");
	}
}
