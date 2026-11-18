# Punch

Punch is a fork of the [pi agent harness](https://github.com/earendil-works/pi). Workspace packages publish as `@punch-bot/*`. The CLI binary is still `pi`.

This repo is [`punch-bot/core`](https://github.com/punch-bot/core).

* **[@punch-bot/cli](packages/coding-agent)**: Headless coding agent SDK, RPC, and print modes (`pi`)
* **[@punch-bot/agent](packages/agent)**: Agent runtime with tool calling and state management
* **[@punch-bot/ai](packages/ai)**: Unified multi-provider LLM API

CLI docs: [packages/coding-agent/README.md](packages/coding-agent/README.md).

## Packages

| Package | Directory | Description |
|---------|-----------|-------------|
| **[@punch-bot/cli](packages/coding-agent)** | `packages/coding-agent` | Headless coding agent SDK, RPC, and print modes |
| **[@punch-bot/agent](packages/agent)** | `packages/agent` | Agent runtime with tool calling and state management |
| **[@punch-bot/ai](packages/ai)** | `packages/ai` | Unified multi-provider LLM API |
| **[@punch-bot/telemetry](packages/telemetry)** | `packages/telemetry` | Vendor-neutral telemetry contracts and reference adapter |
| **[@punch-bot/env](packages/env)** | `packages/env` | SSH remote execution environments and daemon |
| **[@punch-bot/sqlite-node](packages/session-backends/sqlite-node)** | `packages/session-backends/sqlite-node` | Node SQLite session backend for `@punch-bot/agent` |

## Install

```bash
npm install -g --ignore-scripts @punch-bot/cli
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

### Using local packages outside the monorepo

Build every public package into one coherent local artifact set:

```bash
npm run pack:packages -- --out .artifacts/pi-packages
```

This refreshes model data before building `pi-ai`. To avoid network access when
model data is already hydrated, pass `--offline-model-data`.

Then configure an external project to consume one package and resolve all of
its Pi dependencies from the same artifact set. npm is the default:

```bash
node scripts/use-local-packages.mjs \
  --manifest .artifacts/pi-packages/manifest.json \
  --consumer ../my-project \
  --package @punch-bot/durable \
  --package @punch-bot/agent
cd ../my-project
npm install --ignore-scripts
```

For a pnpm project, point `--consumer` at the workspace root:

```bash
node scripts/use-local-packages.mjs \
  --manifest .artifacts/pi-packages/manifest.json \
  --consumer ../my-project \
  --package @punch-bot/agent \
  --package-manager pnpm
cd ../my-project
pnpm install --ignore-scripts
```

Repeat `--package` for each direct dependency. The command updates the
consumer's `package.json` with content-addressed local `file:` references. It
writes transitive overrides to `package.json` for npm or `pnpm-workspace.yaml`
for pnpm. Keep the artifact directory available while installing or updating
the consumer. Re-run both commands after changing Pi source.

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

- Direct registry dependencies, including internal workspace packages, are pinned to exact versions.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution. `@punch-bot/*` is excluded from the release-age gate, so the workspace's own packages resolve right after a release.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent shrinkwrap and install lock.
- The pi.dev installer installs from `packages/coding-agent/install-lock/`, generated from the root lockfile, to pin transitive deps. The npm package also keeps a generated shrinkwrap to pin transitive deps.
- Local release smoke tests and npm publication use the same tarball packer; npm publishes the validated tarballs rather than repacking workspace directories.
- Local release installs, documented npm installs, and `pi update --self` use `--ignore-scripts` where supported.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Shrinkwrap and install lock generation have explicit allowlists for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## License

MIT
