# Publishing npm packages

`Publish npm` is a manually triggered workflow. It publishes all ten public
`@punch-bot/*` packages through npm trusted publishing with provenance. It does
not create tags, GitHub Releases, CLI binaries, or pi.dev announcements.

Before publishing, configure a GitHub Actions trusted publisher in the npm
settings of every public workspace package:

- Organization: `punch-bot`
- Repository: `core`
- Workflow filename: `publish-npm.yml`
- Environment: `npm-publish`
- Allow direct publishing with `npm publish`

The packages are `a2a`, `agent`, `ai`, `chord`, `codemode`, `cli`, `durable`,
`env`, `mcp`, and `telemetry`, all under `@punch-bot`. Configure the GitHub
`npm-publish` environment with any required deployment approvals before running
the workflow. No npm token is needed. See the
[npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).

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
