# durable

Headless experimental runtime built on `@punch-bot/durable`. Import `openDurable` from
`runtime.ts` to open a session, subscribe to its view, and submit work through its controller.
Call `close()` when finished. Pass `continueSession: true` to resume the newest session.

The runtime shares pi model credentials and settings. Its session storage, prompt,
and tools are implemented in this directory. Punch keeps terminal UI entrypoints removed.
