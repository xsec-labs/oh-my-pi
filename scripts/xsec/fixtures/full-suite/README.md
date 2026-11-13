# Full-suite fixtures

Output that upstream's test runner (`scripts/ci-test-ts.ts`, run through the `ci:test:*` scripts) writes to stdout. `scripts/xsec/run-full-suite.test.ts` judges these files, so each one must be what the runner printed, apart from the edits listed below.

| File | Source | Run |
| --- | --- | --- |
| `native-3-3-listed-only.txt` | GitHub Actions job 131711652635 of this fork (attempt 1) | `ci:test:coding-agent:native`, shard 3/3, concurrency 2 (the native matrix value at commit a1bf21ff). Only `browser-relay-detach` fails. |
| `native-3-3-listed-and-unlisted.txt` | job 131716675044 (rerun), same matrix entry | Also fails `browser-tab-worker-startup` (chunk 87/112), which is not on the list. |
| `native-1-3-pass.txt` | job 131716711940, `ci:test:coding-agent:native`, shard 1/3 | Passes (38 chunks). |
| `native-3-3-dry-run.txt` | `bun run ci:test:coding-agent:native --dry-run`, run locally with shard 3/3 | The plan of the shard, with the matrix's timeout of 120 s. |
| `native-1-3-dry-run.txt` | the same, shard 1/3 | The plan of that shard. |
| `native-1-4-watchdog-timeout.txt` | run locally with `OMP_TEST_CHUNK_TIMEOUT=1`, shard 1/4, concurrency 4 | Every chunk is killed by the watchdog (exit 137). |

Edits, all of them made on purpose:

- The three CI logs: GitHub's timestamp prefixes are removed. Under each failing test, the source frames and stack-trace lines are removed; the `✗` and `$` lines, the test name lines, the error line of each failing test, the progress lines and the summary are verbatim.
- The watchdog run: the process-tree and open-file diagnostics that the runner prints for each killed chunk are removed, because they list local processes and paths. The `[watchdog] chunk exceeded` line stays.
- The dry runs are verbatim.

The runner's output format does not depend on the concurrency, and a shard holds the same chunks at concurrency 2 and 4, so the logs and the local dry runs describe the same plan.
