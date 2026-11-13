# xsec fork

This repository is XSec's fork of [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi). XSec Desktop ships the single-file `omp` binary built from the `xsec` branch. The fork exists so the few changes Desktop needs live in source instead of being patched into an installed copy.

The repository is public. Never commit keys, account details or customer data: a commit pushed to a fork stays readable by its hash even after its branch is deleted.

## Branches and tags

| Ref                    | Content                                         | Rule                                                     |
| ---------------------- | ----------------------------------------------- | -------------------------------------------------------- |
| `main`                 | Mirror of upstream `main`                       | Fast-forwarded by the sync job only                      |
| `xsec` (default)       | An upstream release tag plus the fork's commits | Pull requests only; upstream is merged in, never rebased |
| `v<upstream>-xsec.<n>` | A fork release                                  | `<n>` counts fork releases on one upstream version       |

Open pull requests against `xsec` in this repository. GitHub preselects upstream as the base of a pull request from a fork, so name the base explicitly.

## Where fork code goes

Fork code lives under prefixes upstream does not use, so merging upstream never conflicts on it:

- `packages/coding-agent/src/xsec/` for implementation
- `packages/coding-agent/test/xsec/` for tests
- `scripts/xsec/` for CI scripts
- `.github/workflows/xsec-*.yml` for workflows

An upstream file may only gain the lines that call into `src/xsec/`. Each such file is listed in `upstream-allowlist.txt` with a line budget and the upstream test paths that cover it. `check-upstream-diff.ts` fails a pull request that changes any other upstream file, goes over a budget, or lists a test path that matches no `*.test.ts` file.

Do not change these, listed or not; `check-upstream-diff.ts` fails on each of them:

- package versions (the `version` field of a `package.json`). Upstream rewrites them on every release, and a compiled binary only embeds a native addon whose version stamp equals the package version.
- `CHANGELOG.md` files. Upstream rewrites them on every release. Describe fork changes in the pull request and the fork release notes.
- upstream's workflow files. They are disabled under Actions in the repository settings, because they need upstream's runners and publishing secrets. `check-workflows.ts` also fails when one is enabled.

Upstream's development rules in [AGENTS.md](../../AGENTS.md) apply to fork code too.

## CI

`.github/workflows/xsec-ci.yml` runs on pull requests to `xsec`, and on pushes to `xsec`, in two modes.

Every run:

- **Fork scope**: `check-upstream-diff.ts`, `check-workflows.ts` and the tests of `scripts/xsec`.
- **Lint, type check & web build**: upstream's `ci:check:full` and `collab:web:build`.
- **Fork and related tests**: every test under `packages/coding-agent/test/xsec/`, upstream's CLI smoke entry (`ci:test:smoke`), and the upstream test files that the test paths in `upstream-allowlist.txt` name (`scripts/xsec/list-test-paths.ts`). Each file runs from its package directory with one process and a 120 s ceiling per test, as upstream runs them.

Sync pull requests (head branch `sync/*`, the name the sync workflow gives its branches) and manual runs also run upstream's full pull-request suite: the nine entries of its `test_*` jobs, with upstream's scripts, shards, concurrency (4, the native shards included) and timeouts. Each runner entry runs through `run-full-suite.ts`, which judges its result (below). The CLI smoke entry runs as it is.

**Known failures.** `upstream-known-failures.txt` lists upstream tests that fail on this fork's full-suite runs, one `<test file> :: <test name>` per line. It holds one entry: `test/tools/browser-relay-detach.test.ts`, "reports a cancel that lands during the re-adoption as a cancel", which fails intermittently in `Test coding-agent native 3/3` on GitHub-hosted runners. The test still runs; it is neither skipped nor quarantined.

