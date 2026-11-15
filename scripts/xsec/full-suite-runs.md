# Full-suite run log

This file records each run of the full-suite gate on `xsec`. The rules for the known-failures list and for re-runs are in [the README](README.md#ci); each run is recorded here with both attempts.

## Not yet exercised

The `test` job's checkout runs with `persist-credentials: false` since PR #11 merged (f688cb2c). That job runs only on sync pull requests and manual dispatches, and as of this note no run has exercised it. If it fails at checkout or fetch, look here first.

## Run 43379659258 (2026-11-13)

`xsec` at ccfd81c6, native shards at concurrency 4. The run concluded success at 06:51:20Z.

- Attempt 1: `Test coding-agent native 3/3` (job 131734555532) failed on `bash-job-lifecycle` (unlisted), with relay-detach accepted. `Test coding-agent native 1/3` (job 131734555693) failed on `cli-responses-websocket-recovery` and `read-pdf-screenshot-chromium` (both unlisted). Native 2/3 (job 131734555540) passed, 37 of 37.
- Attempt 2, a re-run of the two failed jobs: native 3/3 (job 131738372386) passed through the wrapper, with relay-detach the only accepted failure. Native 1/3 (job 131738372505) passed, 38 of 38.

No test was added to `upstream-known-failures.txt`.

## Run 43720366167 (2026-11-15)

`xsec` at afae3b78 (run 120). `Test coding-agent native 2/3` failed in both attempts with the nine browser-webmcp tests, which the known-failures pull request lists in `upstream-known-failures.txt`. Attempt 2 re-ran only the two failed jobs; the other jobs passed on attempt 1.

- Attempt 1: `Test coding-agent native 2/3` (job 132830831924) failed on the nine tests, 38 test commands. `Test coding-agent native 1/3` (job 132830831940) failed on `browser-upload-contents.test.ts`, "keeps a tab's staged copies when it moves to a new worker, and removes them with the page" (unlisted), 39 test commands.
- Attempt 2 (started 13:56:25Z): `Test coding-agent native 1/3` (job 132834667520) passed, 39 test commands. `Test coding-agent native 2/3` (job 132834667328) failed on the same nine tests, 38 test commands. Both jobs ran on image ubuntu22/20261111.360.2.

`browser-upload-contents` failed once and passed on its re-run, so it is recorded as a one-off and is not listed. The nine tests also failed in the earlier full-suite runs that the entries comment cites (43374121307, 43561691327 and 43717414416, which ran on other branches).
