/**
 * A local HTTP endpoint that a stand-in extension in the child calls. It records each registration and
 * each approval request, and answers an approval with the decision the test has chosen.
 */

/** The answer to one approval request: `allow` runs the tool call, otherwise `reason` goes to the model. */
export interface ApprovalDecision {
	allow: boolean;
	reason?: string;
}

export interface ExtensionBridge {
	/** The base URL the child reads from `XSEC_CONTRACT_BRIDGE_URL`. */
	readonly url: string;
	/** The body of every `/register` call, in arrival order. */
	readonly registrations: unknown[];
	/** The body of every `/approve` call, in arrival order. */
	readonly approvals: unknown[];
	/** Chooses the answer to each approval request. Until a test sets it, every call is allowed. */
	decide: (request: unknown) => ApprovalDecision;
	stop(): void;
}

export function startExtensionBridge(): ExtensionBridge {
	const registrations: unknown[] = [];
	const approvals: unknown[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const { pathname } = new URL(request.url);
			if (request.method !== "POST") return new Response("not found", { status: 404 });
			const body: unknown = await request.json();
			if (pathname === "/register") {
				registrations.push(body);
				return Response.json({ ok: true });
			}
			if (pathname === "/approve") {
				approvals.push(body);
				return Response.json(bridge.decide(body));
			}
			return new Response("not found", { status: 404 });
		},
	});
	const bridge: ExtensionBridge = {
		url: `http://127.0.0.1:${server.port}`,
		registrations,
		approvals,
		decide: () => ({ allow: true }),
		stop: () => server.stop(true),
	};
	return bridge;
}
