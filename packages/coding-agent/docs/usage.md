# Using Pi

This page collects day-to-day usage details that do not fit on the quickstart page. Pi runs headless: it has no terminal UI, editor, or keyboard shortcuts. Every run uses one of these interfaces:

| Interface | Start it with | Use it when |
|---|---|---|
| Print mode | `pi -p "<prompt>"`, or `pi "<prompt>"` | You want the final answer as text and Pi should exit |
| JSON mode | `pi --mode json "<prompt>"` | A script consumes every event of one run; see [JSON Event Stream](json.md) |
| RPC mode | `pi --mode rpc` | A client drives a long-running Pi process; see [RPC Protocol](rpc.md) |
| SDK | `createAgentSession()` | An application runs Pi in process; see [SDK](sdk.md) |

Run `pi` from the folder you want to work in. Pi uses that folder to discover files, instructions, and configuration, and to group saved sessions. If you have not installed Pi or chosen a model yet, follow the [Quickstart](quickstart.md).

## Give Pi a task

```bash
pi -p "List all .ts files in src/"
pi -p @prompt.md @screenshot.png "What does this screenshot show?"
git diff | pi -p "Review this change"
pi -p "Write the plan to plan.md" "Now implement the first step"
```

`@path` includes a text file or image in the first prompt. Piped stdin is prepended to the first prompt. Each further message argument is sent as another prompt after the previous run ends. Use `--` before a prompt that starts with `-`. See [Command Line](cli.md#invocation-and-output) for the exact rules.

## Run commands

A prompt that starts with `/` runs an extension command, a skill (`/skill:name`), or a prompt template. Pi has no built-in slash commands; text such as `/model` reaches the model unchanged. See [Slash Commands](slash-commands.md) for the commands that exist and the replacements for upstream pi's built-in commands.

RPC clients can run a shell command and add its output to the conversation with the [`bash`](rpc-commands.md#bash) command. Set `excludeFromContext` to keep the output out of model context.

## Change direction

RPC clients can send more input while Pi is working:

- [`steer`](rpc-commands.md#steer) queues a message that is delivered after the current assistant turn finishes its tool calls.
- [`follow_up`](rpc-commands.md#follow_up) queues a message that waits until Pi finishes the current task.
- [`abort`](rpc-commands.md#abort) stops the current run. Queued messages stay queued; send [`clear_queue`](rpc-commands.md#clear_queue) first to take them back.

`steeringMode` and `followUpMode` in [Settings](settings.md#interaction) control whether queued messages are delivered one at a time or together.

## Change the model or settings

```bash
pi --model sonnet:high -p "Solve this complex problem"
pi --provider openai --model gpt-4o -p "Help me refactor"
pi --models "claude-*,gpt-4o" --mode rpc
```

RPC clients change the model with [`set_model`](rpc-commands.md#set_model) and the thinking level with [`set_thinking_level`](rpc-commands.md#set_thinking_level). Log in to providers with `pi auth login <provider>`. Edit [`settings.json`](settings.md) for saved preferences. See [Choose a Model](models.md) and [Configuration](configuration.md).

## Sessions

Sessions are saved automatically to `~/.pi/agent/sessions/`, organized by working directory.

```bash
pi -c -p "What did we discuss?"   # Continue the most recent session
pi --no-session -p "One-off task" # Ephemeral; do not save
pi --name "my task" -p "Start"    # Set the session display name
pi --session <path|id> -p "Next"  # Use a specific session file or session ID
pi --fork <path|id> -p "Branch"   # Fork a session into a new session file
```

Useful RPC commands:

- `get_state` returns the current session file and ID.
- `get_tree` returns the in-file session tree.
- `fork` creates a new session from an earlier user message.
- `clone` duplicates the current active branch into a new session file.
- `compact` summarizes older messages to free context.

See [Sessions](sessions.md) and [Compaction](compaction.md) for details.

## Export a session

Use `pi --export <session> [output.html]` or the RPC [`export_html`](rpc-commands.md#export_html) command to write a session to HTML. Review exported sessions before sharing them: they can contain prompts, tool output, file contents, and credentials exposed during the conversation.

## Context files

Pi loads `AGENTS.md` or `CLAUDE.md` at startup from:

- `~/.pi/agent/AGENTS.md` for global instructions
- parent directories, walking up from the current working directory
- the current directory

If a directory contains `AGENTS.override.md`, Pi loads it instead of `AGENTS.md` or `CLAUDE.md` from that directory. Context files from other directories still layer normally.

Use context files for project conventions, commands, safety rules, and preferences. Disable loading with `--no-context-files` or `-nc`.

### System prompt files

Replace the opening of the default system prompt (Pi's persona and role) with:

- `.pi/SYSTEM.md` for a project
- `~/.pi/agent/SYSTEM.md` globally

The tool list and rules, including tool and extension guidelines, still follow the custom opening. Pi's documentation pointers are left out.

## Project trust

Trusting a project allows Pi to load `.pi/settings.json` and `.pi` resources, install missing project packages, and execute project extensions. See [Project trust](security.md#understand-project-trust).

Pi does not show a trust prompt. Without an applicable saved trust decision or extension, it uses `defaultProjectTrust` from global settings: `ask` (default) and `never` ignore project resources, while `always` trusts them. Pass `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run.

## Package commands

```bash
pi install <source> [-l]     # Install package, -l for project-local
pi remove <source> [-l]      # Remove package
pi uninstall <source> [-l]   # Alias for remove
pi update [source|self|pi]   # Update pi only, or one package source
pi update --all              # Update pi and packages; reconcile pinned git refs
pi update --extensions       # Update packages only; reconcile pinned git refs
pi update --models           # Refresh model catalogs only
pi list                      # List installed packages
pi config                    # Print resolved package resource paths as JSON
```

See [Pi Packages](packages.md) and [Command Line](cli.md#package-commands).
