import { afterEach, describe, expect, it } from "bun:test";
import { redactSensitiveCredentials } from "@oh-my-pi/pi-ai/providers/transform-messages";
import { CREDENTIAL_PATTERNS } from "@oh-my-pi/pi-coding-agent/secrets/patterns";
import {
	credentialShapeRedaction,
	enabledBuiltinSecretEntries,
	setDisabledBuiltinSecretPatterns,
	setSecretsEnabledForRedaction,
} from "@oh-my-pi/pi-coding-agent/xsec/secret-builtin-patterns";

const GITHUB_TOKEN = "ghp_Sy7nthGhTok3nValue0000Zq8Rw2Lm4Kd6Pf0Ab";

afterEach(() => {
	setDisabledBuiltinSecretPatterns([]);
	setSecretsEnabledForRedaction(false);
});

describe("built-in secret pattern names", () => {
	// A sync that renames, removes or adds a built-in pattern changes this list. The setting's
	// names are then reviewed here, not discovered on a user's machine.
	it("are the names of CREDENTIAL_PATTERNS, in declaration order", () => {
		expect(CREDENTIAL_PATTERNS.map(pattern => pattern.name)).toEqual([
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
		]);
	});
});

describe("enabledBuiltinSecretEntries", () => {
	const builtins = [{ friendlyName: "JWT" }, { friendlyName: "AWSAccessKey" }];

	it("keeps every built-in entry while no pattern is disabled", () => {
		expect(enabledBuiltinSecretEntries(builtins)).toEqual(builtins);
	});

	it("drops the entries of the named patterns and keeps the others", () => {
		setDisabledBuiltinSecretPatterns(["JWT"]);

		expect(enabledBuiltinSecretEntries(builtins)).toEqual([{ friendlyName: "AWSAccessKey" }]);
	});

	it("throws naming the value when a name is not a built-in pattern, so building the obfuscator fails", () => {
		setDisabledBuiltinSecretPatterns(["JWTT"]);

		expect(() => enabledBuiltinSecretEntries(builtins)).toThrow("JWTT");
	});
});

describe("pi-ai's credential rewrite", () => {
	it("rewrites the Credential shapes while secrets.enabled is on", () => {
		setSecretsEnabledForRedaction(true);

		expect(redactSensitiveCredentials(GITHUB_TOKEN)).toBe("[github_token_redacted]");
	});

	it("leaves the Credential shapes alone when the Credential pattern is disabled, even with secrets.enabled on", () => {
		setDisabledBuiltinSecretPatterns(["Credential"]);
		setSecretsEnabledForRedaction(true);

		expect(credentialShapeRedaction(true)).toBe(false);
		expect(redactSensitiveCredentials(GITHUB_TOKEN)).toBe(GITHUB_TOKEN);
	});

	it("keeps rewriting the Credential shapes when only other patterns are disabled", () => {
		setDisabledBuiltinSecretPatterns(["JWT", "AWSAccessKey"]);
		setSecretsEnabledForRedaction(true);

		expect(redactSensitiveCredentials(GITHUB_TOKEN)).toBe("[github_token_redacted]");
	});
});

// With no pattern disabled and secrets.enabled off, each call site behaves as upstream did before the fork.
describe("default behaviour of the four upstream call sites", () => {
	it("builds the obfuscator from every built-in entry (secrets/index.ts)", () => {
		const entries = CREDENTIAL_PATTERNS.map(pattern => ({ friendlyName: pattern.name }));

		expect(enabledBuiltinSecretEntries(entries)).toEqual(entries);
	});

	it("passes the session's flag through unchanged (sdk.ts and agent-session.ts)", () => {
		expect(credentialShapeRedaction(true)).toBe(true);
		expect(credentialShapeRedaction(false)).toBe(false);
	});

	it("turns the process-wide rewrite on and off with secrets.enabled (secrets/settings.ts)", () => {
		expect(redactSensitiveCredentials(GITHUB_TOKEN)).toBe(GITHUB_TOKEN);

		setSecretsEnabledForRedaction(true);
		expect(redactSensitiveCredentials(GITHUB_TOKEN)).toBe("[github_token_redacted]");

		setSecretsEnabledForRedaction(false);
		expect(redactSensitiveCredentials(GITHUB_TOKEN)).toBe(GITHUB_TOKEN);
	});
});
