/**
 * A stand-in approval extension for the contract tests. On load it registers with the test's bridge, then
 * asks the bridge before every tool call. It blocks the call when the bridge refuses it, and runs it with the
 * input the bridge gives when the bridge revises it. It is a fixture
 * written for this suite, not one of Desktop's extensions.
 *
 * It declares the two shapes it uses instead of importing OMP's types. A type import from OMP's source made
 * the child fail its next prompt with "Missing 'default' export" for the browser prelude, so the fixture
 * stays free of imports.
 */

interface ToolCallEvent {
	toolName: string;
	input: Record<string, unknown>;
}

interface ToolCallResult {
	block?: boolean;
	reason?: string;
	input?: Record<string, unknown>;
}

interface ExtensionApi {
	on(event: "tool_call", handler: (event: ToolCallEvent) => Promise<ToolCallResult | undefined>): void;
}

interface Decision {
	allow: boolean;
	reason?: string;
	input?: Record<string, unknown>;
}

async function post(base: string, pathname: string, body: unknown): Promise<Response> {
	return fetch(new URL(pathname, base), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

export default async function approvalGate(pi: ExtensionApi): Promise<void> {
	const bridge = process.env.XSEC_CONTRACT_BRIDGE_URL;
	if (!bridge) throw new Error("XSEC_CONTRACT_BRIDGE_URL is not set");
	await post(bridge, "/register", { extension: "approval-gate" });
	pi.on("tool_call", async event => {
		const response = await post(bridge, "/approve", { toolName: event.toolName, input: event.input });
		const decision = (await response.json()) as Decision;
		if (decision.allow) return decision.input === undefined ? undefined : { input: decision.input };
		return { block: true, reason: decision.reason ?? "refused by the approval gate" };
	});
}
