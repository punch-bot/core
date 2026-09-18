# Experimental gateway

Implements the server-side gateway proposed in [PNCH-26](https://linear.app/tnfoundation/issue/PNCH-26/gateway-to-discord-and-android-app). Android connects through the existing framed CBOR protocol over WebSocket. The Discord adapter translates signed interactions into the same typed session services.

```text
Android WebSocket -> authenticated listener -> Punch server -> session services
Discord interaction -> signature check -> gateway -> typed client -> Punch server
```

`startGateway()` starts the existing session backend, a WebSocket listener, and configured platform adapters. The caller owns the HTTP server and TLS termination. `Gateway` also works with an application-supplied `Server` configured with the same authorization policy.

## Start a gateway

This code is experimental source and is not included in the published CLI bundle. From a repository checkout, save the following as `gateway.ts` at the repository root and run `node --import tsx gateway.ts` after installing dependencies and hydrating model data.

The example provisions one Punch user with two external identities. A deployment with more users should replace the identity resolvers with its account and membership database.

```ts
import { createServer } from "node:http";
import {
  createOidcAuthenticator,
  DiscordAdapter,
  startGateway,
} from "./packages/coding-agent/src/experimental/gateway/index.ts";

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

const principal = {
  userId: "operator",
  workspaceId: "private",
  permissions: [
    "sessions:read", "sessions:create", "sessions:control", "sessions:remove",
  ],
};
const subject = env("OIDC_SUBJECT");
const guildId = env("DISCORD_GUILD_ID");
const discordUserId = env("DISCORD_USER_ID");
const discord = new DiscordAdapter({
  applicationId: env("DISCORD_APPLICATION_ID"),
  publicKey: env("DISCORD_PUBLIC_KEY"),
  botToken: env("DISCORD_BOT_TOKEN"),
  async resolvePrincipal(identity) {
    if (identity.guildId !== guildId || identity.userId !== discordUserId) {
      throw new Error("Discord identity is not provisioned");
    }
    return principal;
  },
  onError: console.error,
});

const http = createServer((request, response) => {
  if (request.url === "/discord") {
    void discord.handleNode(request, response);
  } else {
    response.writeHead(404).end();
  }
});
http.requestTimeout = 10_000;
http.headersTimeout = 10_000;

const runtime = await startGateway({
  databasePath: "./gateway-data/gateway.db",
  backend: {
    directory: "./gateway-data/server",
    sessionDir: "./gateway-data/sessions",
  },
  httpServer: http,
  websocket: {
    path: "/punch",
    authenticate: createOidcAuthenticator({
      issuer: env("OIDC_ISSUER"),
      audience: env("OIDC_AUDIENCE"),
      jwksUrl: env("OIDC_JWKS_URL"),
      requiredScopes: ["punch"],
      async resolvePrincipal(claims) {
        if (claims.sub !== subject) throw new Error("OIDC identity is not provisioned");
        return principal;
      },
    }),
  },
  adapters: [discord],
  onError: console.error,
});
http.listen(8080, "127.0.0.1");
console.log(`Punch server ID: ${runtime.serverId}`);

async function close() {
  await runtime.close();
  http.close();
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
```

Expose `/punch` through WSS and `/discord` through HTTPS. Keep provider credentials in the backend's existing server-side configuration. Set Discord's interactions endpoint to `/discord`. Register the exported `DISCORD_COMMAND` through Discord's application-command API; startup does not modify the application's registered commands.

The bot needs access to its threads and permission to send and edit messages. The adapter accepts `/punch prompt`, `abort`, `status`, `new`, `attach`, and `model` inside guild threads. Assistant output includes an abort button. The resolver receives the verified guild, thread, and user IDs and must check installation and thread membership for the chosen workspace.

## Authorization

The listener snapshots a verified `Principal` into the connection context. Protocol payloads cannot set this identity. Session services filter each connection's directory independently and authorize creation, removal, and attachment. The router also checks every session invocation and every attachment, including cached session handles.

`GatewayStore` records the workspace and creator of each session. Sessions in one workspace are shared by principals with the corresponding permission. Use separate workspaces for separate privacy boundaries.

| Permission | Access |
| --- | --- |
| `sessions:read` | Directory, attachment, service subscriptions, transcript and status |
| `sessions:create` | Create sessions in the caller's workspace |
| `sessions:control` | Invoke session commands, including prompt, abort and model selection |
| `sessions:remove` | Remove sessions in the caller's workspace |
| `plugins:manage` | Prepare or reload server-side plugin packages |

Existing sessions have no implicit workspace owner and are hidden from remote users. An administrator can call `store.grantSession(sessionId, principal)` to import a session. Ownership cannot be overwritten. Authenticated creation uses a server-generated session ID.

Unauthenticated local clients are denied by default. `allowLocal: true` explicitly grants the private Unix endpoint local administrator access. It does not provision local sessions into a remote workspace.

The supplied OIDC verifier accepts RS256 and ES256 tokens, validates issuer, audience, required scopes, subject, issuance time, expiry, and a maximum one-hour lifetime. It uses a configured HTTPS JWKS endpoint with cached key rotation. Identity resolution happens after verification. Connections close at token expiry. Browser origins are denied unless listed in `websocket.origins`; native clients may omit `Origin`.

## Android contract

The Android app performs OIDC Authorization Code with PKCE, stores refresh credentials in Android Keystore, and supplies `Authorization: Bearer <access-token>` on each WebSocket upgrade. App login and native UI belong in the Android repository.

Each binary WebSocket message carries existing protocol bytes, including the four-byte framing prefix. Text messages are rejected. The protocol handshake still checks the expected logical server ID. Both peers must agree on frame limits. The listener limits WebSocket payloads, queued output bytes, authentication time and concurrent connections.

Bind the existing `SessionDirectory`, `SessionManagement`, `Transcript`, `AgentController` and `Models` contracts. After reconnecting, authenticate again, attach again, and recreate subscriptions. Requests are never replayed automatically. A Node reference client is available from `@punch-bot/client/websocket`:

```ts
const client = await Client.connect({
  serverId,
  transportFactory: createWebSocketTransportFactory({
    url: "wss://gateway.example/punch",
    getAccessToken: refreshAccessToken,
  }),
});
```

To share a session, create it through Android, then run `/punch attach session:<id>` in the Discord thread using an identity in the same workspace. Both presentations attach to the same session worker.

## Delivery and persistence

The SQLite database stores workspace ownership, conversation bindings, interaction receipts and Discord message IDs. Use one database per logical Punch server and one active gateway process for that server. Keep the database with the durable session directory when restarting or moving the deployment.

Interaction claims are durable and at-most-once. A crash between submitting a prompt and recording its result leaves a `pending` receipt. A retry returns that receipt instead of submitting another prompt. Failed or uncertain commands require inspecting session state before issuing a new event. This avoids claiming exactly-once delivery across SQLite and the agent worker.

Transcript rendering coalesces snapshots into batches at one-second intervals, splits output at Discord's 2,000-character limit, and disables mention parsing. Discord HTTP 429 responses honor `retry_after` with a bounded retry budget. Other HTTP or network failures are reported without replaying requests. Set `streaming: false` for completed messages only.

Discord presentations live for the duration of their command. On shutdown, the gateway releases presentations and closes the backend. Background turns and replaying Discord output after a gateway restart are not a durable delivery queue. Session history remains available through the transcript service.

## Checks

From `packages/server`, run the focused transport tests:

```sh
node ../../node_modules/vitest/dist/cli.js --run test/websocket.test.ts
```

From `packages/coding-agent`, run gateway and OIDC tests:

```sh
node ../../node_modules/vitest/dist/cli.js --run test/gateway.test.ts test/gateway-auth.test.ts test/gateway-backend.test.ts
```

The tests use local sockets, generated signing keys, fake session services and a real backend running the faux model provider. They do not contact Discord, an OIDC issuer or an external model provider.