`run-full-suite.ts` runs each runner entry unchanged and judges its output. The entry passes only when the script ran to completion (its summary accounts for every chunk of `bun run <script> --dry-run`, or a sequential run exited 0), every failing chunk exited 1 and names its failing tests, and every failing test is on the list. Anything else fails the job: an unlisted failure, a chunk that exits with another code (a crash, an OOM kill or a watchdog timeout), a failure that names no test, or a run that did not finish. The accepted failures are written to the job summary. When a listed test's file is in the plan and the test did not fail in the run (it passed or was skipped), the job warns, so a fixed test leaves the list.

The judge reads the runner's report, so one limit remains. Bun 1.4.4, the version checked here and the one the everyday job ran (the workflows accept 1.4.4 or later), reports an error that fires while a test runs, or between two tests, as a failure of that test or of the next one, and the report names it. A listed test is then accepted by its name, even when the error was not its own. The report also leaves out bun's per-file counts when every failing test is named, so the judge cannot check those counts against the names. A change to the list needs a fork pull request, a T-37 review, and evidence that the test fails on unmodified upstream code: three consecutive failing runs of the same job, or a reproduction on demand locally. A failed job is re-run once, and both attempts are recorded in the [run log](full-suite-runs.md). A test that passes on the re-run does not count toward the three. Everyday runs never read the list.

Not run here: the Rust license check (`cargo-deny`), the bazel and native addon build jobs, the install method smoke tests (`ci:test:install-methods`), and the release jobs, which `xsec-release.yml` runs instead (see Releases). The fork changes no Rust, and the rest need upstream's runners or publishing secrets.

The fork never compiles the native addon. `fetch-natives.ts` installs every `.node` file of `@oh-my-pi/pi-natives-<tag>` at the version the checkout is based on, and checks the tarball against the registry's `sha512` integrity value. Upstream's own pull-request jobs take `@latest` instead; the fork pins the version so the addons match the checkout.

CI and releases use GitHub-hosted runners only. Never attach a self-hosted runner to this repository: a pull request could run its code on it.

## Releases

`.github/workflows/xsec-release.yml` builds the binaries XSec Desktop ships. Pushing a tag `v<upstream>-xsec.<n>` publishes a GitHub Release in this repository, once `tag_guard` has checked the tagged commit. Push a release tag only on a commit of `xsec` that has its own `xsec CI` push run, and only when that run is green. The merge commit that lands a pull request has such a run; a commit inside the pull request does not, so `tag_guard` refuses a tag on it. If the tag was pushed before that run finished, `tag_guard` refuses it too. Once the run is green, re-run the tag's workflow run from the Actions page; pushing the tag again is not needed. The release workflow does not run the tests again, and `tag_guard` checks the CI run, not the tests themselves.

**Tag ruleset.** The repository has a tag ruleset, `xsec-release-tags`, for `v*-xsec.*`. It restricts creating, updating and deleting matching tags and blocks force pushes. Its bypass list holds the two accounts listed in the ruleset (the owner and the org account); see the ruleset in the repository settings. A ruleset cannot check a tag's branch or its CI run, so `tag_guard` does. Both run from the tagged commit, so a tag on a commit that changes the workflow or the script could skip the guard. A tag on a commit older than this workflow has no `tag_guard` job at all, so for such a tag the ruleset is the only check. The ruleset is what keeps anyone else from pushing such a tag.

A manual run (`workflow_dispatch`) on any branch builds, smokes and checksums the same assets and publishes nothing. Its `omp-release-assets` artifact can be downloaded to check them. `tag_guard` runs on a manual run too, against the commit the run started on, so a run from a branch other than `xsec` shows that job as failed, as a tag there would.

