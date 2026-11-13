import {
	type InitializeRequest,
	type InitializeResponse,
	type LoadSessionRequest,
	type LoadSessionResponse,
	ndJsonStream,
	type NewSessionRequest,
	type NewSessionResponse,
	type PromptRequest,
	type PromptResponse,
	RequestError,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	RpcConnection,
	type SessionNotification,
	type Stream,
} from "@oh-my-pi/pi-utils/acp";
import { isRecord } from "@oh-my-pi/pi-utils";
import { type ContractHome, FAKE_MODEL, FAKE_PROVIDER, ompCommand } from "./omp-process";

/**
 * A test client for an `omp acp` child, built on the raw JSON-RPC connection. The SDK's
 * `ClientSideConnection` has no way to send `_xsec/` extension methods, so the contract tests
 * use this instead. It records every `session/update` and declines every permission request.
 */
export class AcpClient {
	readonly #connection: RpcConnection;
	readonly #updates: SessionNotification[] = [];
	readonly #permissions: RequestPermissionRequest[] = [];

	constructor(stream: Stream) {
		this.#connection = new RpcConnection(stream, (method, params, notification) => {
			if (method === "session/update") {
				this.#updates.push(params as SessionNotification);
				return;
			}
			if (method === "session/request_permission" && !notification) {
				this.#permissions.push(params as RequestPermissionRequest);
				return { outcome: { outcome: "cancelled" } } satisfies RequestPermissionResponse;
			}
			throw RequestError.methodNotFound(method);
		});
	}

	/** Every `session/update` notification the agent has sent, in arrival order. */
	get updates(): readonly SessionNotification[] {
		return this.#updates;
	}

	/** Every `session/request_permission` the agent has sent, in arrival order. The test answers each one with "cancelled". */
	get permissions(): readonly RequestPermissionRequest[] {
		return this.#permissions;
	}

	initialize(params: InitializeRequest): Promise<InitializeResponse> {
		return this.#connection.request<InitializeResponse>("initialize", params);
	}

	newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
		return this.#connection.request<NewSessionResponse>("session/new", params);
	}

	loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
		return this.#connection.request<LoadSessionResponse>("session/load", params);
	}

	prompt(params: PromptRequest): Promise<PromptResponse> {
		return this.#connection.request<PromptResponse>("session/prompt", params);
	}

	/** ACP's cancellation path for a prompt. It is a notification, so this resolves once it is written. */
	cancel(params: { sessionId: string }): Promise<void> {
		return this.#connection.notify("session/cancel", params);
	}

	/** Sends an extension method, such as `_xsec/session/capabilities`, and resolves with its result. */
	extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
		return this.#connection.request<Record<string, unknown>>(method, params);
	}
}

/** An `omp acp` child process, connected to the test over its stdio. */
export interface AcpChild {
	/** The client the test drives the child with. */
	readonly connection: AcpClient;
	/** Everything the child has written to stderr so far, for a failure message. */
	stderr(): string;
	/** Kills the child and waits for it to exit. */
	close(): Promise<void>;
}

/** Extra arguments and environment for one `omp acp` child. */
export interface AcpChildOptions {
	/** Appended after `acp --config <file> --model <model>`, such as `--extension <path>`. */
	args?: string[];
	/** Added to the home's environment for this child only. */
	env?: Record<string, string>;
}

/** Starts `omp acp` for the home and connects to it. The child is not initialized yet. */
export async function startAcpChild(home: ContractHome, options: AcpChildOptions = {}): Promise<AcpChild> {
	const child = Bun.spawn({
		cmd: [
			...ompCommand(),
			"acp",
			"--config",
			home.configPath,
			"--model",
			`${FAKE_PROVIDER}/${FAKE_MODEL}`,
			...(options.args ?? []),
		],
		cwd: home.workspace,
		env: { ...home.env, ...options.env },
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});

	let stderrText = "";
	const decoder = new TextDecoder();
	const stderrDone = (async () => {
		for await (const chunk of child.stderr) stderrText += decoder.decode(chunk, { stream: true });
	})();

	const output = new WritableStream<Uint8Array>({
		async write(chunk) {
			await child.stdin.write(chunk);
			await child.stdin.flush();
		},
		close() {
			child.stdin.end();
		},
	});
	const connection = new AcpClient(ndJsonStream(output, child.stdout));

	return {
		connection,
		stderr: () => stderrText,
		async close() {
			child.kill();
			await child.exited;
			await stderrDone;
		},
	};
}

/** The text of every agent message chunk the client received, concatenated in order. */
export function agentMessageText(client: AcpClient): string {
	let text = "";
	for (const { update } of client.updates) {
		if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
			text += update.content.text;
		}
	}
	return text;
}

/** The text of each user message in a chat completions request body, in order. */
export function userMessageTexts(body: unknown): string[] {
	if (!isRecord(body) || !Array.isArray(body.messages)) return [];
	return body.messages.flatMap((message: unknown) => {
		if (!isRecord(message) || message.role !== "user") return [];
		if (typeof message.content === "string") return [message.content];
		if (!Array.isArray(message.content)) return [];
		return message.content.flatMap((part: unknown) =>
			isRecord(part) && typeof part.text === "string" ? [part.text] : [],
		);
	});
}

/** The content of each tool result message in a chat completions request body, in order. */
export function toolResultTexts(body: unknown): string[] {
	if (!isRecord(body) || !Array.isArray(body.messages)) return [];
	return body.messages.flatMap((message: unknown) => {
		if (!isRecord(message) || message.role !== "tool") return [];
		if (typeof message.content === "string") return [message.content];
		if (!Array.isArray(message.content)) return [];
		return message.content.flatMap((part: unknown) =>
			isRecord(part) && typeof part.text === "string" ? [part.text] : [],
		);
	});
}

/** The error a rejected request carries, so a test can check its code and message. */
export async function rejectionOf(request: Promise<unknown>): Promise<unknown> {
	try {
		await request;
	} catch (error) {
		return error;
	}
	throw new Error("expected the request to reject");
}
