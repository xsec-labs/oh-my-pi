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
- **Tests**: the nine entries of upstream's `test_*` pull-request jobs, with upstream's scripts, shards, concurrency and timeouts.

Not run here: the Rust license check (`cargo-deny`), the bazel and native addon build jobs, the install method smoke tests (`ci:test:install-methods`), and the release jobs, which `xsec-release.yml` runs instead (see Releases). The fork changes no Rust, and the rest need upstream's runners or publishing secrets.

The fork never compiles the native addon. `fetch-natives.ts` installs every `.node` file of `@oh-my-pi/pi-natives-<tag>` at the version the checkout is based on, and checks the tarball against the registry's `sha512` integrity value. Upstream's own pull-request jobs take `@latest` instead; the fork pins the version so the addons match the checkout.

CI and releases use GitHub-hosted runners only. Never attach a self-hosted runner to this repository: a pull request could run its code on it.

## Releases

`.github/workflows/xsec-release.yml` builds the binaries XSec Desktop ships. Pushing a tag `v<upstream>-xsec.<n>` publishes a GitHub Release in this repository. Push the tag only on a commit of `xsec` whose `xsec CI` run is green: the release workflow does not run the tests again.

A manual run (`workflow_dispatch`) on any branch builds, smokes and checksums the same assets and publishes nothing. Its `omp-release-assets` artifact can be downloaded to check them.

- `release_binary`: one job per target. Installs the target's prebuilt natives with `fetch-natives.ts`, builds with `bun run ci:release:build-binaries` (`RELEASE_TARGETS=<target>`), and signs the macOS binaries ad hoc with `scripts/ci-macos-sign.sh`.
- `release_smoke`: runs each binary on its own platform with `--version` and `--smoke-test`. On macOS it also checks the code signature.
- `release_assets`: writes `SHA256SUMS` and checks it against the binaries.
- `publish` (tag pushes only): creates the release as a draft with the five assets, then publishes it. It uses the workflow's own token, with `contents: write` on this job only, and no secrets. If a release already exists for the tag, the job stops; delete that release before publishing the tag again.

Release assets:

| File | Binary |
| --- | --- |
| `omp-linux-x64` | Linux x64, `bun-linux-x64-baseline` |
| `omp-darwin-arm64` | macOS arm64 |
| `omp-darwin-x64` | macOS x64 |
| `omp-windows-x64.exe` | Windows x64, `bun-windows-x64-baseline` |
| `SHA256SUMS` | SHA-256 of the four binaries above |

`SHA256SUMS` has one line per binary, sorted by file name: the 64 lowercase hex digits of the SHA-256, two spaces, the file name, and a newline. Check it with `sha256sum -c SHA256SUMS` on Linux, or `shasum -a 256 -c SHA256SUMS` on macOS. The file names carry no version; the release tag gives the fork version.

For XSec Desktop:

- The tag is the fork version, for example `v18.20.0-xsec.1`. `omp --version` still prints the upstream version (`18.20.0`): the build takes no fork identifier, and adding one would change an upstream file.
- macOS binaries are signed ad hoc with the release entitlements. They are not Developer ID signed and not notarized. The Windows binary is not signed.
- Each binary embeds the upstream native addon of its target, `@oh-my-pi/pi-natives-<target>` at the upstream version.
- A release holds only the five files above: no npm packages, no browser relay archive, no `LICENSE`, and no musl or arm64 Linux or Windows binaries.

## Working locally

```sh
bun install --frozen-lockfile
bun scripts/xsec/fetch-natives.ts linux-x64   # or darwin-arm64, darwin-x64, win32-x64
bun run check:ts
bun test scripts/xsec
bun scripts/xsec/check-upstream-diff.ts
```
