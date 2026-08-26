# @punch-bot/a2a

Agent2Agent (A2A) protocol integration for punch agents.

This package wraps the official [`@a2a-js/sdk`](https://www.npmjs.com/package/@a2a-js/sdk) and provides punch-specific helpers for:

- exposing a punch agent as an A2A server
- delegating tasks to external A2A agents (for example Hermes)
- bridging `AgentHarness` prompt execution to A2A task lifecycle events

## Server

```ts
import { createA2aServer } from "@punch-bot/a2a";

const server = await createA2aServer({
  baseUrl: "http://localhost:41241",
  runnerFactory: (contextId) => ({
    async prompt(text) {
      return { text: `echo: ${text}` };
    },
  }),
});

await server.listen(41241);
```

## Client

```ts
import { delegateToA2aAgent } from "@punch-bot/a2a";

const result = await delegateToA2aAgent({
  url: "http://localhost:41241",
  task: "Summarize the repository structure",
});

console.log(result.text);
```
