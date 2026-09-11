# Subagents

Punch includes a `subagent` tool that delegates work to a specialized agent in an isolated process or through an A2A endpoint. It supports one task, up to eight parallel tasks with four running concurrently, and sequential chains that substitute the previous result into `{previous}`.

## Bundled agents

Fresh installations include four definitions:

| Agent | Purpose |
| --- | --- |
| `scout` | Read-only codebase reconnaissance |
| `planner` | Implementation planning |
| `reviewer` | Read-only code review |
| `worker` | General implementation work |

Add or override agents with Markdown files in `~/.pi/agent/agents`. Each file needs YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: anthropic/claude-sonnet-4-5
---

System instructions for the agent.
```

Omit `model` to inherit the parent session's model and thinking level. Set `a2aUrl` to delegate through A2A instead of starting a local `pi` process.

## Project agents and trust

The default `agentScope` is `user`, which loads bundled and user agents but not repository-controlled definitions. Set it to `project` or `both` to discover the nearest `.pi/agents` directory. In an untrusted interactive project, Punch asks for confirmation before executing any requested project agent. Project definitions override user and bundled definitions with the same name.

## Modes

- Single: `{ "agent": "scout", "task": "Find the authentication entry points" }`
- Parallel: `{ "tasks": [{ "agent": "scout", "task": "Find models" }, { "agent": "scout", "task": "Find providers" }] }`
- Chain: `{ "chain": [{ "agent": "scout", "task": "Find auth code" }, { "agent": "planner", "task": "Plan a refactor from this context: {previous}" }] }`

Subagent calls stream progress, propagate cancellation, report token and cost usage, and retain failure diagnostics. Parallel model-visible output is capped at 50 KiB per task; complete output remains in tool details.

Optional workflow prompt templates are shipped under `examples/extensions/subagent/prompts` in the package.