- `tag_guard`: runs `scripts/xsec/check-release-tag.ts` on the commit. It fetches `xsec`, requires the commit to be reachable from it, and requires the newest `xsec CI` push run on the commit to be completed and successful. The job reads only: its token needs `actions: read` to list the runs. `publish` waits for it.
- `release_binary`: one job per target. Installs the target's prebuilt natives with `fetch-natives.ts`, builds with `bun run ci:release:build-binaries` (`RELEASE_TARGETS=<target>`), and signs the macOS binaries ad hoc with `scripts/ci-macos-sign.sh`.
- `release_smoke`: runs each binary on its own platform with `--version` and `--smoke-test`. On macOS it also checks the code signature.
- `release_assets`: writes `SHA256SUMS` and checks it against the binaries.
- `publish` (tag pushes only): starts after `release_assets` and `tag_guard` pass. It creates the release as a draft with the five assets, then publishes it. It uses the workflow's own token, with `contents: write` on this job only, and no secrets. If a release already exists for the tag, the job stops; delete that release before publishing the tag again.

Release assets:

| File | Binary |
| --- | --- |
| `omp-linux-x64` | Linux x64, `bun-linux-x64-baseline` |
| `omp-darwin-arm64` | macOS arm64 |
| `omp-darwin-x64` | macOS x64 |
| `omp-windows-x64.exe` | Windows x64, `bun-windows-x64-baseline` |
| `SHA256SUMS` | SHA-256 of the four binaries above |

`SHA256SUMS` has one line per binary, sorted by file name: the 64 lowercase hex digits of the SHA-256, two spaces, the file name, and a newline. Check it with `sha256sum -c SHA256SUMS` on Linux, or `shasum -a 256 -c SHA256SUMS` on macOS. The file names carry no version; the release tag gives the fork version. Upstream's releases name their checksum file `SHA256SUMS.txt`; the fork's file has no extension.

For XSec Desktop:

- The tag is the fork version, for example `v18.20.0-xsec.1`. `omp --version` still prints the upstream version (`18.20.0`): the build takes no fork identifier, and adding one would change an upstream file. Desktop identifies a build by its tag and SHA-256, not by `--version`.
- The release notes name the tag, the commit it was built from and the upstream version.
- macOS binaries are signed ad hoc with the release entitlements. They are not Developer ID signed and not notarized. The Windows binary is not signed.
- Each binary embeds the upstream native addon of its target, `@oh-my-pi/pi-natives-<target>` at the upstream version.
- A release holds only the five files above: no npm packages, no browser relay archive, no `LICENSE`, and no musl or arm64 Linux or Windows binaries.

## Sync with upstream

`.github/workflows/xsec-sync.yml` runs `scripts/xsec/sync.ts` every day at 04:17 UTC and on `workflow_dispatch`. Its `dry_run` input plans and reports without pushing, opening or merging anything. Each run does these steps in order:

