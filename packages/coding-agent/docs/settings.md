# Settings Reference

This reference lists user-configurable settings, their types, defaults, and purposes. Project settings override agent-directory settings. Resource lists are combined. See [Configuration](configuration.md) for file locations and trust behavior.

Add `"$schema": "https://raw.githubusercontent.com/punch-bot/core/main/packages/coding-agent/schemas/settings.schema.json"` to `settings.json` for editor validation and completion.

## Model and thinking

<a id="model-cycling"></a>

| Setting | Type | Default | Description |
|---|---|---|---|
| `defaultProvider` | string | Automatic | Startup AI provider. |
| `defaultModel` | string | Automatic | Startup model ID. |
| `defaultThinkingLevel` | `"off" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh" \| "max"` | `"medium"` | Startup thinking level. |
| `modelThinkingLevels` | object | None | Per-model startup thinking levels keyed by exact `provider/modelId`. |
| `thinkingBudgets` | object | Built-in budgets | Token budgets for `minimal`, `low`, `medium`, and `high` thinking levels. |
| `enabledModels` | `string[]` | All available models | Model patterns or globs used for startup selection and model cycling. Uses the same format as `--models`; stale entries are skipped with a warning. |
| `cacheWarming` | `"off" \| "streaming" \| "idle"` | `"idle"` | Keep eligible provider prompt caches warm during active runs and, with `"idle"`, for up to 30 minutes between runs. `"streaming"` warms only during active runs. Global setting only. |

