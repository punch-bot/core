# Subagents

Delegate tasks to specialized subagents with isolated context windows.

The `subagent` tool is built into Punch. The files in this directory provide the bundled agent definitions and optional workflow prompt templates.

## Features

- **Isolated context**: Each subagent runs in a separate `pi` process, or over A2A when `a2aUrl` is configured
- **Streaming output**: See tool calls and progress as they happen
- **Parallel streaming**: All parallel tasks stream updates simultaneously
- **Markdown rendering**: Final output rendered with proper formatting (expanded view)
- **Usage display**: Shows turns, tokens, cost, and context usage inside each subagent result
- **Abort support**: Ctrl+C propagates to kill subagent processes

## Structure

```
subagent/
├── README.md            # This file
├── agents/              # Sample agent definitions
│   ├── scout.md         # Fast recon, returns compressed context
│   ├── planner.md       # Creates implementation plans
│   ├── reviewer.md      # Code review
│   └── worker.md        # General-purpose (full capabilities)
└── prompts/             # Workflow presets (prompt templates)
    ├── implement.md     # scout -> planner -> worker
    ├── scout-and-plan.md    # scout -> planner (no implementation)
    └── implement-and-review.md  # worker -> reviewer -> worker
```

## Workflow prompt installation

The tool and the `scout`, `planner`, `reviewer`, and `worker` agents require no installation. To add the optional workflow prompts to your user configuration, copy them from the installed package:

```bash
mkdir -p ~/.pi/agent/prompts
cp node_modules/@punch-bot/cli/examples/extensions/subagent/prompts/*.md ~/.pi/agent/prompts/
```

## Security Model

This tool executes a separate `pi` subprocess with a delegated system prompt and tool/model configuration.

**Project-local agents** (`.pi/agents/*.md`) are repo-controlled prompts that can instruct the model to read files, run bash commands, etc.

**Default behavior:** Loads bundled agents and **user-level agents** from `~/.pi/agent/agents`. User definitions override bundled definitions with the same name.

To enable project-local agents, pass `agentScope: "both"` (or `"project"`). Only do this for repositories you trust.

Project-local agents from the session's trusted project run without asking. Agents from any other project, including one a task `cwd` points into, need the user's confirmation in a UI; in print, JSON, or RPC mode without a UI they are refused. Trust the project to run its agents headless.

## Usage

### Single agent
```
Use scout to find all authentication code
```

### Parallel execution
```
Run 2 scouts in parallel: one to find models, one to find providers
```

### Chained workflow
```
Use a chain: first have scout find the read tool, then have planner suggest improvements
```

### Workflow prompts
```
/implement add Redis caching to the session store
/scout-and-plan refactor auth to support OAuth
/implement-and-review add input validation to API endpoints
```

## Tool Modes

| Mode | Parameter | Description |
|------|-----------|-------------|
| Single | `{ agent, task }` | One agent, one task |
| Parallel | `{ tasks: [...] }` | Multiple agents run concurrently (max 8, 4 concurrent) |
| Chain | `{ chain: [...] }` | Sequential with `{previous}` placeholder |

## Output Display

**Collapsed view** (default):
- Status icon (✓/✗/⏳) and agent name
- Last 5-10 items (tool calls and text)
- Usage stats: `3 turns ↑input ↓output RcacheRead WcacheWrite $cost ctx:contextTokens model`

**Expanded view** (Ctrl+O):
- Full task text
- All tool calls with formatted arguments
- Final output rendered as Markdown
- Per-task usage (for chain/parallel)

**Parallel mode streaming**:
- Shows all tasks with live status (⏳ running, ✓ done, ✗ failed)
- Updates as each task makes progress
- Distinguishes pending, running, completed, failed, and aborted tasks
- Returns each completed task summary to the parent model with its own 50 KB limit
- Returns failure diagnostics from stderr/error messages when a child exits before producing output

**Tool call formatting** (mimics built-in tools):
- `$ command` for bash
- `read ~/path:1-10` for read
- `grep /pattern/ in ~/path` for grep
- etc.

## Agent Definitions

Agents are markdown files with YAML frontmatter:

```markdown
---
name: my-agent
description: What this agent does
tools: read, grep, find, ls
model: claude-haiku-4-5
a2aUrl: http://127.0.0.1:41241
---

System prompt for the agent goes here.
```

When `a2aUrl` is set, the subagent delegates to an external A2A agent (for example Hermes) instead of spawning a local `pi` subprocess.

When `model` is omitted, the subagent inherits the dispatching session's active model and thinking level.

**Locations:**
- Bundled `scout`, `planner`, `reviewer`, and `worker` definitions
- `~/.pi/agent/agents/*.md` - User-level (with `agentScope: "user"` or `"both"`)
- `.pi/agents/*.md` - Project-level (only with `agentScope: "project"` or `"both"`)

User agents override bundled agents. Project agents override both with the same name when their scope is enabled.

## Sample Agents

| Agent | Purpose | Model | Tools |
|-------|---------|-------|-------|
| `scout` | Fast codebase recon | Haiku | read, grep, find, ls, bash |
| `planner` | Implementation plans | Sonnet | read, grep, find, ls |
| `reviewer` | Code review | Sonnet | read, grep, find, ls, bash |
| `worker` | General-purpose | Sonnet | (all default) |

## Workflow Prompts

| Prompt | Flow |
|--------|------|
| `/implement <query>` | scout → planner → worker |
| `/scout-and-plan <query>` | scout → planner |
| `/implement-and-review <query>` | worker → reviewer → worker |

## Error Handling

- **Exit code != 0 or signal termination**: Tool returns an error with preserved stderr/output
- **Spawn errors**: Tool returns the spawn diagnostic
- **stopReason "error"**: LLM error is propagated with its error message
- **Abort**: Ctrl+C sends SIGTERM, escalates to SIGKILL after five seconds if needed, and preserves partial details/usage
- **Chain mode**: Stops at the first failing step and reports which step failed

## Limitations

- Output truncated to last 10 items in collapsed view (expand to see all)
- Single and chain output is capped at 50 KB/2,000 lines; full results remain in tool details
- Parallel output keeps a separate 50 KB budget per task, allowing up to roughly 400 KB across eight tasks
- Child usage is displayed in tool details but is not added to the calling session's usage totals
- Agents are snapshotted from each task's effective cwd when the tool invocation starts; relative task cwd values resolve from the session cwd
- Parallel mode limited to 8 tasks, 4 concurrent
