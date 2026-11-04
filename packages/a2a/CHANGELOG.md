# Changelog

## [1.5.1] - 2026-11-04

## [1.5.0] - 2026-11-04

### Breaking Changes

- `createA2aServer` now requires `Authorization: Bearer <token>` on every request and rejects foreign `Host` headers (DNS rebinding). The token comes from the new `authToken` option or is generated and exposed as `server.authToken`; clients pass it as `token` to `delegateToA2aAgent*`. `A2aPeerRecord` gained `token`.

### Fixed

- Fixed `LocalA2aDiscovery` trusting a pre-existing discovery directory created by another local user (for example the shared-temp fallback `/tmp/punch-a2a-<uid>`): the directory must now be a real directory owned by the current user with no group or other permissions, and advertisement files not owned by the current user are ignored.

## [1.4.1] - 2026-10-28

## [1.4.0] - 2026-10-21

## [1.3.0] - 2026-10-17

## [1.2.0] - 2026-10-12

### Added

- Initial `@punch-bot/a2a` package with A2A server, client, and harness executor bridge.
- Added `LocalA2aDiscovery` for same-machine A2A peer advertisements, including TTL-based stale lease cleanup.
