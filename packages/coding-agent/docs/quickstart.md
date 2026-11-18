# Quickstart

Pi runs in your terminal and works with files on your machine. To use it, you need access to a model through a supported provider. This can be a subscription, an API key, or a local model.

For native Windows setup, read [Windows Setup](windows.md). For Android, read [Termux Setup](termux.md).

## 1. Install Pi

Install Pi from npm with the fork's generated shrinkwrap. This requires Node.js 22.19 or newer:

```bash
npm install -g --ignore-scripts @punch-bot/cli
```

Pi does not require dependency lifecycle scripts for a normal npm installation.

Verify the installation:

```bash
pi --version
```

## 2. Choose a model

A **model** generates Pi's responses. A **provider** is the service or account Pi uses to access that model.

Log in to a provider:

```bash
pi auth login anthropic
```

Pi signs in with an account in the browser, or asks for an API key when the provider has no account sign-in. Add `--api-key` to save an API key instead. You can also set the provider's environment variable, such as `ANTHROPIC_API_KEY`, without logging in.

Without `--model`, Pi uses the `defaultModel` [setting](settings.md) or a default model of an authenticated provider. Choose another model with `--model`, for example `pi --model sonnet:high`. Run `pi --list-models` to see the available models.

See [Choose a model and provider](models.md) for supported providers, environment-variable authentication, local models, and custom endpoints.

## 3. Give Pi a task

Change to the folder you want Pi to work with, then give it a task:

```bash
cd /path/to/folder
pi -p "Explain how this repository is structured and how to run its checks."
```

The working folder helps Pi discover relevant files, instructions, and configuration. Pi also uses it to group saved sessions.

Pi runs headless: print mode (`-p`) writes the final answer to stdout and exits. Use `--mode json` to stream every event, or `--mode rpc` to drive Pi from another program. See [Use Pi from the command line](usage.md).

Pi runs file reads, searches, commands, and edits without asking before each tool call. Include files with separate `@path` arguments:

```bash
pi -p @meeting-notes.md "Summarize these notes and save the action items to action-items.md."
pi -p @previous.csv @current.csv "Compare these files and summarize the important changes."
```

When Pi finishes, review its response and any changed files. Use version control or backups for important work. For untrusted or unattended work, use a container or another sandbox. See [Security](security.md).

## Continue later

Pi saves sessions automatically. Continue the most recent session for the same working folder with:

```bash
pi --continue -p "Now add tests for it."
```

Use `--session <path|id>` to open another saved session. See [Continue or branch a session](sessions.md) for session naming, branching, compaction, and export.

## Next steps

- [Use Pi from the command line](usage.md) to learn input, commands, and queued messages.
- [Add instructions](configuration.md#context-files) that Pi should follow whenever it works in a folder.
- [Choose a model and provider](models.md).

### Choose how to customize Pi

Start with the least powerful mechanism that meets your need:

| Need | Start with |
|---|---|
| Give Pi persistent instructions for a folder | [`AGENTS.md`](configuration.md#context-files) |
| Reuse a prompt as a `/` command | [Prompt template](prompt-templates.md) |
| Add task-specific instructions and supporting files | [Skill](skills.md) |
| Add executable tools, commands, or event handlers | [Extension](extensions.md) |
| Connect an unsupported model service | [Custom provider](custom-provider.md) |
| Install or distribute several resources | [Pi package](packages.md) |

## Uninstall Pi

Run:

```bash
npm uninstall -g @punch-bot/cli
```

This does not remove configuration, credentials, sessions, or installed Pi packages from `~/.pi/agent/`.
