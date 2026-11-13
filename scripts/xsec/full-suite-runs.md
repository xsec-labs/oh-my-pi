# Full-suite run log

This file records each run of the full-suite gate on `xsec`. The rules for the known-failures list and for re-runs are in [the README](README.md#ci); each run is recorded here with both attempts.

## Not yet exercised

The `test` job's checkout runs with `persist-credentials: false` since PR #11 merged (f688cb2c). That job runs only on sync pull requests and manual dispatches, and as of this note no run has exercised it. If it fails at checkout or fetch, look here first.

## Run 43379659258 (2026-11-13)

`xsec` at ccfd81c6, native shards at concurrency 4. The run concluded success at 06:51:20Z.

- Attempt 1: `Test coding-agent native 3/3` (job 131734555532) failed on `bash-job-lifecycle` (unlisted), with relay-detach accepted. `Test coding-agent native 1/3` (job 131734555693) failed on `cli-responses-websocket-recovery` and `read-pdf-screenshot-chromium` (both unlisted). Native 2/3 (job 131734555540) passed, 37 of 37.
- Attempt 2, a re-run of the two failed jobs: native 3/3 (job 131738372386) passed through the wrapper, with relay-detach the only accepted failure. Native 1/3 (job 131738372505) passed, 38 of 38.

No test was added to `upstream-known-failures.txt`.
