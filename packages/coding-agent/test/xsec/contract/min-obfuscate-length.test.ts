import { describe, expect, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type AcpClient, type ContractHome, rejectionOf, useContractSession, userMessageTexts } from "./harness";

setDefaultTimeout(120_000);

const contract = useContractSession();
const { it } = contract;

// Made-up values, each read against `secrets.minObfuscateLength` in UTF-16 units. The emoji is two units and one code point.
const SIX = "Vx7Qp2";
const FIVE = "ZK123";
const THREE = "K9q";
const EMOJI = "a😀b";

const SECRETS_YML = JSON.stringify([
	{ type: "plain", content: SIX, mode: "obfuscate", friendlyName: "ALPHA" },
	{ type: "regex", content: "ZK[0-9]{3}", mode: "obfuscate", friendlyName: "GAMMA" },
	{ type: "plain", content: THREE, mode: "obfuscate", friendlyName: "BETA" },
	{ type: "plain", content: EMOJI, mode: "obfuscate", friendlyName: "DELTA" },
]);

/**
 * One- and two-unit values, a longer value that contains the two-unit one, and one-unit values for the letters and
 * digits a placeholder's hash is made of (not the ones in the friendly names or the values above), so they occur
 * inside placeholders for certain.
 */
const PLACEHOLDER_CHARACTERS = "ABCDFHIJKMPRUXYZ012345689";
const SHORT_SECRETS_YML = JSON.stringify([
	{ type: "plain", content: "Q", mode: "obfuscate", friendlyName: "ONE" },
	{ type: "plain", content: "7", mode: "obfuscate", friendlyName: "SEVEN" },
	{ type: "plain", content: "xy", mode: "obfuscate", friendlyName: "TWO" },
	{ type: "plain", content: "xyz-Synthetic-Value", mode: "obfuscate", friendlyName: "LONG" },
	...Array.from(PLACEHOLDER_CHARACTERS, content => ({ type: "plain", content, mode: "obfuscate" })),
]);

/** A reversible placeholder, `$$[FRIENDLY_]HASH$$`. The format does not change in any package. */
const PLACEHOLDER_RE = /\$\$(?:[A-Z0-9]+_)?[A-Z0-9]{4,}(?::[ULCM])?\$\$/g;

function placeholdersIn(text: string): string[] {
	return text.match(PLACEHOLDER_RE) ?? [];
}

/** The user text of the first request, placeholders included: what the provider receives from the user. */
function firstUserText(home: ContractHome): string {
	return userMessageTexts(home.model.requests[0]).join("\n");
}

/** The placeholder of the value with this friendly name, read from the first request. */
function placeholderNamed(home: ContractHome, name: string): string {
	const match = new RegExp(`\\$\\$${name}_[A-Z0-9]+(?::[ULCM])?\\$\\$`).exec(JSON.stringify(home.model.requests[0]));
	if (!match) throw new Error(`the first request carries no placeholder named ${name}`);
	return match[0];
}

/** The text of every agent message chunk the client received from update index `from` onward, concatenated. */
function messageText(client: AcpClient, from: number): string {
	let text = "";
	for (const { update } of client.updates.slice(from)) {
		if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") text += update.content.text;
	}
	return text;
}

async function openSession(home: ContractHome) {
	const child = await contract.child(home);
	await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
	const { sessionId } = await child.connection.newSession({ cwd: home.workspace, mcpServers: [] });
	return { child, sessionId };
}

