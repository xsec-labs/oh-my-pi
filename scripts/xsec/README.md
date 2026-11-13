# xsec fork

This repository is XSec's fork of [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi). XSec Desktop ships the single-file `omp` binary built from the `xsec` branch. The fork exists so the few changes Desktop needs live in source instead of being patched into an installed copy.

The repository is public. Never commit keys, account details or customer data: a commit pushed to a fork stays readable by its hash even after its branch is deleted.

## Branches and tags

| Ref | Content | Rule |
| --- | --- | --- |
| `main` | Mirror of upstream `main` | Fast-forwarded by the sync job only |
| `xsec` (default) | An upstream release tag plus the fork's commits | Pull requests only; upstream is merged in, never rebased |
| `v<upstream>-xsec.<n>` | A fork release | `<n>` counts fork releases on one upstream version |

Open pull requests against `xsec` in this repository. GitHub preselects upstream as the base of a pull request from a fork, so name the base explicitly.

## Where fork code goes

Fork code lives under prefixes upstream does not use, so merging upstream never conflicts on it:

- `packages/coding-agent/src/xsec/` for implementation
- `packages/coding-agent/test/xsec/` for tests
- `scripts/xsec/` for CI scripts
- `.github/workflows/xsec-*.yml` for workflows

An upstream file may only gain the lines that call into `src/xsec/`. Each such file is listed in `upstream-allowlist.txt` with a line budget, and `check-upstream-diff.ts` fails a pull request that changes any other upstream file or goes over a budget.

Do not change these, listed or not; `check-upstream-diff.ts` fails on each of them:

- package versions (the `version` field of a `package.json`). Upstream rewrites them on every release, and a compiled binary only embeds a native addon whose version stamp equals the package version.
- `CHANGELOG.md` files. Upstream rewrites them on every release. Describe fork changes in the pull request and the fork release notes.
- upstream's workflow files. They are disabled under Actions in the repository settings, because they need upstream's runners and publishing secrets. `check-workflows.ts` also fails when one is enabled.

Upstream's development rules in [AGENTS.md](../../AGENTS.md) apply to fork code too.

## CI

`.github/workflows/xsec-ci.yml` runs on pull requests to `xsec`, and on pushes to `xsec`:

- **Fork scope**: `check-upstream-diff.ts`, `check-workflows.ts` and the tests of `scripts/xsec`.
- **Lint, type check & web build**: upstream's `ci:check:full` and `collab:web:build`.
- **Tests**: the nine entries of upstream's `test_*` pull-request jobs, with upstream's scripts, shards and timeouts. The three native shards run at concurrency 2 instead of upstream's 4; the comment on those entries in `xsec-ci.yml` gives the reason.

Not run here: the Rust license check (`cargo-deny`), the bazel and native addon build jobs, the install method smoke tests (`ci:test:install-methods`), and the release jobs. The fork changes no Rust, and the rest need upstream's runners or publishing secrets.

The fork never compiles the native addon. `fetch-natives.ts` installs every `.node` file of `@oh-my-pi/pi-natives-<tag>` at the version the checkout is based on, and checks the tarball against the registry's `sha512` integrity value. Upstream's own pull-request jobs take `@latest` instead; the fork pins the version so the addons match the checkout.

CI uses GitHub-hosted runners only. Never attach a self-hosted runner to this repository: a pull request could run its code on it.

## Sync with upstream

`.github/workflows/xsec-sync.yml` runs `scripts/xsec/sync.ts` every day at 04:17 UTC and on `workflow_dispatch`. Its `dry_run` input plans and reports without pushing, opening or merging anything. Each run does these steps in order:

1. Fast-forwards `main` to upstream's `main`. If `main` has commits upstream does not have, the run fails.
2. Takes the newest upstream release tag `v<x.y.z>` that is newer than the version on `xsec`. Pre-release and fork tags are ignored, and versions compare by number, so 18.10.0 is newer than 18.9.0. At most one sync pull request is open: while `sync/v<version>` is open, a newer release waits until it merges.
3. Opens `sync/v<version>` with one merge commit of that release into `xsec`, and a pull request against `xsec`. On a conflict nothing is pushed: the run fails, and its summary lists each conflicting file with the upstream commits that touched it. Adapt the fork's change on `xsec` so the release merges cleanly, then run the workflow again.
4. Merges the pull request on a later run, with a merge commit, once all of these hold:
   - it merges cleanly into the current `xsec`, and its head is exactly that merge: no commit of the fork's own, and no edit to the merged tree;
   - it changes no file under `scripts/xsec/`, `packages/coding-agent/src/xsec/`, `packages/coding-agent/test/xsec/` or `.github/workflows/xsec-*.yml`, and no upstream workflow file (a new upstream workflow would start running in the fork);
   - it has at least one check, every check on its head is completed and green (`success` or `skipped`), and the commit status is not pending or failed.

   Anything else stays open for review. No check needs to be required in the repository settings: the run reads the check results itself. Auto-merge happens on a scheduled or manual run, so the merge can wait up to a day after the checks finish.
5. When `xsec` moves on while a sync pull request is open, the run rebuilds its branch on the new head, so the checks run on the merged result. It rebuilds only a branch that still holds the workflow's own merge. Any other content on a sync branch is left for a person.

A sync pull request closed without merging is not reopened. Delete its branch to let a later run open a new one.

**Token.** `OMP_SYNC_TOKEN` is a fine-grained token for this repository with read and write access to contents, pull requests and workflows, and read access to checks and commit statuses: the run reads the check results on a pull request's head before it merges. The workflow's own token cannot push a change to a workflow file, and a pull request opened with it does not start CI. Only the sync job references the token. It reaches git and the API per command and is never stored in `.git/config`. Never print it or commit it.

**Runners.** GitHub-hosted only. The merge uses `git merge-tree --write-tree`, which needs git 2.38 or newer; `ubuntu-24.04` ships a newer git.

## Working locally

```sh
bun install --frozen-lockfile
bun scripts/xsec/fetch-natives.ts linux-x64   # or darwin-arm64, darwin-x64, win32-x64
bun run check:ts
bun test scripts/xsec
bun scripts/xsec/check-upstream-diff.ts
```
