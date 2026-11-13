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

## Known gaps in model discovery

`models.discovery: configured` limits the discovery that `ModelRegistry` starts. Three paths sit outside that limit. Each one lists the condition under which it sends a request. The package 7 probe on the built binary decides whether one of them needs a fix before package 2.

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
