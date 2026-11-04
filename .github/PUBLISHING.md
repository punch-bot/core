# Publishing npm packages

`Publish npm` is a manually triggered workflow. It publishes all ten public
`@punch-bot/*` packages with provenance, authenticating with an npm token. It
does not create tags, GitHub Releases, CLI binaries, or pi.dev announcements.

Before publishing, create an npm granular access token with read and write
access to the `@punch-bot` packages and save it as the `NPM_TOKEN` secret of the
GitHub `npm-publish` environment. Configure that environment with any required
deployment approvals. The publish step fails early if the secret is missing.
Provenance is still signed through GitHub Actions OIDC, so the job keeps
`id-token: write`.

The packages are `a2a`, `agent`, `ai`, `chord`, `codemode`, `cli`, `durable`,
`env`, `mcp`, and `telemetry`, all under `@punch-bot`.

Merge the release PR first. Create and push a tag pointing to the reviewed
release commit on `main`, whose package versions and changelogs match the tag.
For the prepared 1.4.1 release, after its check blockers have been resolved:

```bash
git fetch origin main
git tag v1.4.1 origin/main
git push origin refs/tags/v1.4.1
gh workflow run publish-npm.yml --ref main -f tag=v1.4.1 -f dry_run=true
```

Review the successful dry run, then publish explicitly:

```bash
gh workflow run publish-npm.yml --ref main -f tag=v1.4.1 -f dry_run=false
```

The workflow accepts only stable version tags reachable from `main` and runs
only when dispatched from `main`. It resolves the tag to one commit before
building all eight bundled env daemons and the npm packages, checking types and
lockfiles, running isolated tests, and smoke-testing packed consumers. Source
changes produced during validation fail the run. Publication uses the existing
idempotent helper; rerun the same tag after fixing a transient failure to skip
package versions already published. Published npm versions cannot be replaced.
