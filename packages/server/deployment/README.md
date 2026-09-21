# Sandbox gateway deployment

The deployment runs three programs from `@punch-bot/server`:

- The gateway authenticates OIDC WebSocket clients and signed Discord interactions. Its SQLite database stores session routes, conversation bindings, event receipts, and Discord message IDs.
- The supervisor owns the Docker socket and a separate SQLite registry. It creates one runtime container and one persistent volume per sandbox.
- Each runtime owns its sessions, model calls, and read/write/edit/bash tools. Runtime data is under `/sandbox`, with working files in `/sandbox/work`.

The gateway and supervisor can restart while an admitted runtime operation continues. A runtime restart reopens durable history. Neither connection recovery nor an uncertain platform receipt resubmits a prompt.

## Build artifacts

Use Node 24 or newer for the bundled deployment. From the repository root:

```sh
npm ci --ignore-scripts
npm run hydrate:model-data
node scripts/bundle-sandbox-runtime.mjs /tmp/opencode/punch-server-image
```

The script emits `gateway.mjs`, `supervisor.mjs`, `runtime.mjs`, a Dockerfile, and an esbuild dependency manifest. It fails if any entry imports `packages/coding-agent`. The bundles include their JavaScript dependencies and run outside the repository.

Build each image using an explicitly chosen Node 24 Debian image digest. For example, after setting `NODE_IMAGE` to `node:24-bookworm-slim@sha256:<verified-digest>`:

```sh
docker build --build-arg NODE_IMAGE="$NODE_IMAGE" --build-arg ENTRY=runtime -t punch-runtime /tmp/opencode/punch-server-image
docker build --build-arg NODE_IMAGE="$NODE_IMAGE" --build-arg ENTRY=supervisor -t punch-supervisor /tmp/opencode/punch-server-image
docker build --build-arg NODE_IMAGE="$NODE_IMAGE" --build-arg ENTRY=gateway -t punch-gateway /tmp/opencode/punch-server-image
```

Set the three `PUNCH_*_IMAGE` variables in the Compose environment to immutable registry digests or local `sha256:` image IDs. The runtime image must already exist on the supervisor's Docker daemon. The supervisor does not pull images during acquisition.

## Configuration

Set `PUNCH_CONFIG_DIRECTORY` to an absolute directory containing these files. Set `PUNCH_SUPERVISOR_TOKEN` to a random secret of at least 32 characters, and `PUNCH_GATEWAY_ID` to a stable UUID.

`workspaces.json` supplies each workspace's runtime environment. The supervisor reads it when creating a generation:

```json
{
  "team": {
    "PUNCH_PROVIDER": "openai",
    "PUNCH_MODEL": "gpt-4.1",
    "OPENAI_API_KEY": "replace-with-workspace-key"
  }
}
```

Supported entrypoint providers are `openai`, `anthropic`, and `faux`. Use a model ID present in the selected provider's catalog. `faux` is for offline smoke tests, with model `faux-1`. Provider credentials stay with the supervisor and the workspace runtime. Changing credentials takes effect on the next runtime generation.

`memberships.json` maps verified external identities to local principals:

```json
[
  {
    "oidcSubject": "issuer-subject-for-alice",
    "principal": {
      "userId": "alice",
      "workspaceId": "team",
      "permissions": ["sessions:read", "sessions:create", "sessions:control"]
    }
  },
  {
    "discord": { "guildId": "123", "channelId": "456", "userId": "789" },
    "principal": {
      "userId": "alice",
      "workspaceId": "team",
      "permissions": ["sessions:read", "sessions:create", "sessions:control"]
    }
  }
]
```

Each OIDC subject must resolve to exactly one grant. Each Discord grant names an exact thread and user. Membership checks reload the file, including on cached session calls. Reduced permissions require the client to reconnect with a fresh identity.

Set `PUNCH_OIDC_ISSUER`, `PUNCH_OIDC_AUDIENCE`, `PUNCH_OIDC_JWKS_URL`, and `PUNCH_OIDC_SCOPES`. Access tokens must have `sub`, `iat`, and `exp`, a lifetime of at most one hour, the required scopes, and an RS256 or ES256 signature. Android uses Authorization Code with PKCE to obtain those tokens.

