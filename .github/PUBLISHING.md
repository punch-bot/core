# Publishing npm packages

`Publish npm` is a manually triggered workflow. It publishes all eleven public
`@punch-bot/*` packages with provenance. It does not create tags, GitHub
Releases, CLI binaries, or pi.dev announcements.

The packages are `a2a`, `agent`, `ai`, `chord`, `codemode`, `cli`, `durable`,
`env`, `mcp`, `schema`, and `telemetry`, all under `@punch-bot`.

## Authentication

The workflow publishes through npm trusted publishing (GitHub Actions OIDC) and
falls back to the `NPM_TOKEN` secret of the GitHub `npm-publish` environment.
npm tries OIDC first, so a package with a trusted publisher never uses the
token. Configure the `npm-publish` environment with any required deployment
approvals.

Configure a trusted publisher in the npmjs.com settings of every package, under
Settings, Trusted publishing:

- Publisher: GitHub Actions
- Organization or user: `punch-bot`
- Repository: `core`
- Workflow filename: `publish-npm.yml`
- Environment: `npm-publish`
- Allow direct publishing with `npm publish`. Configurations created after
  September 3, 2026 allow only staged publishing by default, and this workflow
  runs `npm publish`.

A new trusted publisher configuration expires unless it completes a publish
within two days, so add it shortly before a release.

Without a trusted publisher, npm rejects the publish with `E404 Not Found - PUT`
for that package. That is the failure the first 1.5.0 run hit.

Trusted publishing cannot publish a package for the first time, because the
publisher is configured on an existing package. `scripts/publish.mjs` checks for
never-published packages before publishing anything and stops unless
`NPM_TOKEN` is set, so no package goes out depending on one that then fails.
`@punch-bot/schema` is new in the release after 1.5.1. Publish that release with
`NPM_TOKEN` set, or publish `@punch-bot/schema` once by hand, then configure its
trusted publisher.

Once every package has a working trusted publisher, delete the `NPM_TOKEN`
secret and set "Require two-factor authentication and disallow tokens" under
Settings, Publishing access for each package. npm plans to remove direct
publishing from granular access tokens that bypass 2FA (targeted for January
2027), so the token fallback stops working then.

## Release steps

Merge the release PR first. Create and push a tag pointing to the reviewed
release commit on `main`, whose package versions and changelogs match the tag.
For example, for `v1.6.0`:

```bash
git fetch origin main
git tag v1.6.0 origin/main
git push origin refs/tags/v1.6.0
gh workflow run publish-npm.yml --ref main -f tag=v1.6.0 -f dry_run=true
```

Review the successful dry run, then publish explicitly:

```bash
gh workflow run publish-npm.yml --ref main -f tag=v1.6.0 -f dry_run=false
```

The workflow accepts only stable version tags reachable from `main` and runs
only when dispatched from `main`. It resolves the tag to one commit before
building all eight bundled env daemons and the npm packages, checking types and
lockfiles, running isolated tests, and smoke-testing packed consumers. Source
changes produced during validation fail the run. Publication uses the existing
idempotent helper; rerun the same tag after fixing a transient failure to skip
package versions already published. Published npm versions cannot be replaced.
