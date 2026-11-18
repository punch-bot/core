# Slash commands

Pi has no built-in slash commands. A prompt that starts with `/` runs a command only when its name matches a command added by a loaded resource:

| Resource | Command | Reference |
|---|---|---|
| Extension | `/name`, registered with `pi.registerCommand()` | [Extensions](extensions.md) |
| Prompt template | `/name`, from the template's filename | [Prompt Templates](prompt-templates.md) |
| Skill | `/skill:name` | [Skills](skills.md) |

Pi checks extension commands first, then skills, then prompt templates. A prompt such as `/model` that matches none of them is sent to the model as plain text.

Send commands as prompts in any mode:

```bash
pi -p "/review concurrency"
pi -p "/skill:pdf-tools extract report.pdf"
```

In RPC mode, send them through the [`prompt`](rpc-commands.md#prompt) command. [`get_commands`](rpc-commands.md#get_commands) lists the commands loaded in the current session.

## Commands from built-in extensions

| Command | Extension | Description |
|---|---|---|
| `/mcp` | `builtin:mcp` | Show MCP server status. `/mcp login <server>`, `/mcp logout <server>`, and `/mcp reconnect <server>` perform those actions. See [MCP Servers](mcp.md). |
| `/llama` | `builtin:llama.cpp` | Load, unload, and download models on the configured llama.cpp router through extension dialogs. Use it over RPC, whose client shows the dialogs. See [Run Local Models](llama-cpp.md). |

## Replacements for upstream pi commands

Upstream pi's terminal UI provides built-in commands such as `/model` and `/tree`. In Pi, use these options, RPC commands, or extension APIs instead:

| Upstream command | CLI | RPC command | Extension API |
|---|---|---|---|
| `/model` | `--model` | `set_model`, `cycle_model` | `pi.setModel()` |
| `/thinking` | `--thinking` | `set_thinking_level`, `cycle_thinking_level` | `pi.setThinkingLevel()` |
| `/scoped-models` | `--models`, `enabledModels` setting | | `ctx.scopedModels` |
| `/login`, `/logout` | `pi auth login`, `pi auth logout` | | |
| `/settings` | Edit [`settings.json`](settings.md) | | |
| `/new` | | `new_session` | `ctx.newSession()` |
| `/resume` | `--continue`, `--session` | `switch_session` | `ctx.switchSession()` |
| `/name` | `--name` | `set_session_name` | `pi.setSessionName()` |
| `/session` | | `get_state`, `get_session_stats` | |
| `/tree` | | `get_tree` | `ctx.navigateTree()` |
| `/fork` | `--fork` | `fork` | `ctx.fork()` |
| `/clone` | | `clone` | `ctx.fork(entryId, { position: "at" })` |
| `/compact` | | `compact` | `ctx.compact()` |
| `/copy` | | `get_last_assistant_text` | |
| `/export` | `--export` | `export_html` | |
| `/reload` | Restart Pi | | `ctx.reload()` |

See [RPC Commands](rpc-commands.md) for each command's fields.