For Discord, also set `PUNCH_DISCORD_APPLICATION_ID`, `PUNCH_DISCORD_PUBLIC_KEY`, and `PUNCH_DISCORD_BOT_TOKEN`. Register the `DISCORD_COMMAND` exported by `@punch-bot/server/gateway/discord`. Configure the interaction endpoint as `/discord` on the public gateway URL. The adapter accepts commands only in server threads.

Start with:

```sh
docker compose -f packages/server/deployment/compose.yaml up -d
```

Terminate TLS at a reverse proxy forwarding `/punch` WebSocket upgrades and `/discord` requests to `127.0.0.1:8082`. Only the supervisor mounts the Docker socket. The control API on port 8081 and runtime port 8080 have no published host ports.

## Client protocol

Clients use the existing framed CBOR protocol and typed services:

1. Connect to `wss://<gateway>/punch` with `Authorization: Bearer <access-token>` and the configured gateway ID.
2. Use `GatewaySessions` from `@punch-bot/server/services` at server scope. `create(null)` creates a sandbox and session. `create(sandboxId)` creates another session in an existing authorized sandbox. `list()` returns workspace sessions. `attach(sessionId)` selects one.
3. At session scope, subscribe to `RuntimeTranscript` and invoke `SandboxOperations.accept({ operationId, text })`, `status(operationId)`, or `abort(operationId)`. Operation IDs contain 1 to 128 ASCII letters, digits, underscores, or hyphens. Retrying the same admitted ID does not submit another prompt.
4. `RuntimeModels.select({ provider, modelId })` changes the session model. The transcript includes the selected model and current operation.

All client contracts are exported from `@punch-bot/server/services`. That entrypoint bundles for browsers without Node, Docker, or runtime implementation imports. The public Node entrypoints are `@punch-bot/server/gateway`, `@punch-bot/server/supervisor`, and `@punch-bot/server/runtime`.

Discord `/punch attach session:<id>` attaches the same session used by a WebSocket client. `/punch prompt`, `abort`, `new`, `model`, and `status` operate on its durable conversation binding. Platform event claims survive crashes. A pending claim is an uncertain result and is never replayed automatically.

Internal runtime capabilities expire after five minutes and contain the principal, workspace, and runtime generation. On a lost or expired runtime connection, reattach to acquire the current route and resubscribe. Inspect operation status before submitting new work. Platform completion waits are bounded; detaching does not abort the runtime operation. The authenticated runtime readiness response also reports active session/operation IDs.

## Lifecycle and recovery

The private supervisor API is `POST /v1/sandboxes` with the control bearer token. Requests contain `action`, `workspaceId`, and, except for `create`, `sandboxId`. Actions are `create`, `inspect`, `acquire`, `stop`, and `delete`. Deletion requires an explicit boolean `deleteData`.

- Stop retains the volume. Acquire replaces a stopped or missing container and rotates its generation and credentials.
- `GatewaySessions.remove(sessionId)` requires `sessions:remove`, releases attachments, aborts that session's work, and deletes its session history. It retains the sandbox container, shared working files, and other sessions.
- Delete with `deleteData: false` removes the container and retains the volume. A later delete with `deleteData: true` deletes that retained volume.
- Only one supervisor may own a registry, and only one runtime may write a sandbox volume. SQLite ownership locks release on process death.
- Startup reconciliation adopts live containers and finishes interrupted stop/delete operations. Unrelated containers and volumes fail ownership checks.
- Supervisor shutdown drains lifecycle calls without stopping containers. Runtime SIGTERM aborts active work and closes storage, with an eight-second process deadline inside Docker's ten-second stop grace period.

Keep the supervisor registry, gateway database, and sandbox volumes together when backing up an installation. Their IDs and workspace ownership are linked. Session creation can leave an unlisted runtime session if the gateway dies after runtime creation but before catalog persistence; inspect the runtime before retrying an uncertain create.

## Verification status

Offline tests cover runtime persistence, shared Discord/WebSocket sessions, signed interaction deduplication, gateway restart during a turn, workspace isolation, OIDC validation, and supervisor lifecycle behavior with a fake engine. Real Docker integration testing is deferred.
