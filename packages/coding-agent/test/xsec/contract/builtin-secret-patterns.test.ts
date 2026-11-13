import { describe, expect, it, setDefaultTimeout } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type ContractHome, createContractHome, rejectionOf, useContractSession, userMessageTexts } from "./harness";

setDefaultTimeout(120_000);

const contract = useContractSession();

/** Every built-in pattern name, as Desktop passes them in `secrets.disabledBuiltinPatterns` when its "secrets" category is off. */
const ALL_BUILTIN_PATTERNS = [
	"Credential",
	"AWSAccessKey",
	"GoogleAPIKey",
	"SlackToken",
	"NpmToken",
	"StripeKey",
	"StripeWebhookSecret",
	"HuggingFaceToken",
	"SendGridKey",
	"JWT",
	"BearerToken",
	"PrivateKey",
];

// Made-up values, each in the shape of one built-in pattern and of nothing real.
const JWT_HEADER = "eyJTZXN0SGVhZGVy";
const JWT_PAYLOAD = "eyJTZXN0UGF5bG9hZA";
const JWT_SIGNATURE = "SyntheticSignature0042";
const JWT = `${JWT_HEADER}.${JWT_PAYLOAD}.${JWT_SIGNATURE}`;
const AWS_KEY = "AKIASYNTHETICKEY0001";
/** One value per built-in shape, in `CREDENTIAL_PATTERNS` order. */
const SHAPES: readonly string[] = [
	"ghp_Sy7nthGhTok3nValue0000Zq8Rw2Lm4Kd6Pf0Ab",
	AWS_KEY,
	"AIzaSyNOTAREALKEY000000000000000000",
	"xoxb-syntheticslacktokenvalue",
	"npm_SyntheticNpmTokenValue0000000000",
	"sk_test_SyntheticStripeKey0000000",
	"whsec_SyntheticWebhookSecret000",
	"hf_SyntheticHuggingFaceToken0000000000",
	`SG.${"SyntheticSendGrid".padEnd(22, "0")}.${"SyntheticSendGridSecret".padEnd(43, "0")}`,
	JWT,
	"Bearer SyntheticBearerToken00001",
	"-----BEGIN PRIVATE KEY-----\nSyntheticPrivateKeyBody0001\n-----END PRIVATE KEY-----",
];

/** A regex rule that matches only the signature of a JWT: the lookbehind keeps the header and payload out of the match. */
const SIGNATURE_RULE_YML = [
	"- type: regex",
	"  content: '(?<=eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.)[A-Za-z0-9_-]{10,}'",
	"",
].join("\n");

/** A reversible placeholder, `$$[FRIENDLY_]HASH$$`. The format does not change in any package. */
const PLACEHOLDER_RE = /\$\$(?:[A-Z0-9]+_)?[A-Z0-9]{4,}(?::[ULCM])?\$\$/g;

function placeholdersIn(text: string): string[] {
	return text.match(PLACEHOLDER_RE) ?? [];
}

/** The user text of the request that carries `marker` (a plain word of the test's own), joined in order. */
function sentUserText(home: ContractHome, marker: string): string {
	const body = home.model.requests.find(request => userMessageTexts(request).some(text => text.includes(marker)));
	if (body === undefined) throw new Error(`no request carried the marker ${marker}`);
	return userMessageTexts(body).join("\n");
}

async function openSession(home: ContractHome) {
	const child = await contract.child(home);
	await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });
	const { sessionId } = await child.connection.newSession({ cwd: home.workspace, mcpServers: [] });
	return { child, sessionId };
}