Cache warming runs only when the model declares a cache lifetime and Pi estimates at least $0.05 in avoided cache-miss cost. Refresh usage counts toward session totals but does not enter model context. Extensions can override the decision with `cache_warming_decision`. See [Prompt Cache Lifetimes](models.md#prompt-cache-lifetimes).

See [Choose a Model](models.md) for model selection and thinking controls.

## Interaction

| Setting | Type | Default | Description |
|---|---|---|---|
| `steeringMode` | `"all" \| "one-at-a-time"` | `"one-at-a-time"` | How queued steering messages are delivered. |
| `followUpMode` | `"all" \| "one-at-a-time"` | `"one-at-a-time"` | How queued follow-up messages are delivered. |
| `defaultProjectTrust` | `"ask" \| "always" \| "never"` | `"ask"` | Fallback project-trust behavior. **Can only be set in agent-directory settings.** |

## Tools

| Setting | Type | Default | Description |
|---|---|---|---|
| `defaultTools` | `string[]` | `read`, `bash`, `edit`, `write` | Tools enabled at startup. Plain names replace the defaults; `+name` adds a tool and `-name` removes one. An empty array disables all built-in tools but not extension or SDK tools. |
| `codemode.mode` | `"on"` \| `"only"` | `"on"` | How the `codemode` tool presents tools while it is active. `on`: declared tools get a note on calling them from scripts appended to their description, and `codemode` lists only tools that are not declared. `only`: `codemode` lists every tool scripts can call, and active built-in and extension tools are hidden from the model, so it reaches them through `codemode`. |
| `codemode.inlineBudget` | number | `3000` | Estimated tokens (characters / 4) the `codemode` tool's description may spend on tool declarations. Tools that do not fit are left out and found with `searchTools()`. `0` lists only namespaces. |

Available built-in tools are `read`, `bash`, `powershell`, `edit`, `write`, `grep`, `find`, and `ls`. `defaultTools` can also name `codemode` and `tool_search`, which built-in extensions register inactive, and other extension tools registered inactive.

A list of only `+name` and `-name` entries changes the inherited selection instead of replacing it. For example, this enables `codemode` next to the default tools:

```json
{
  "defaultTools": ["+codemode"]
}
```

This replaces `bash` with `powershell` and enables `grep`: `["-bash", "+powershell", "+grep"]`. Project settings apply on top of user settings: a project list with only `+name` and `-name` entries changes the user's selection, and a project list with a plain name replaces it. In one list, plain names form the selection, and `+name` and `-name` then apply in order.

Reloading a running session with an extension command's `ctx.reload()` enables tools newly added to `defaultTools`. It does not disable tools removed from it or re-enable unchanged tools you turned off. `--tools` with plain names, `--no-tools`, and `--no-builtin-tools` override `defaultTools`, also on reload.

CLI tool options override this setting for one invocation. `--tools` with only `+name` and `-name` entries changes the resolved `defaultTools` selection instead, for example `pi --tools +codemode`. On reload, these entries apply to the reloaded setting too, so a tool removed with `-name` stays removed. See [Command Line](cli.md#tools).

## Sessions and context

| Setting | Type | Default | Description |
|---|---|---|---|
| `sessionDir` | string | Agent session directory | Session storage directory. Relative paths resolve from the working directory. `PI_CODING_AGENT_SESSION_DIR` and `--session-dir` override this setting. |

### Compaction

| Setting | Type | Default | Description |
|---|---|---|---|
| `compaction.enabled` | boolean | `true` | Enable automatic compaction. |
| `compaction.reserveTokens` | number | `16384` | Free context tokens below which automatic compaction starts. |
| `compaction.keepRecentTokens` | number | `20000` | Recent tokens retained without summarization. |
| `compaction.modelOverrides` | object | None | Per-model token settings keyed by exact `provider/modelId`. |

<a id="per-model-compaction-overrides"></a>

Compaction token values must be non-negative safe integers. Each value resolves independently from the matching model override, then the ordinary compaction setting, then the built-in default. Project and user objects merge before model lookup.

See [Compaction Reference](compaction.md) for trigger, summarization, and validation behavior.

### Branch summaries

| Setting | Type | Default | Description |
|---|---|---|---|
| `branchSummary.reserveTokens` | number | `16384` | Tokens reserved when summarizing branch history. |

<a id="terminal-and-display"></a>

## Themes and images

| Setting | Type | Default | Description |
|---|---|---|---|
| `theme` | string | `"system"` | Built-in or custom theme name for HTML exports and extension colors. |
| `terminal.trueColor` | `boolean \| "auto"` | `"auto"` | Override truecolor detection. JSON-only. |
| `images.autoResize` | boolean | `true` | Resize images to at most 2000 by 2000 pixels before sending them to a model. Applies to `@file` attachments, `read`, and images returned by tools. |
| `images.blockImages` | boolean | `false` | Prevent images from being sent to models. |

See [Themes](themes.md) for theme files and truecolor detection.

## Network and retries

| Setting | Type | Default | Description |
|---|---|---|---|
| `transport` | `"auto" \| "sse" \| "websocket" \| "websocket-cached"` | `"auto"` | Preferred transport for AI providers that support multiple transports. |
| `httpProxy` | string | None | Proxy URL applied as `HTTP_PROXY` and `HTTPS_PROXY` for Pi-managed HTTP clients. **Can only be set in agent-directory settings.** |
| `httpIdleTimeoutMs` | number \| `"disabled"` | `300000` | HTTP header and body idle timeout in milliseconds. Set to `0` or `"disabled"` to disable. |
| `websocketConnectTimeoutMs` | number \| `"disabled"` | `15000` | WebSocket connection timeout in milliseconds. Set to `0` or `"disabled"` to disable. |
| `retry.enabled` | boolean | `true` | Enable automatic agent-level retry for transient failures. |
| `retry.maxRetries` | number | `3` | Maximum agent-level retry attempts. |
| `retry.baseDelayMs` | number | `2000` | Initial exponential-backoff delay in milliseconds. |
| `retry.maxAgentDelayMs` | number | `60000` | Maximum agent-level retry delay in milliseconds. |
| `retry.provider.timeoutMs` | number | `httpIdleTimeoutMs` | Provider request timeout in milliseconds. |
| `retry.provider.maxRetries` | number | `0` | Provider-level retry attempts. |
| `retry.provider.maxRetryDelayMs` | number | `60000` | Maximum server-requested delay in milliseconds. Set to `0` to disable the limit. |

Keep `retry.provider.maxRetries` at `0` unless provider-level retries are required. Provider retries can delay Pi from handling quota and usage-limit errors itself.

## Shell

| Setting | Type | Default | Description |
|---|---|---|---|
| `shellPath` | string | Platform default | Custom shell executable path, for example for Cygwin on Windows. Supports a leading `~`. |
| `shellCommandPrefix` | string | None | Prefix prepended to every shell command, for example `"shopt -s expand_aliases"`. |
| `npmCommand` | `string[]` | `npm` | Command and arguments used for npm package lookup and installation, for example `["mise", "exec", "node@20", "--", "npm"]`. |
| `selfUpdateCommand` | `string[]` | None | Command and arguments `pi update` runs to update Pi itself, with `{packageName}`, `{version}`, and `{installSpec}` placeholders. `PI_SELF_UPDATE_COMMAND` takes precedence. **Can only be set in agent-directory settings.** See [Custom update command](cli.md#custom-update-command). |

Windows paths in JSON must use forward slashes or escaped backslashes. See [Shell aliases](shell-aliases.md) for shell setup and [Pi Packages](packages.md) for package-manager behavior.

## Resources

Resource paths in user settings resolve from the agent directory. Paths in project settings resolve from the project `.pi` directory. Absolute paths and `~` are supported.

| Setting | Type | Default | Description |
|---|---|---|---|
| `packages` | array | `[]` | npm, git, or local Pi package sources. See [Pi Packages](packages.md). |
| `extensions` | `string[]` | `[]` | Extension files or directories. |
| `skills` | `string[]` | `[]` | Skill files or directories. |
| `prompts` | `string[]` | `[]` | Prompt-template files or directories. |
| `themes` | `string[]` | `[]` | Theme files or directories. |

Resource arrays support glob exclusions with `!pattern`, exact inclusion with `+path`, and exact exclusion with `-path`. Pi loads resources listed in both user-level and project settings.

The built-in extensions are named `builtin:mcp`, `builtin:llama.cpp`, `builtin:codemode`, and `builtin:tool-search` in `extensions`. They load by default; `-builtin:mcp` disables one. A `+builtin:<name>` or `-builtin:<name>` entry in project settings overrides the user setting. `pi config` prints them with the other resolved resources. `--no-extensions` disables them too, and `-e builtin:<name>` loads one explicitly.

## Telemetry

| Setting | Type | Default | Description |
|---|---|---|---|
| `enableInstallTelemetry` | boolean | `true` | Enable anonymous install/update reporting and selected provider attribution headers. Does not control update checks. |
