# Changelog

## [Unreleased]

### Breaking Changes

- `createA2aServer` now requires `Authorization: Bearer <token>` on every request and rejects foreign `Host` headers (DNS rebinding). The token comes from the new `authToken` option or is generated and exposed as `server.authToken`; clients pass it as `token` to `delegateToA2aAgent*`. `A2aPeerRecord` gained `token`.

## [1.4.1] - 2026-10-28

## [1.4.0] - 2026-10-21

## [1.3.0] - 2026-10-17

## [1.2.0] - 2026-10-12

### Added

- Initial `@punch-bot/a2a` package with A2A server, client, and harness executor bridge.
- Added `LocalA2aDiscovery` for same-machine A2A peer advertisements, including TTL-based stale lease cleanup.