describe("secrets.minObfuscateLength over ACP", () => {
	it("by default, a 6-unit plain entry, a 5-unit regex match, a 3-unit entry and a 4-unit value with an emoji reach the model as written", async () => {
		const home = await contract.home({ masking: { secretsYml: SECRETS_YML } });
		const { child, sessionId } = await openSession(home);

		await child.connection.prompt({
			sessionId,
			prompt: [{ type: "text", text: `minimum check ${SIX} ${FIVE} ${THREE} ${EMOJI} done` }],
		});

		expect(firstUserText(home)).toContain(`${SIX} ${FIVE} ${THREE} ${EMOJI}`);
		expect(placeholdersIn(firstUserText(home))).toHaveLength(0);
	});

	it("with a minimum of 4, the 6-unit entry, the 5-unit regex match and the 4-unit emoji value are replaced and restored for a tool, and the 3-unit entry is not", async () => {
		const home = await contract.home({ masking: { minObfuscateLength: 4, secretsYml: SECRETS_YML } });
		const { child, sessionId } = await openSession(home);

		await child.connection.prompt({
			sessionId,
			prompt: [{ type: "text", text: `minimum check ${SIX} ${FIVE} ${THREE} ${EMOJI} done` }],
		});

		const text = firstUserText(home);
		for (const value of [SIX, FIVE, EMOJI]) expect(text).not.toContain(value);
		expect(text).toContain(THREE);
		expect(placeholdersIn(text)).toHaveLength(3);

		// The model writes the values back with their placeholders; the tool gets the real values.
		const six = placeholderNamed(home, "ALPHA");
		const five = placeholderNamed(home, "GAMMA");
		const emoji = placeholderNamed(home, "DELTA");
		home.model.enqueue({
			content: [],
			toolCall: {
				name: "write",
				arguments: JSON.stringify({ path: "values.txt", content: `${six} ${five} ${THREE} ${emoji}` }),
			},
		});
		await child.connection.prompt({ sessionId, prompt: [{ type: "text", text: "save the values" }] });

		expect(fs.readFileSync(path.join(home.workspace, "values.txt"), "utf8")).toBe(`${SIX} ${FIVE} ${THREE} ${EMOJI}`);
	});

	it("with a minimum of 1, one- and two-unit values round-trip exactly for a tool and for display, also inside a longer value", async () => {
		const home = await contract.home({ masking: { minObfuscateLength: 1, secretsYml: SHORT_SECRETS_YML } });
		const { child, sessionId } = await openSession(home);

		await child.connection.prompt({
			sessionId,
			prompt: [{ type: "text", text: "short values Q 7 xy and xyz-Synthetic-Value end" }],
		});

		// Outside the placeholders, the short values and the longer one are gone from what the provider receives.
		const outside = firstUserText(home).replace(PLACEHOLDER_RE, "");
		for (const value of ["Q", "7", "xy", "Synthetic"]) expect(outside).not.toContain(value);

		const one = placeholderNamed(home, "ONE");
		const seven = placeholderNamed(home, "SEVEN");
		const two = placeholderNamed(home, "TWO");
		const long = placeholderNamed(home, "LONG");
		// The coverage this test claims: the hashes of these placeholders hold characters of the one-unit values.
		const hashes = [one, seven, two, long].map(placeholder =>
			placeholder.replace(/^\$\$[A-Z]+_|(?::[ULCM])?\$\$$/g, ""),
		);
		expect(Array.from(PLACEHOLDER_CHARACTERS).some(char => hashes.join("").includes(char))).toBe(true);
		const reply = `reply: ${one} / ${seven} / ${two} / ${long} / ${one}${two}.`;

		// The reply streams one character at a time, so every placeholder is cut at every point.
		const from = child.connection.updates.length;
		home.model.enqueue({ content: Array.from(reply) });
		await child.connection.prompt({ sessionId, prompt: [{ type: "text", text: "repeat the values" }] });
		expect(messageText(child.connection, from)).toBe("reply: Q / 7 / xy / xyz-Synthetic-Value / Qxy.");

		// The next request carries the reply as the model wrote it, placeholders intact.
		home.model.enqueue({ content: ["ok"] });
		await child.connection.prompt({ sessionId, prompt: [{ type: "text", text: "and once more" }] });
		expect(JSON.stringify(home.model.requests.at(-1))).toContain(reply);

		home.model.enqueue({
			content: [],
			toolCall: {
				name: "write",
				arguments: JSON.stringify({ path: "short.txt", content: `${one}-${seven}-${two}-${long}` }),
			},
		});
		await child.connection.prompt({ sessionId, prompt: [{ type: "text", text: "save them" }] });
		expect(fs.readFileSync(path.join(home.workspace, "short.txt"), "utf8")).toBe("Q-7-xy-xyz-Synthetic-Value");
	});

	for (const minObfuscateLength of [0, 2.5]) {
		it(`a minimum of ${minObfuscateLength} stops the session from starting, and the error names the setting`, async () => {
			const home = await contract.home({ masking: { minObfuscateLength } });
			const child = await contract.child(home);
			await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });

			const error = await rejectionOf(child.connection.newSession({ cwd: home.workspace, mcpServers: [] }));

			expect(`${String(error)} ${JSON.stringify(error)}`).toContain("secrets.minObfuscateLength");
		});
	}
});
