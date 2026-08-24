# Punch

Punch is a fork of the [pi agent harness](https://github.com/earendil-works/pi). Workspace packages publish as `@punch/*`. The CLI binary is still `pi`.

This repo is [`punch-bot/core`](https://github.com/punch-bot/core).

* **[@punch/cli](packages/coding-agent)**: Interactive coding agent CLI (`pi`)
* **[@punch/agent](packages/agent)**: Agent runtime with tool calling and state management
* **[@punch/ai](packages/ai)**: Unified multi-provider LLM API

CLI docs: [packages/coding-agent/README.md](packages/coding-agent/README.md).

## Packages

| Package | Directory | Description |
|---------|-----------|-------------|
| **[@punch/cli](packages/coding-agent)** | `packages/coding-agent` | Interactive coding agent CLI |
| **[@punch/agent](packages/agent)** | `packages/agent` | Agent runtime with tool calling and state management |
| **[@punch/ai](packages/ai)** | `packages/ai` | Unified multi-provider LLM API |
| **[@punch/tui](packages/tui)** | `packages/tui` | Terminal UI library with differential rendering |
| **[@punch/telemetry](packages/telemetry)** | `packages/telemetry` | Vendor-neutral telemetry contracts and reference adapter |
| **[@punch/protocol](packages/protocol)** | `packages/protocol` | Session protocol schemas, CBOR encoding, and framing |
| **[@punch/client](packages/client)** | `packages/client` | Transport-neutral client for remote sessions |
| **[@punch/server](packages/server)** | `packages/server` | Experimental session server |
| **[@punch/sqlite-node](packages/session-backends/sqlite-node)** | `packages/session-backends/sqlite-node` | Node SQLite session backend for `@punch/agent` |
| **[@punch/evals](packages/evals)** | `packages/evals` | Private model-backed eval harness |

## Install

```bash
npm install -g --ignore-scripts @punch/cli
```

`--ignore-scripts` disables dependency lifecycle scripts. The CLI does not require install scripts for a normal npm install.

From this repo:

```bash
./pi-test.sh
```

## Permissions and containerization

Punch does not include a built-in permission system for filesystem, process, network, or credential access. By default it runs with the permissions of the user and process that launched it.

If you need stronger boundaries, containerize or sandbox it. See [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md):

- **Gondolin extension**: keep `pi` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole `pi` process in a local container.
- **OpenShell**: run the whole `pi` process in a policy-controlled sandbox.

## Development

```bash
npm install --ignore-scripts  # Install deps without lifecycle scripts
npm run build                 # Refresh model data, then build all packages
npm run build:offline         # Rebuild using existing model data (no network)
npm run check                 # Lint, format, and type check
./test.sh                     # Tests (skips LLM-dependent tests without API keys)
./pi-test.sh                  # Run the CLI from sources (any directory)
```

See [AGENTS.md](AGENTS.md) for agent and maintainer rules, and [CONTRIBUTING.md](CONTRIBUTING.md) for the contributor gate.

## Building standalone binaries from release source

GitHub releases include a versioned source archive covered by the release `SHA256SUMS` file. Extract it and run the same build script used for official standalone binaries:

```bash
VERSION="<release-version>"
tar -xzf "pi-${VERSION}-source.tar.gz"
cd "pi-${VERSION}"
./scripts/build-binaries.sh --offline-model-data --platform linux-x64 --out "$PWD/out"
```

The source archive includes the generated provider model data used for that release. `--offline-model-data` builds with that snapshot instead of refreshing live provider catalogs. The script still installs dependencies, builds the monorepo, compiles the Bun executable, and stages its runtime assets. Package maintainers who provide dependencies separately can pass `--skip-install --skip-deps`.

## Supply-chain hardening

Treat npm dependency changes as reviewed code.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent shrinkwrap.
- The published CLI package includes `packages/coding-agent/npm-shrinkwrap.json`, generated from the root lockfile, to pin transitive deps for npm users.
- Release smoke tests use `npm run release:local` to build, pack, and create isolated npm and Bun installs outside the repo before tagging a release.
- Local release installs, documented npm installs, and `pi update --self` use `--ignore-scripts` where supported.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Shrinkwrap generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## License

MIT
