# Changelog

## [Unreleased]

### Added

- Added an `authorizationServerMetadataUrl` option to `authorizeMcp()` to use a configured authorization server metadata document instead of discovery ([#10172](https://github.com/earendil-works/pi/issues/10172)).
- Added an `iss` option to `authorizeMcp()`. The authorization code is only exchanged when `iss` names the flow's authorization server, or is absent and the server's metadata does not set `authorization_response_iss_parameter_supported` (RFC 9207).

## [0.99.2] - 2026-09-30

### Fixed

- Fixed `StreamableHttpTransport` failing every request on Cloudflare Workers with `Illegal invocation` by calling `fetch`, including `UnauthorizedContext.fetch`, without a receiver ([#10188](https://github.com/earendil-works/pi/issues/10188))

## [0.99.1] - 2026-09-29

## [0.99.0] - 2026-09-29

### Added

- Added a standalone MCP client with JSON-RPC lifecycle, tool discovery and calls, cancellation, progress, roots, stdio and Streamable HTTP transports, and an in-memory testing transport.
