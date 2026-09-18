<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://www.npmjs.com/package/@punch-bot/cli"><img alt="npm" src="https://img.shields.io/npm/v/@punch-bot/cli?style=flat-square" /></a>
</p>

> New issues and PRs from new contributors are auto-closed by default. Maintainers review auto-closed issues daily. See [CONTRIBUTING.md](../../CONTRIBUTING.md).

---

Pi is a minimal terminal coding harness. Adapt pi to your workflows, not the other way around, without having to fork and modify pi internals. Extend it with TypeScript [Extensions](#extensions), [Skills](#skills), [Prompt Templates](#prompt-templates), and [Themes](#themes). Put your extensions, skills, prompt templates, and themes in [Pi Packages](#pi-packages) and share them with others via npm or git.

Pi ships with powerful defaults but skips features like sub agents and plan mode. Instead, you can ask pi to build what you want or install a third party pi package that matches your workflow.

Pi runs in print or JSON, RPC for process integration, and an SDK for embedding in your own apps. Interactive TUI mode has been removed.

## Share your OSS coding agent sessions

If you use pi for open source work, please share your coding agent sessions.

Public OSS session data helps improve models, prompts, tools, and evaluations using real development workflows.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `pi-mono` sessions.

I regularly publish my own `pi-mono` work sessions here:

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## Table of Contents

- [Quick Start](#quick-start)
- [Providers & Models](#providers--models)
- [Headless modes](#headless-modes)
  - [Commands](#commands)
- [Sessions](#sessions)
  - [Branching](#branching)
  - [Compaction](#compaction)
- [Settings](#settings)
- [Context Files](#context-files)
- [Customization](#customization)
  - [Prompt Templates](#prompt-templates)
  - [Skills](#skills)
  - [Extensions](#extensions)
  - [Themes](#themes)
  - [Pi Packages](#pi-packages)
- [Programmatic Usage](#programmatic-usage)
- [Philosophy](#philosophy)
- [CLI Reference](#cli-reference)

---

## Quick Start

```bash
npm install -g --ignore-scripts @punch-bot/cli
```

`--ignore-scripts` disables dependency lifecycle scripts during install. Pi does not require install scripts for normal npm installs.

Installer alternative:

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

Authenticate with an API key, then run in print mode:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pi -p "Say hello"
```

For process integration, use RPC (`pi --mode rpc` or `rpc-entry`). Extension commands, skill commands, and prompt templates can be sent as prompts, and the host answers `ctx.ui` dialogs. Built-in actions use dedicated RPC commands. See [docs/rpc.md](docs/rpc.md).

To embed pi in your own app, use the SDK (`createAgentSession`). See [Programmatic Usage](#programmatic-usage).

By default, pi gives the model four tools: `read`, `write`, `edit`, and `bash`. The model uses these to fulfill your requests. Add capabilities via [skills](#skills), [prompt templates](#prompt-templates), [extensions](#extensions), or [pi packages](#pi-packages).

**Platform notes:** [Windows](docs/windows.md) | [Termux (Android)](docs/termux.md) | [tmux](docs/tmux.md) | [Terminal setup](docs/terminal-setup.md) | [Shell aliases](docs/shell-aliases.md)

---

## Providers & Models

For each built-in provider, pi maintains a list of tool-capable models. Configured provider catalogs refresh automatically; run `pi update --models` to force an immediate refresh. Authenticate with an API key or preconfigured subscription credentials, then select a model with `--provider` and `--model`, the RPC `set_model` command, or the SDK.

**Subscriptions:**
- Anthropic Claude Pro/Max
- OpenAI ChatGPT Plus/Pro (Codex)
- GitHub Copilot

**API keys:**
- Anthropic
- Ant Ling
- OpenAI
- Azure OpenAI
- DeepSeek
- NVIDIA NIM
- Google Gemini
- Google Vertex
- Amazon Bedrock
- Mistral
- Groq
- Cerebras
- Cloudflare AI Gateway
- Cloudflare Workers AI
- xAI
- OpenRouter
- Vercel AI Gateway
- ZAI Coding Plan (Global)
- ZAI Coding Plan (China)
- OpenCode Zen
- OpenCode Go
- Hugging Face
- Fireworks
- Together AI
- Baseten
- Kimi For Coding
- MiniMax
- Xiaomi MiMo
- Xiaomi MiMo Token Plan (China)
- Xiaomi MiMo Token Plan (Amsterdam)
- Xiaomi MiMo Token Plan (Singapore)

Pi also supports the llama.cpp router server. Configure it with environment variables, manage downloads and loaded models with the `/llama` extension command, then select a loaded model through CLI, RPC, or SDK model selection. See [docs/llama-cpp.md](docs/llama-cpp.md) for setup and usage.

See [docs/providers.md](docs/providers.md) for other provider setup instructions.

**Custom providers & models:** Add providers via `~/.pi/agent/models.json` if they speak a supported API (OpenAI, Anthropic, Google). For custom APIs or OAuth, use extensions. See [docs/models.md](docs/models.md) and [docs/custom-provider.md](docs/custom-provider.md).

---

## Headless modes

Interactive TUI mode has been removed. Use print (`-p`), JSON (`--mode json`), RPC (`--mode rpc` / `rpc-entry`), or the SDK.

Extension commands, skill commands, prompt templates, and extension UI dialogs work over RPC. Built-in actions use dedicated RPC commands.

### Commands

Send extension commands as prompts over RPC or in print mode. [Skills](#skills) are available as `/skill:name`, and [prompt templates](#prompt-templates) expand via `/templatename`. Built-in TUI slash commands are not handled in headless modes. RPC exposes model, session, compaction, export, and other operations as JSON commands; see [RPC mode](docs/rpc.md).

---

## Sessions

Sessions are stored as JSONL files with a tree structure. Each entry has an `id` and `parentId`, enabling in-place branching without creating new files. See [docs/session-format.md](docs/session-format.md) for file format.

### Management

Sessions auto-save to `~/.pi/agent/sessions/` organized by working directory.

```bash
pi -c                  # Continue most recent session
pi -r                  # Continue most recent session
pi --no-session        # Ephemeral mode (don't save)
pi --name "my task"    # Set session display name at startup
pi --session <path|id> # Use specific session file or ID
pi --fork <path|id>    # Fork specific session file or ID into a new session
```

Use the RPC `get_state` command to read the current session ID before reusing it with `--session <id>` or `--fork <id>`.

### Branching

RPC clients can inspect the append-only session tree with `get_tree`. Use `fork` with a selected entry ID to create a session from an earlier user message, or `clone` to duplicate the active branch at its current position.

**`--fork <path|id>`** - Fork an existing session file or partial session UUID directly from the CLI. This copies the full source session into a new session file in the current project.

### Compaction

Long sessions can exhaust context windows. Compaction summarizes older messages while keeping recent ones.

**Manual:** Send the RPC `compact` command, optionally with `customInstructions`, or call `session.compact()` through the SDK.

**Automatic:** Enabled by default. Triggers on context overflow (recovers and retries) or when approaching the limit (proactive). Configure it in `settings.json` or with the RPC `set_auto_compaction` command.

Compaction is lossy. The full history remains in the JSONL file and is available through RPC tree and entry commands. Customize compaction behavior via [extensions](#extensions). See [docs/compaction.md](docs/compaction.md) for internals.

---

## Settings

Edit settings files directly:

| Location | Scope |
|----------|-------|
| `~/.pi/agent/settings.json` | Global (all projects) |
| `.pi/settings.json` | Project (overrides global) |

See [docs/settings.md](docs/settings.md) for all options.

### Project Trust

Trusting a project allows pi to load `.pi/settings.json` and `.pi` resources, install missing project packages, and execute project extensions.

Before the trust decision, pi loads only context files, user/global extensions, and CLI `-e` extensions so they can handle the `project_trust` event. Project-local extensions, project package-managed extensions, and project settings are loaded only after the project is trusted. This split also applies when switching to a session from a different cwd whose trust has not been resolved in the current process.

Non-interactive modes (`-p`, `--mode json`, and `--mode rpc`) do not show a trust prompt. Without an applicable saved trust decision, they use `defaultProjectTrust` from global settings: `ask` (default) and `never` ignore those project resources, while `always` trusts them. Pass `--approve`/`-a` or `--no-approve`/`-na` to override project trust for one run.

If no extension or saved decision applies, `defaultProjectTrust` controls the fallback behavior. Set it to `"ask"`, `"always"`, or `"never"` in `~/.pi/agent/settings.json`.

`pi config` and package commands use the same project trust flow, except `pi update` never prompts. Pass `--approve` to trust project-local settings for one command or `--no-approve` to ignore them.

### Telemetry and update checks

Pi has two separate startup features:

- **Update check:** fetches `https://pi.dev/api/latest-version` to check whether a newer Pi version exists. Disable it with `PI_SKIP_VERSION_CHECK=1`. Disabling update checks only turns off this check.
- **Install/update telemetry:** after first install or a changelog-detected update, sends an anonymous version ping to `https://pi.dev/api/report-install`. This setting also controls optional provider attribution headers for OpenRouter, Cloudflare, and direct NVIDIA NIM requests. Opt out by setting `enableInstallTelemetry` to `false` in `settings.json`, or by setting `PI_TELEMETRY=0`. This does not disable update checks; Pi may still contact `pi.dev` for the latest version unless update checks are disabled or offline mode is enabled.

Use `--offline` or `PI_OFFLINE=1` to disable all startup network operations described here, including update checks, package update checks, and install/update telemetry.

---

## Context Files

Pi loads `AGENTS.md` (or `CLAUDE.md`) at startup from:
- `~/.pi/agent/AGENTS.md` (global)
- Parent directories (walking up from cwd)
- Current directory

If a directory contains `AGENTS.override.md`, Pi loads it instead of `AGENTS.md` or `CLAUDE.md` from that directory. Context files from other directories are still concatenated.

Use for project instructions (`AGENTS.md`/`CLAUDE.md`), conventions, common commands. All matching files are concatenated.

Disable context file loading with `--no-context-files` (or `-nc`).

### System Prompt

Replace the default system prompt with `.pi/SYSTEM.md` (project) or `~/.pi/agent/SYSTEM.md` (global). Append without replacing via `APPEND_SYSTEM.md`.

---

## Customization

### Prompt Templates

Reusable prompts as Markdown files. Send `/name` as a prompt to expand one.

```markdown
<!-- ~/.pi/agent/prompts/review.md -->
Review this code for bugs, security issues, and performance problems.
Focus on: {{focus}}
```

Place in `~/.pi/agent/prompts/`, `.pi/prompts/`, or a [pi package](#pi-packages) to share with others. See [docs/prompt-templates.md](docs/prompt-templates.md).

### Skills

On-demand capability packages following the [Agent Skills standard](https://agentskills.io). Invoke via `/skill:name` or let the agent load them automatically.

```markdown
<!-- ~/.pi/agent/skills/my-skill/SKILL.md -->
# My Skill
Use this skill when the user asks about X.

## Steps
1. Do this
2. Then that
```

Place in `~/.pi/agent/skills/`, `~/.agents/skills/`, `.pi/skills/`, or `.agents/skills/` (from `cwd` up through parent directories) or a [pi package](#pi-packages) to share with others. See [docs/skills.md](docs/skills.md).

### Extensions

<p align="center"><img src="docs/images/doom-extension.png" alt="Doom Extension" width="600"></p>

TypeScript modules that extend pi with custom tools, commands, event handlers, dialogs, and provider integrations.

```typescript
export default function (pi: ExtensionAPI) {
  pi.registerTool({ name: "deploy", ... });
  pi.registerCommand("stats", { ... });
  pi.on("tool_call", async (event, ctx) => { ... });
}
```

The default export can also be `async`. pi waits for async extension factories before startup continues, which is useful for one-time initialization such as fetching remote model lists before calling `pi.registerProvider()`.

**What's possible:**
- Custom tools (or replace built-in tools entirely)
- Sub-agents and plan mode
- Custom compaction and summarization
- Permission gates and path protection
- RPC-backed dialogs and notifications
- Git checkpointing and auto-commit
- SSH and sandbox execution
- MCP server integration
- ...anything you can dream up

Place in `~/.pi/agent/extensions/`, `.pi/extensions/`, or a [pi package](#pi-packages) to share with others. See [docs/extensions.md](docs/extensions.md) and [examples/extensions/](examples/extensions/).

### Themes

Built-in: `dark`, `light`. Themes hot-reload: modify the active theme file and pi immediately applies changes.

Place in `~/.pi/agent/themes/`, `.pi/themes/`, or a [pi package](#pi-packages) to share with others. See [docs/themes.md](docs/themes.md).

### Pi Packages

Bundle and share extensions, skills, prompts, and themes via npm or git. Find packages on [npmjs.com](https://www.npmjs.com/search?q=keywords%3Api-package) or [Discord](https://discord.com/channels/1456806362351669492/1457744485428629628).

> **Security:** Pi packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform any action including running executables. Review source code before installing third-party packages.

```bash
pi install npm:@foo/pi-tools
pi install npm:@foo/pi-tools@1.2.3      # pinned version
pi install git:github.com/user/repo
pi install git:github.com/user/repo@v1  # tag or commit
pi install git:git@github.com:user/repo
pi install git:git@github.com:user/repo@v1  # tag or commit
pi install https://github.com/user/repo
pi install https://github.com/user/repo@v1      # tag or commit
pi install ssh://git@github.com/user/repo
pi install ssh://git@github.com/user/repo@v1    # tag or commit
pi remove npm:@foo/pi-tools
pi uninstall npm:@foo/pi-tools          # alias for remove
pi list
pi update                               # update pi only
pi update --all                         # update pi and packages
pi update --extensions                  # update packages only
pi update --models                      # refresh model catalogs only
pi update --self                        # update pi only
pi update --self --force                # reinstall pi even if current
pi update npm:@foo/pi-tools             # update one package
pi config                               # enable/disable extensions, skills, prompts, themes
```

Packages install to `~/.pi/agent/git/` (git) or `~/.pi/agent/npm/` (npm). Use `-l` for project-local installs (`.pi/git/`, `.pi/npm/`). Git `@ref` values are pinned tags or commits; pinned packages are skipped by `pi update --extensions` and `pi update --all`, so use `pi install git:host/user/repo@new-ref` to move an existing package to a new ref. Git packages install dependencies with `npm install --omit=dev` by default, so runtime deps must be listed under `dependencies`; when `npmCommand` is configured, git packages use plain `install` for compatibility with wrappers. If you use a Node version manager and want package installs to reuse a stable npm context, set `npmCommand` in `settings.json`, for example `["mise", "exec", "node@20", "--", "npm"]`.

Create a package by adding a `pi` key to `package.json`:

```json
{
  "name": "my-pi-package",
  "keywords": ["pi-package"],
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Without a `pi` manifest, pi auto-discovers from conventional directories (`extensions/`, `skills/`, `prompts/`, `themes/`).

See [docs/packages.md](docs/packages.md).

---

## Programmatic Usage

### SDK

```typescript
import { createAgentSession, ModelRuntime, SessionManager } from "@punch-bot/cli";

const modelRuntime = await ModelRuntime.create();
const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
  modelRuntime,
});

await session.prompt("What files are in the current directory?");
```

For advanced multi-session runtime replacement, use `createAgentSessionRuntime()` and `AgentSessionRuntime`.

See [docs/sdk.md](docs/sdk.md) and [examples/sdk/](examples/sdk/).

### RPC Mode

For non-Node.js integrations, use RPC mode over stdin/stdout:

```bash
pi --mode rpc
```

RPC mode uses strict LF-delimited JSONL framing. Clients must split records on `\n` only. Do not use generic line readers like Node `readline`, which also split on Unicode separators inside JSON payloads.

See [docs/rpc.md](docs/rpc.md) for the protocol.

---

## Philosophy

Pi is aggressively extensible so it doesn't have to dictate your workflow. Features that other tools bake in can be built with [extensions](#extensions), [skills](#skills), or installed from third-party [pi packages](#pi-packages). This keeps the core minimal while letting you shape pi to fit how you work.

**No MCP.** Build CLI tools with READMEs (see [Skills](#skills)), or build an extension that adds MCP support. [Why?](https://mariozechner.at/posts/2025-11-02-what-if-you-dont-need-mcp/)

**No sub-agents.** There's many ways to do this. Spawn pi instances via tmux, or build your own with [extensions](#extensions), or install a package that does it your way.

**No permission popups.** Run in a container, or build your own confirmation flow with [extensions](#extensions) inline with your environment and security requirements.

**No plan mode.** Write plans to files, or build it with [extensions](#extensions), or install a package.

**No built-in to-dos.** They confuse models. Use a TODO.md file, or build your own with [extensions](#extensions).

**No background bash.** Use tmux. Full observability, direct interaction.

Read the [blog post](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/) for the full rationale.

---

## CLI Reference

```bash
pi [options] [--] [@files...] [messages...]
```

### Package Commands

```bash
pi install <source> [-l]     # Install package, -l for project-local
pi remove <source> [-l]      # Remove package
pi uninstall <source> [-l]   # Alias for remove
pi update [source|self|pi]   # Update pi only, or one package source
pi update --all              # Update pi and packages
pi update --extensions       # Update packages only
pi update --models           # Refresh model catalogs only
pi update --self             # Update pi only
pi update --self --force     # Reinstall pi even if current
pi update --extension <src>  # Update one package
pi list                      # List installed packages
pi config                    # Enable/disable package resources
```

`pi config` and project package commands accept `--approve`/`--no-approve` to trust or ignore project-local settings for one command. `pi update` never prompts for project trust.

### Modes

| Flag | Description |
|------|-------------|
| (default) / `-p`, `--print` | Print response and exit |
| `--mode json` | Output all events as JSON lines (see [docs/json.md](docs/json.md)) |
| `--mode rpc` | RPC mode for process integration (see [docs/rpc.md](docs/rpc.md)) |
| `--export <in> [out]` | Export session to HTML |

In print mode, pi also reads piped stdin and merges it into the initial prompt:

```bash
cat README.md | pi -p "Summarize this text"
```

### Model Options

| Option | Description |
|--------|-------------|
| `--provider <name>` | Provider (anthropic, openai, google, etc.) |
| `--model <pattern>` | Model pattern or ID (supports `provider/id` and optional `:<thinking>`) |
| `--api-key <key>` | API key (overrides env vars) |
| `--thinking <level>` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `--models <patterns>` | Comma-separated model patterns available to the session |
| `--list-models [search]` | List available models |

### Session Options

| Option | Description |
|--------|-------------|
| `-c`, `--continue` | Continue most recent session |
| `-r`, `--resume` | Continue most recent session |
| `--session <path\|id>` | Use specific session file or partial UUID |
| `--fork <path\|id>` | Fork specific session file or partial UUID into a new session |
| `--session-dir <dir>` | Custom session storage directory |
| `--no-session` | Ephemeral mode (don't save) |
| `--name <name>`, `-n <name>` | Set session display name at startup |

### Tool Options

| Option | Description |
|--------|-------------|
| `--tools <list>`, `-t <list>` | Allowlist specific tool names across built-in, extension, and custom tools |
| `--exclude-tools <list>`, `-xt <list>` | Disable specific tool names across built-in, extension, and custom tools |
| `--no-builtin-tools`, `-nbt` | Disable built-in tools by default but keep extension/custom tools enabled |
| `--no-tools`, `-nt` | Disable all tools by default |

Available built-in tools: `read`, `bash`, `powershell` (Windows), `edit`, `write`, `grep`, `find`, `ls`

### Resource Options

| Option | Description |
|--------|-------------|
| `-e`, `--extension <source>` | Load extension from path, npm, or git (repeatable) |
| `--no-extensions` | Disable extension discovery |
| `--skill <path>` | Load skill (repeatable) |
| `--no-skills` | Disable skill discovery |
| `--prompt-template <path>` | Load prompt template (repeatable) |
| `--no-prompt-templates` | Disable prompt template discovery |
| `--theme <path>` | Load theme (repeatable) |
| `--no-themes` | Disable theme discovery |
| `--no-context-files`, `-nc` | Disable AGENTS.md and CLAUDE.md context file discovery |

Combine `--no-*` with explicit flags to load exactly what you need, ignoring settings.json (e.g., `--no-extensions -e ./my-ext.ts`).

### Other Options

| Option | Description |
|--------|-------------|
| `--system-prompt <text>` | Replace default prompt (context files and skills still appended) |
| `--append-system-prompt <text>` | Append to system prompt |
| `--use-theme <name[/name]>` | Set the theme for this run without changing settings |
| `--verbose` | Force verbose startup |
| `-a`, `--approve` | Trust project-local files for this run |
| `-na`, `--no-approve` | Ignore project-local files for this run |
| `--` | Stop option parsing; remaining arguments are prompts or `@file` inputs |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

### File Arguments

Prefix files with `@` to include in the message:

```bash
pi @prompt.md "Answer this"
pi -p @screenshot.png "What's in this image?"
pi @code.ts @test.ts "Review these files"
```

### Examples

```bash
# Print mode
pi -p "List all .ts files in src/"

# Print mode
pi -p "Summarize this codebase"

# Prompt beginning with a dash
pi -p -- "- Summarize these points"

# Non-interactive with piped stdin
cat README.md | pi -p "Summarize this text"

# Named one-shot session
pi --name "release audit" -p "Audit this repository"

# Different model
pi --provider openai --model gpt-4o "Help me refactor"

# Model with provider prefix (no --provider needed)
pi --model openai/gpt-4o "Help me refactor"

# Model with thinking level shorthand
pi --model sonnet:high "Solve this complex problem"

# Limit the models available to the session
pi --models "claude-*,gpt-4o"

# Read-only mode
pi --tools read,grep,find,ls -p "Review the code"

# Disable one extension or built-in tool while keeping the rest available
pi --exclude-tools ask_question

# High thinking level
pi --thinking high "Solve this complex problem"
```

### Environment Variables

| Variable | Description |
|----------|-------------|
| `AI_AGENT` | Set to `pi` by the CLI and RPC entry points so generic tooling can attribute child processes to Pi |
| `PI_CODING_AGENT` | Set to `true` by the CLI and RPC entry points so child processes can detect that they run inside Pi |
| `PI_CODING_AGENT_DIR` | Override config directory (default: `~/.pi/agent`) |
| `PI_CODING_AGENT_SESSION_DIR` | Override session storage directory (overridden by `--session-dir`) |
| `PI_PACKAGE_DIR` | Override package directory (useful for Nix/Guix where store paths tokenize poorly) |
| `PI_OFFLINE` | Disable startup network operations, including update checks, package update checks, and install/update telemetry |
| `PI_SKIP_VERSION_CHECK` | Skip the Pi version update check at startup. This prevents the `pi.dev` latest-version request |
| `PI_TELEMETRY` | Override install/update telemetry and provider attribution headers. Use `1`/`true`/`yes` to enable or `0`/`false`/`no` to disable. This does not disable update checks |
| `PI_CACHE_RETENTION` | Set to `long` for extended prompt cache (Anthropic: 1h, OpenAI: 24h) |
| `VISUAL`, `EDITOR` | Fallback external editor for Ctrl+G when `externalEditor` is unset; defaults to Notepad on Windows and `nano` elsewhere |

Commands run by the LLM-callable `bash` and `powershell` tools also receive current session metadata:

| Variable | Description |
|----------|-------------|
| `PI_SESSION_ID` | Current session ID |
| `PI_SESSION_FILE` | Absolute session JSONL path; unset for ephemeral sessions |
| `PI_PROVIDER` | Currently selected model provider |
| `PI_MODEL` | Currently selected model ID |
| `PI_REASONING_LEVEL` | Current effective reasoning level |

These values are resolved when each command starts. See [Environment Variables](docs/environment-variables.md#shell-tool-session-environment) for semantics, examples, and custom-tool opt-out.

---

## Contributing & Development

See [CONTRIBUTING.md](../../CONTRIBUTING.md) for guidelines and [docs/development.md](docs/development.md) for setup, forking, and debugging.

## License

MIT

## See Also

- [@punch-bot/ai](https://www.npmjs.com/package/@punch-bot/ai): Core LLM toolkit
- [@punch-bot/agent](https://www.npmjs.com/package/@punch-bot/agent): Agent framework

<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>