describe("secrets.disabledBuiltinPatterns over ACP", () => {
	it("masks a synthetic JWT as one placeholder by default", async () => {
		const home = await contract.home({ masking: {} });
		const { child, sessionId } = await openSession(home);

		await child.connection.prompt({ sessionId, prompt: [{ type: "text", text: `jwt check ${JWT}` }] });

		const text = sentUserText(home, "jwt check");
		expect(text).not.toContain(JWT_HEADER);
		expect(text).not.toContain(JWT_SIGNATURE);
		const placeholders = placeholdersIn(text);
		expect(placeholders).toHaveLength(1);
		expect(placeholders[0]).toMatch(/^\$\$JWT_/);
	});

	it("with the JWT pattern off, a signature-only rule keeps the header and payload, and a tool gets the full token back", async () => {
		const home = await contract.home({
			masking: { disabledBuiltinPatterns: ["JWT"], secretsYml: SIGNATURE_RULE_YML },
		});
		const { child, sessionId } = await openSession(home);

		await child.connection.prompt({ sessionId, prompt: [{ type: "text", text: `signed check ${JWT}` }] });

		const text = sentUserText(home, "signed check");
		expect(text).toContain(`${JWT_HEADER}.${JWT_PAYLOAD}.`);
		expect(text).not.toContain(JWT_SIGNATURE);
		const placeholders = placeholdersIn(text);
		expect(placeholders).toHaveLength(1);

		// The model writes the token back with the placeholder in place of the signature.
		home.model.enqueue({
			content: [],
			toolCall: {
				name: "write",
				arguments: JSON.stringify({
					path: "token.txt",
					content: `${JWT_HEADER}.${JWT_PAYLOAD}.${placeholders[0]}`,
				}),
			},
		});
		await child.connection.prompt({ sessionId, prompt: [{ type: "text", text: "save the token" }] });

		expect(fs.readFileSync(path.join(home.workspace, "token.txt"), "utf8")).toBe(JWT);
		for (const body of home.model.requests) expect(JSON.stringify(body)).not.toContain(JWT_SIGNATURE);
	});

	it("with the JWT pattern off, an AWS-shaped key is still replaced", async () => {
		const home = await contract.home({ masking: { disabledBuiltinPatterns: ["JWT"] } });
		const { child, sessionId } = await openSession(home);

		await child.connection.prompt({ sessionId, prompt: [{ type: "text", text: `aws check ${AWS_KEY}` }] });

		const text = sentUserText(home, "aws check");
		expect(text).not.toContain(AWS_KEY);
		expect(placeholdersIn(text)).toHaveLength(1);
	});

	it("an unknown pattern name stops the session from starting, and the error names it", async () => {
		const home = await contract.home({ masking: { disabledBuiltinPatterns: ["NoSuchPattern"] } });
		const child = await contract.child(home);
		await child.connection.initialize({ protocolVersion: 1, clientCapabilities: {} });

		const error = await rejectionOf(child.connection.newSession({ cwd: home.workspace, mcpServers: [] }));

		expect(`${String(error)} ${JSON.stringify(error)}`).toContain("NoSuchPattern");
	});

	it("by default every built-in shape is replaced before it leaves", async () => {
		const home = await contract.home({ masking: {} });
		const { child, sessionId } = await openSession(home);

		await child.connection.prompt({
			sessionId,
			prompt: [{ type: "text", text: `shapes default\n${SHAPES.join("\n")}` }],
		});

		const text = sentUserText(home, "shapes default");
		for (const shape of SHAPES) expect(text).not.toContain(shape);
		expect(placeholdersIn(text).length).toBeGreaterThanOrEqual(SHAPES.length);
	});

	it("with every built-in pattern off, no built-in shape is replaced", async () => {
		const home = await contract.home({ masking: { disabledBuiltinPatterns: ALL_BUILTIN_PATTERNS } });
		const { child, sessionId } = await openSession(home);

		await child.connection.prompt({
			sessionId,
			prompt: [{ type: "text", text: `shapes off\n${SHAPES.join("\n")}` }],
		});

		const text = sentUserText(home, "shapes off");
		for (const shape of SHAPES) expect(text).toContain(shape);
		expect(placeholdersIn(text)).toHaveLength(0);
	});
});

describe("the contract harness", () => {
	it("refuses masking and secrets in one home, so one cannot silently drop the other's rules", async () => {
		await expect(createContractHome({ masking: {}, secrets: "[]\n" })).rejects.toThrow("not both");
	});
});
