# Punch

This is [`punch-bot/core`](https://github.com/punch-bot/core), a fork of the [pi agent harness](https://github.com/earendil-works/pi). npm packages are `@punch-bot/*`. The CLI binary, config dir, and most env vars are still `pi` / `.pi` / `PI_*` until a later rebrand.

Directory names did not change with the npm rename. `@punch-bot/cli` lives in `packages/coding-agent`.

| npm name | Directory |
|----------|-----------|
| `@punch-bot/cli` | `packages/coding-agent` |
| `@punch-bot/agent` | `packages/agent` |
| `@punch-bot/ai` | `packages/ai` |
| `@punch-bot/telemetry` | `packages/telemetry` |
| `@punch-bot/chord` | `packages/chord` |
| `@punch-bot/durable` | `packages/durable` |
| `@punch-bot/mcp` | `packages/mcp` |
| `@punch-bot/codemode` | `packages/codemode` |
| `@punch-bot/a2a` | `packages/a2a` |
| `@punch-bot/env` | `packages/env` |
| `@punch-bot/schema` | `packages/schema` |

## Merging upstream pi

Punch dropped several parts of pi. Upstream merges bring changes to them back as modify/delete conflicts, new files, or edits to files that survived. Before resolving, check whether the code belongs to something Punch dropped, and do not restore it.

- [PR #19](https://github.com/punch-bot/core/pull/19) made `@punch-bot/cli` headless. Only print, JSON, and RPC modes exist. Removed:
  - `packages/tui` (`@punch-bot/tui`) and `packages/evals`;
  - interactive mode (`src/modes/interactive`), the session picker, startup UI, config selector, and TUI keybindings;
  - TUI-only extension APIs: `renderCall`/`renderResult`, tool renderers (`src/core/tools/renderers`), custom editors/footers/headers, `InteractiveMode`, `registerMarkdownTransformer`;
  - the MCP manager UI (`src/extensions/mcp/ui.ts`), the codemode renderer, and experimental TUI entrypoints (`src/experimental/client-tui*.ts`, `src/experimental/*/{main,tui}.ts`);
  - TUI-only examples and tests.
  Theme tokens moved to `src/core/theme`.
- [PR #9](https://github.com/punch-bot/core/pull/9) disabled GitHub Actions. Workflows live in `.github/workflows-disabled/`. Put new upstream workflows there, not in `.github/workflows/`.
- Model selection uses pi's resolver (partial matching, lenient session restore) with Punch patches in `src/core/model-resolver.ts` and `src/core/model-suffix-variants.ts`: partial matches prefer a base ID over its `:variant` and an ID ending in the typed text over one continuing it, and warn with the selected model; `<catalog id>:<suffix>` IDs (OpenRouter routing variants such as `:nitro`) copy the catalog model; restore and saved-default fallbacks print a warning. Keep these patches when merging upstream resolver changes, and do not add provider-specific suffix lists.
- Provider requests send the `User-Agent` `punch-agent`, without platform, runtime, or architecture. Since pi 1.4.0 it comes from client identity: `"short"` is the default mode in `packages/ai/src/utils/identity.ts` and Bedrock's `bedrockUserAgent()`, and `src/core/client-identity.ts` in `@punch-bot/cli` uses it too. pi's own requests to pi.dev and GitHub keep the detailed form (`src/utils/pi-user-agent.ts`). Keep this when merging upstream identity changes.
- pi 1.0.1 removed `packages/coding-agent/npm-shrinkwrap.json` and its generator. Punch keeps both, along with `check:shrinkwrap` and the `shrinkwrap` step in `prepublishOnly` and `scripts/release.mjs`.
- The pi 1.5.2 merge left out `apps/` (the experimental `p2` app, which depends on pi-tui, and `p3` design docs), `.github/workflows/p2-cloud-bundle.yml`, and `.pi/skills/p2-ui.md`.
- The pi 1.1 merge left out the Nix flake (`flake.nix`, `flake.lock`, `nix/`, `nix.yml`, `scripts/update-model-catalog-pin.mjs`). It packages `packages/tui` and pins pi.dev's model catalog.
- Rename new upstream `@earendil-works/*` packages, imports, and docs references to `@punch-bot/*`, and add new packages to the table above.

How to resolve:

- Modify/delete conflicts on dropped paths: keep the deletion.
- Upstream edits in surviving files that only serve the TUI: drop them. Port fixes that also affect print, JSON, or RPC mode, the SDK, or extensions.
- Land upstream merges with a merge commit, not squash or rebase, so the upstream tag stays an ancestor. If `git merge-base HEAD <tag>` is older than the last merged upstream tag, preview with `git merge-tree --merge-base=<last merged tag> HEAD <tag>`.

# Development Rules

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!")
- Technical prose only, be direct
- Use concise, clear, simple language. Define unavoidable jargon before using it.
- Explain non-trivial designs and problems as: problem, concrete example or short trace, then solution. State why the solution is necessary and distinguish it from optional complexity.
- Prefer concrete behavior and small illustrations over abstract summaries, dense terminology, or unexplained lists of changes.
- When the user asks a question, answer it first before making edits or running implementation commands.
- When responding to user feedback or an analysis, explicitly say whether you agree or disagree before saying what you changed.

## Code Quality

- Read files in full before wide-ranging changes, before editing files you have not fully inspected, and when asked to investigate or audit. Do not rely on search snippets for broad changes.
- No `any` unless absolutely necessary.
- No runtime checks of values whose types TypeScript already guarantees (no `typeof`/`instanceof`/`Array.isArray`/shape guards on typed parameters, typed callback results or typed declarations). Validate only at decided trust boundaries (wire input, schema-checked arguments and params).
- Inline single-line helpers that have only one call site.
- Check node_modules for external API types; don't guess.
- **No inline imports** (`await import()`, `import("pkg").Type`, dynamic type imports). Top-level imports only.
- In `packages/coding-agent`, resolve package assets through helpers in `src/config.ts`. Do not use `__dirname` directly; the helpers account for source checkouts, npm installations, and standalone binaries.
- Never remove or downgrade code to fix type errors from outdated deps; upgrade the dep instead.
- Use only erasable TypeScript syntax (Node strip-only mode) in code checked by the root config (`packages/*/src`, `packages/*/test`, `packages/coding-agent/examples`): no parameter properties, `enum`, `namespace`/`module`, `import =`, `export =`, or other constructs needing JS emit. Use explicit fields with constructor assignments.
- Always ask before removing functionality or code that appears intentional.
- Do not preserve backward compatibility unless the user asks for it.
- Never hardcode key checks.
- Never modify `packages/ai/src/models.generated.ts` directly; update the catalog definitions in `packages/ai/catalog/` instead (see its README), then regenerate. Including the resulting `models.generated.ts` diff is always OK, even if regeneration includes unrelated upstream model metadata changes. The generated model data in `packages/ai/src/providers/data/` is gitignored: never stage it, and don't look for it in git history.

## Chord v2 Code Style

Binding for Chord v2 (`packages/chord/src/`) and its tests, when writing and when reviewing. The model is pi-durable's source.

- Files: one concept per file, named after it; no one-helper files, no grab-bag files. First line: a comment saying what the file is for. Order: imports, exported types, then the public entry point first and its helpers below it in the order they are used; constants right above their first user. A blank line between top-level declarations. Split files by concept, never by size: one concept may take a long file (up to about 1,000 lines is fine); a second concept in a file is the reason to split.
- Functions: every export has a one-line doc comment saying what it does or guarantees. Inline comments explain a non-obvious why (cost, race, decided rule), never what the next line does. Short functions with one job (about 40 lines needs a reason; one `switch` over a tagged union is fine). No boolean flag parameters that switch behaviour: two functions or a tagged value. Never write the same lines twice. Context last: required args, then `context`/`ctx` (always required, as in Durable; optional only on error-reporting paths), then optional args.
- Types and checks: tagged unions for every state and result. Casts only where TypeScript cannot express a decided invariant, each with a short why. Every remaining runtime check names the trust boundary it serves (wire input, schema-checked params and arguments, declaration policy the types cannot express). Same-host values are plain data, immutable by convention: never copied, frozen or walked to enforce it; freeze only Chord-owned metadata when a decision says so. No defensive code against broken adapters, callers or our own modules.
- Cost and memory: no hot-path work a decision did not ask for (walks, copies, compilations, per-call allocations). The function doing counted work counts it through its context; call sites never count for others. Caches are `WeakMap`s keyed by their owner, each with a GC test; no module-level strong caches.
- Names and API: the design's vocabulary (`params`, `binding`, `principal key`), no invented synonyms; decided `ChordError` codes and reasons. Export only what a later layer or app needs. No dev or test modes, no unrequested options.
- Tests: one test file per source file, one `describe` per mechanism, the layer spec's test list case by case; cost guards through the in-memory telemetry adapter; GC tests for every cache and binding. Every slice also adds one or more runnable examples in `packages/chord/test/examples/NN-topic.ts`, one topic each, numbered across slices, written as references for Chord's users (Durable's `test/examples/` format: header with what it shows and how to run it, commented steps, printed results).
- Slices: Chord v2 is built in vertical slices (`packages/chord/docs/slices.md`). Implementers and reviewers read the slice spec, the feature map in `slices.md` and the whole of `packages/chord/docs/design.md` in full, and check the work against all three; slice specs cite design sections for orientation, not as a reading limit.
- Deferred work: anything left to a later slice goes into the section "Carry-over" of `packages/chord/docs/slices.md` under that slice, in the same change; a slice's spec and build include every entry of its section.
- Before reporting: re-read every changed file top to bottom as a stranger would; each file must be understandable without jumping around. Then `npm run check` and the layer's tests.

## Commands

- After code changes (not docs): `npm run check` (full output, no tail). Fix all errors, warnings, and infos before committing. Does not run tests.
- Never run `npm run build` or `npm test` unless requested by the user.
- Never run the full vitest suite directly: it includes e2e tests that activate when endpoint/auth env vars are present. For all non-e2e tests, run `./test.sh` from the repo root. It runs `packages/*` only. Otherwise run specific tests from the package root:
  - Vitest: `node "$(git rev-parse --show-toplevel)/node_modules/vitest/dist/cli.js" --run test/specific.test.ts`
- If you create or modify a test file, run it and iterate on test or implementation until it passes.
- For `packages/coding-agent/test/suite/`, use `test/suite/harness.ts` + the faux provider. No real provider APIs, keys, or paid tokens.
- Put issue-specific regressions under `packages/coding-agent/test/suite/regressions/` named `<issue-number>-<short-slug>.test.ts`.
- For ad-hoc scripts, `write` them to a temp file (e.g. `/tmp`), run, edit if needed, remove when done. Don't embed multi-line scripts in `bash` commands.
- Never commit unless the user asks.

## Dependency and Install Security

- Treat npm dep and lockfile changes as reviewed code. Direct registry deps, including internal workspace deps, stay pinned to exact versions.
- When updating `undici`, you MUST read its changelog/release notes for the target version and evaluate whether any changes may affect functionality before applying the update.
- Hydrate/update locally with `npm install --ignore-scripts`; clean/CI-style with `npm ci --ignore-scripts`. Don't run lifecycle scripts unless the user asks.
- If dep metadata changes, refresh `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
- If `packages/coding-agent/npm-shrinkwrap.json` needs regen, run `node scripts/generate-coding-agent-shrinkwrap.mjs`; if `packages/coding-agent/install-lock/` needs regen, run `node scripts/generate-coding-agent-install-lock.mjs` (verify with `--check` or `npm run check`). New deps with lifecycle scripts require review and an explicit allowlist entry in both scripts; never add one silently.
- Pre-commit blocks lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1`. Don't bypass unless the user wants the lockfile change committed.

## Git

Multiple agent sessions may be running in this cwd at the same time, each modifying different files. Git operations that touch unstaged, staged, or untracked files outside your own changes will stomp on other sessions' work. Follow these rules:

Committing:

- Only commit files YOU changed in THIS session.
- Stage explicit paths (`git add <path1> <path2>`); never `git add -A` / `git add .`.
- Before committing, run `git status` and verify you are only staging your files.
- `packages/ai/src/models.generated.ts` may always be included alongside your files.
- Message format: `{feat,fix,docs}[(ai,agent,coding-agent)]: <commit message> (optionally multiple lines)`. Message is informative and concise.

Never run (destroys other agents' work or bypasses checks):

- `git reset --hard`, `git checkout .`, `git clean -fd`, `git stash`, `git add -A`, `git add .`, `git commit --no-verify`.

If rebase conflicts occur:

- Resolve conflicts only in files you modified.
- If a conflict is in a file you did not modify, abort and ask the user.
- Never force push.

## Issues and PRs

See `CONTRIBUTING.md` for the contributor gate (auto-close workflows, `lgtm`/`lgtmi`, quality bar).

When reviewing PRs:

- Do not run `gh pr checkout`, `git switch`, or otherwise move the worktree to the PR branch unless the user explicitly asks.
- Use `gh pr view`, `gh pr diff`, `gh api`, and local `git show`/`git diff` against fetched refs to inspect PR metadata, commits, and patches without changing branches.
- If you need PR file contents, fetch/read them into temporary files or use `git show <ref>:<path>` without switching branches.

When creating issues:

- Add `pkg:*` labels for affected packages (`pkg:agent`, `pkg:ai`, `pkg:coding-agent`); use all that apply.

When posting issue/PR comments:

- Write the comment to a temp file and post with `gh issue/pr comment --body-file` (never multi-line markdown via `--body`).
- Keep comments concise, technical, in the user's tone.
- End every AI-posted comment with the AI-generated disclaimer line specified by the originating prompt (e.g. `This comment is AI-generated by `/wr``).

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the message so merging auto-closes the issue. For multiple issues, repeat the keyword per issue (`closes #1, closes #2`); a shared keyword (`closes #1, #2`) only closes the first.

## Changelog

Location: `packages/*/CHANGELOG.md` (one per package).

Sections under `## [Unreleased]`: `### Breaking Changes` (API changes requiring migration), `### Added`, `### Changed`, `### Fixed`, `### Removed`.

Rules:

- All new entries go under `## [Unreleased]`. Read the full section first and append to existing subsections; never duplicate them.
- Released version sections (e.g. `## [0.12.2]`) are immutable; never modify them.
- Do not create changelog entries when the work targets a branch other than `main`

Attribution:

- Internal (from issues): `Fixed foo bar ([#123](https://github.com/punch-bot/core/issues/123))`
- External contributions: `Added feature X ([#456](https://github.com/punch-bot/core/pull/456) by [@username](https://github.com/username))`

## Releasing

**Lockstep versioning**: all packages share one version; every release updates all together. `patch` = fixes + additions, `minor` = breaking changes. No major releases.

1. **Update CHANGELOGs**: ask the user whether they ran the `/cl` prompt on the latest commit on `main`. If not, they must run `/cl` first to audit and update each package's `[Unreleased]` section before releasing.

2. **Local smoke test**: build an unpublished release and smoke test from outside the repo (so it can't resolve workspace files):
   ```bash
   npm run release:local -- --out /tmp/pi-local-release --force
   cd /tmp

   # Node package install smoke tests
   /tmp/pi-local-release/node/pi --help
   /tmp/pi-local-release/node/pi --version
   /tmp/pi-local-release/node/pi --list-models
   /tmp/pi-local-release/node/pi -p "Say exactly: ok"

   # Bun binary smoke tests
   /tmp/pi-local-release/bun/pi --help
   /tmp/pi-local-release/bun/pi --version
   /tmp/pi-local-release/bun/pi --list-models
   /tmp/pi-local-release/bun/pi -p "Say exactly: ok"
   ```
   Verify both Node and Bun startup, model/account listing, and at least one print-mode prompt with the intended default provider. Failures are release blockers unless the user explicitly accepts the risk.

3. **Run the release script**:
   ```bash
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:patch    # fixes + additions
   PI_ALLOW_LOCKFILE_CHANGE=1 npm_config_min_release_age=0 npm run release:minor    # breaking changes
   ```
   Use `npm_config_min_release_age=0` only for the release command. The repo's normal npm age gate can otherwise block the release lockfile refresh when the current workspace package version was published recently. Review any lockfile or shrinkwrap diffs the release creates before push.

   The release script bumps all package versions, updates changelogs, regenerates release artifacts, runs `npm run check`, commits `Release vX.Y.Z`, tags `vX.Y.Z`, adds fresh `## [Unreleased]` changelog sections, commits `Add [Unreleased] section for next cycle`, then pushes `main` and the tag. Publication is a separate manual workflow. Do not rerun the release script after a tag was pushed.

4. **Publish npm manually**: follow [`.github/PUBLISHING.md`](.github/PUBLISHING.md) to configure npm trusted publishing and dispatch `.github/workflows/publish-npm.yml` from `main` for an existing release tag. Run with `dry_run=true` first, then explicitly publish with `dry_run=false`. The workflow builds bundled env daemons, validates packages, and publishes through GitHub Actions OIDC with environment `npm-publish`. It does not publish GitHub Releases, CLI binaries, or pi.dev announcements. The upstream `build-binaries.yml` remains disabled.

5. **If publication fails**: inspect the failed job. The publish helper is idempotent and skips package versions already present on npm. Rerun the workflow for the same tag after fixing transient npm or authentication issues. Source fixes require a new reviewed commit and tag before any packages have been published, or a new version after publication has started. Do not rerun `npm run release:patch` or `npm run release:minor` for the same version.

## User Override

If the user's instructions conflict with any rule in this document, ask for explicit confirmation before overriding. Only then execute their instructions.
