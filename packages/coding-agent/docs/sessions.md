# Sessions and Context

Pi saves a conversation as a session. The active branch of that session supplies conversation history for the next model request. Use session options and RPC commands to continue work, explore another branch, or reduce the amount of history sent to the model.

## Continue or switch sessions

Pi saves sessions automatically unless you start it with `--no-session`.

```bash
pi --continue -p "What did we discuss?"
pi --session <path|id> -p "Continue with the next step"
```

`--continue` (or its alias `--resume`) opens the most recent session for the current directory. `--session` opens a session by file path or full or partial ID. RPC clients start a new session with [`new_session`](rpc-commands.md#new_session) and open another one with [`switch_session`](rpc-commands.md#switch_session); extensions use `ctx.newSession()` and `ctx.switchSession()`.

Each session records the working directory it was created in and never changes it. Pi runs a session in its working directory, so tools, `@path` references, project configuration, and context files resolve from there.

| Entry point | Working directory |
|---|---|
| `--continue` | The current directory |
| `--session`, RPC `switch_session` | The session's working directory. `--session` exits with an error when the session belongs to another directory and suggests `--fork`. |
| `--fork` | The current directory, in a new session |

If a session's working directory no longer exists, for example after the project folder was renamed, Pi exits with an error. Use `--fork` to copy the session into the current directory.

Use `--name`, the RPC [`set_session_name`](rpc-commands.md#set_session_name) command, or `pi.setSessionName()` to assign a recognizable session name. RPC [`get_session_stats`](rpc-commands.md#get_session_stats) returns the session file, ID, message count, token usage, and cost.

## Choose how to branch

Pi stores entries as a tree, so returning to an earlier point does not erase the branch you leave.

| Action | Result | Use it when |
|---|---|---|
| `ctx.navigateTree()` in an extension command | Moves within the current session file | Related alternatives should stay together |
| `--fork`, RPC [`fork`](rpc-commands.md#fork) | Creates a new session from an earlier user message | The alternative should become separate work |
| RPC [`clone`](rpc-commands.md#clone) | Copies the active branch into a new session | You want a separate copy of the current state |

RPC [`get_tree`](rpc-commands.md#get_tree) returns the tree, and [`get_fork_messages`](rpc-commands.md#get_fork_messages) lists the user messages `fork` accepts.

When `ctx.navigateTree()` leaves a branch with `summarize: true`, Pi summarizes it and attaches that summary to the branch it enters. This preserves relevant work from the abandoned path without including every message from it.

For the persisted tree and entry types, see [Session Format](session-format.md).

## Manage conversation context

The model receives the active branch, not every branch in the session file. Pi combines that history with the system prompt, discovered context files, available tools, and loaded skill descriptions. [How Pi Works](how-pi-works.md#context) describes how those inputs are assembled.

When the active context approaches the model's limit, Pi normally compacts older history automatically. Compaction adds a summary and keeps recent messages. It does not delete the original session entries. RPC `get_session_stats` reports current context usage.

Use the RPC [`compact`](rpc-commands.md#compact) command or `ctx.compact()` to compact manually. You can add instructions when the summary should preserve a particular topic or decision. Configure automatic compaction and retained history through [Settings](settings.md#compaction).

Compaction can fail if the provider is unavailable or cannot accept the summarization request. Correct the provider problem and compact again. Disabling automatic compaction does not disable manual compaction.

See [Compaction Reference](compaction.md) for thresholds, retained boundaries, branch-summary behavior, and extension hooks.

## Control session storage

By default, Pi stores sessions under `~/.pi/agent/sessions/`, grouped by working directory. Use `--session-dir`, `PI_CODING_AGENT_SESSION_DIR`, or the `sessionDir` setting to choose another location. The CLI option has highest precedence.

Use `--no-session` for an ephemeral run. An ephemeral session cannot be continued after Pi exits.

## Export a session

Use `pi --export <session> [output.html]` or the RPC [`export_html`](rpc-commands.md#export_html) command to write a session as HTML.

Review exported sessions before sharing them. They can contain prompts, model responses, tool arguments, command output, file contents, and extension messages.