1. Fast-forwards `main` to upstream's `main`. If `main` has commits upstream does not have, the run fails.
2. Takes the newest upstream release tag `v<x.y.z>` that is newer than the version on `xsec`. Pre-release and fork tags are ignored, and versions compare by number, so 18.10.0 is newer than 18.9.0. At most one sync pull request is open: while `sync/v<version>` is open, a newer release waits until it merges.
3. Opens `sync/v<version>` with one merge commit of that release into `xsec`, and a pull request against `xsec`. On a conflict nothing is pushed: the run fails, and its summary lists each conflicting file with the upstream commits that touched it. Adapt the fork's change on `xsec` so the release merges cleanly, then run the workflow again.
4. Merges the pull request on a later run, with a merge commit, once all of these hold:
   - it merges cleanly into the current `xsec`, and its head is exactly that merge: no commit of the fork's own, and no edit to the merged tree;
   - it changes no file under `scripts/xsec/`, `packages/coding-agent/src/xsec/`, `packages/coding-agent/test/xsec/` or `.github/workflows/xsec-*.yml`, and under `.github/workflows/` it only edits or deletes files: an added file would start running in the fork as a new workflow, so it stays for review (upstream's workflows stay disabled, and `check-workflows.ts` fails a run where one is enabled);
   - no workflow outside `.github/workflows/xsec-*` is enabled in the repository: the run lists them with its own token just before the merge, and keeps the pull request open if it cannot read the list;
   - it has at least one check, every check on its head is completed and green (`success` or `skipped`), and the commit status is not pending or failed.

   Anything else stays open for review. No check needs to be required in the repository settings: the run reads the check results itself. Auto-merge happens on a scheduled or manual run, so the merge can wait up to a day after the checks finish. A skipped check counts as green, so a job that its own `if:` skips on a sync pull request cannot hold it up. Any new `if:` on a job in `xsec-ci.yml` needs a T-37 review for that reason. A head with no check run at all also stays open, so a workflow that fails before any job starts holds the merge back.

    The policy does not cover `.github/actions/**`: upstream can already change what the checks do through `package.json` scripts and the tests themselves, and the fork ships upstream's code. xsec-ci runs with a read-only token and no secrets.

5. When `xsec` moves on while a sync pull request is open, the run rebuilds its branch on the new head, so the checks run on the merged result. It rebuilds only a branch that still holds the workflow's own merge. Any other content on a sync branch is left for a person.

A sync pull request closed without merging is not reopened. Delete its branch to let a later run open a new one.

**Token.** `OMP_SYNC_TOKEN` is a fine-grained personal access token for this repository only. It needs read and write access to **Contents** (pushes to `main` and the sync branches), **Pull requests** (opening, updating and merging the sync pull request) and **Workflows** (pushes that change a file under `.github/workflows/`). Metadata read comes with them. The run uses it for writes only: pushes, opening and updating the sync pull request, and merging. The workflow's own token cannot push a change to a workflow file, and a push or pull request made with it does not start CI, so it is never used for writes. The run reads with the workflow's own token, which the job grants read access to contents, pull requests, checks, commit statuses and Actions (the workflow list is read just before each merge). When GitHub refuses a write for lack of a permission, the run fails and its error names the permission to add. A merge that GitHub refuses with 405 or 409 is not a failure: the pull request stays open for a later run. Only the two steps that use the token see it, the presence check and the sync itself. The checkout and the setup actions never do. It reaches git and the API per command and is never stored in `.git/config`. Never print it or commit it.

**Runners.** GitHub-hosted only. The merge uses `git merge-tree --write-tree`, which needs git 2.38 or newer; `ubuntu-24.04` ships a newer git.

## Known gaps in model discovery

`models.discovery: configured` limits the discovery that `ModelRegistry` starts. Three paths sit outside that limit. Each one lists the condition under which it sends a request. The package 7 probe on the built binary decides whether one of them needs a fix before package 2.

A registry built without settings follows the process's global settings. With none loaded, `all` applies, and that fallback is logged once.

- **LiteLLM usage.** The usage provider for `litellm`, and for every `discovery.type: litellm` provider, is registered whatever `models.discovery` says. It requests `<base URL>/v2/user/info`, and `<base URL>/key/info` for keys that start with `sk-`, only when usage is read for a LiteLLM API key. The base URL is the provider's configured one, or the built-in default for `litellm`. This is usage reporting, not model discovery. The phase 0 probe saw no LiteLLM host at session start.
- **Extension dynamic managers.** A provider that an extension registers with `fetchDynamicModels` runs its own function on every discovery pass, session start included. The limit does not filter these managers, and the guard does not see the function's requests. Desktop's extensions register no such provider today.
- **Cursor.** In `configured` mode, Cursor discovery runs only when `cursor` is listed in `models.yml`. It then calls the configured base URL, or `CURSOR_DEFAULT_BASE_URL`, with the global `fetch`, and with an HTTP/2 client when that fails. Neither goes through the guard.

## Working locally

```sh
bun install --frozen-lockfile
bun scripts/xsec/fetch-natives.ts linux-x64   # or darwin-arm64, darwin-x64, win32-x64
bun run check:ts
bun test scripts/xsec
bun scripts/xsec/check-upstream-diff.ts
```
