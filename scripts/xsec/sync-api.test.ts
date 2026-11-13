import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { GitHubApi, isMergeRefusal } from "./sync";

// The API client against a real HTTP server that answers every request with one canned status,
// so a refused request fails through the same path it takes during a run.

const PULL = "/repos/xsec-labs/oh-my-pi/pulls/1";

let answer: { status: number; body: unknown } = { status: 200, body: {} };
let server: Bun.Server<undefined> | undefined;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => Response.json(answer.body, { status: answer.status }),
	});
});

afterAll(() => {
	server?.stop(true);
});

function client(): GitHubApi {
	return new GitHubApi(`http://127.0.0.1:${server?.port}`, "read-token", "write-token");
}

/** The error a merge fails with when GitHub answers `status`. */
async function mergeError(status: number): Promise<unknown> {
	answer = { status, body: { message: "refused" } };
	try {
		await client().request("PUT", PULL, { body: { merge_method: "merge" } });
	} catch (error) {
		return error;
	}
	throw new Error(`GitHub answered ${status}, and the merge did not fail`);
}

describe("GitHub API client", () => {
	// Without the hint, a read refused for lack of permission fails with a bare HTTP status, and
	// nothing points at the job's permissions.
	it("names the workflow's own token when a read is refused", async () => {
		answer = { status: 403, body: { message: "Resource not accessible by integration" } };
		await expect(client().request("GET", PULL)).rejects.toThrow(
			"The workflow's own token may lack a read permission",
		);
	});

	// A 403 counted as a refusal would exit 0 and leave the sync silently undone. A 409 counted as a
	// fault would fail every run that races a push.
	it("treats a 405 or 409 merge as a refusal and every other failure as a fault", async () => {
		for (const status of [405, 409]) expect(isMergeRefusal(await mergeError(status))).toBe(true);
		for (const status of [401, 403, 404, 422, 500]) {
			expect(isMergeRefusal(await mergeError(status))).toBe(false);
		}
	});
});
