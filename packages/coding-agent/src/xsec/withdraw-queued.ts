/**
 * Lets an extension take back the custom messages it queued with `pi.sendMessage(..., { deliverAs: "steer" })`
 * before the model reads them. A message the agent loop already took out of the queue is no longer here and stays
 * (it counts as delivered), so 0 is a normal answer, not an error.
 */
import type { Agent, AgentMessage } from "@oh-my-pi/pi-agent-core";

/** Removes the queued custom messages of `customType` whose `details` satisfy `match`; returns how many. */
export function withdrawQueuedCustomMessages(
	agent: Agent,
	customType: string,
	match: (details: unknown) => boolean,
): number {
	const isTarget = (message: AgentMessage): boolean =>
		message.role === "custom" && message.customType === customType && match(message.details);
	const steering = agent.peekSteeringQueue();
	const followUp = agent.peekFollowUpQueue();
	const removed = steering.filter(isTarget).length + followUp.filter(isTarget).length;
	if (removed === 0) return 0;
	agent.replaceQueues(
		steering.filter(message => !isTarget(message)),
		followUp.filter(message => !isTarget(message)),
	);
	return removed;
}
