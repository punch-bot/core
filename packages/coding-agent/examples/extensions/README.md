# Extension Examples

Example extensions for pi-coding-agent.

## Usage

```bash
# Load an extension with --extension flag
pi --extension examples/extensions/permission-gate.ts

# Or copy to extensions directory for auto-discovery
cp permission-gate.ts ~/.pi/agent/extensions/
```

## Examples

### Lifecycle & Safety

| Extension | Description |
|-----------|-------------|
| `permission-gate.ts` | Prompts for confirmation before dangerous bash commands (rm -rf, sudo, etc.) |
| `project-trust.ts` | Demonstrates the `project_trust` event for user/global and CLI extensions |
| `protected-paths.ts` | Blocks writes to protected paths (.env, .git/, node_modules/) |
| `confirm-destructive.ts` | Confirms before destructive session actions (clear, switch, fork) |
| `dirty-repo-guard.ts` | Prevents session changes with uncommitted git changes |
| `sandbox/` | OS-level sandboxing using `@anthropic-ai/sandbox-runtime` with per-project config |
| `gondolin/` | Route built-in tools and `!` commands into a Gondolin micro-VM |

### Custom Tools

| Extension | Description |
|-----------|-------------|
| `hello.ts` | Minimal custom tool example |
| `tool-override.ts` | Override built-in tools (e.g., add logging/access control to `read`) |
| `dynamic-tools.ts` | Register tools after startup (`session_start`) and at runtime via command, with prompt snippets and tool-specific prompt guidelines |
| `kimi-deferred-tools.ts` | Search for and progressively activate tools for Kimi's deferred-tool loading protocol |
| `ssh.ts` | Delegate all tools to a remote machine via SSH using pluggable operations |
| `subagent/` | Delegate tasks to specialized subagents with isolated context windows |

### Commands & UI

| Extension | Description |
|-----------|-------------|
| `status-line.ts` | Shows turn progress via `ctx.ui.setStatus()` |
| `widget-placement.ts` | Shows widgets via `ctx.ui.setWidget()` |
| `hidden-thinking-label.ts` | Customizes the collapsed thinking label via `ctx.ui.setHiddenThinkingLabel()` |
| `working-indicator.ts` | Customizes the streaming working indicator via `ctx.ui.setWorkingIndicator()` |
| `model-status.ts` | Shows model changes in status bar via `model_select` hook |
| `send-user-message.ts` | Demonstrates `pi.sendUserMessage()` for sending user messages from extensions |
| `timed-confirm.ts` | Demonstrates AbortSignal for auto-dismissing `ctx.ui.confirm()` and `ctx.ui.select()` dialogs |
| `rpc-demo.ts` | Exercises RPC-supported extension UI methods |
| `notify.ts` | Desktop notifications via OSC 777 when agent finishes (Ghostty, iTerm2, WezTerm) |
| `titlebar-spinner.ts` | Braille spinner animation in terminal title while the agent is working |
| `shutdown-command.ts` | Adds `/quit` command demonstrating `ctx.shutdown()` |
| `reload-runtime.ts` | Adds `/reload-runtime` and `reload_runtime` tool showing safe reload flow |
| `inline-bash.ts` | Expands `!{command}` patterns in prompts via `input` event transformation |
| `input-transform-streaming.ts` | Skips expensive input preprocessing for mid-stream steering via `streamingBehavior` |

### Git Integration

| Extension | Description |
|-----------|-------------|
| `git-checkpoint.ts` | Creates git stash checkpoints at each turn for code restoration on fork |
| `auto-commit-on-exit.ts` | Auto-commits on exit using last assistant message for commit message |

### System Prompt & Compaction

| Extension | Description |
|-----------|-------------|
| `pirate.ts` | Demonstrates `systemPromptAppend` to dynamically modify system prompt |
| `claude-rules.ts` | Scans `.claude/rules/` folder and lists rules in system prompt |
| `custom-compaction.ts` | Custom compaction that summarizes entire conversation |
| `trigger-compact.ts` | Triggers compaction when context usage exceeds 100k tokens and adds `/trigger-compact` command |

### System Integration

| Extension | Description |
|-----------|-------------|
| `mac-system-theme.ts` | Syncs pi theme with macOS dark/light mode |

### Resources

| Extension | Description |
|-----------|-------------|
| `dynamic-resources/` | Loads skills, prompts, and themes using `resources_discover` |

### Messages & Communication

| Extension | Description |
|-----------|-------------|
| `event-bus.ts` | Inter-extension communication via `pi.events` |

### Session Metadata

| Extension | Description |
|-----------|-------------|
| `session-name.ts` | Name sessions for the session selector via `setSessionName` |
| `bookmark.ts` | Bookmark entries with labels for `/tree` navigation via `setLabel` |

### Custom Providers

| Extension | Description |
|-----------|-------------|
| `custom-provider-anthropic/` | Custom Anthropic provider with OAuth support and custom streaming implementation |
| `custom-provider-gitlab-duo/` | GitLab Duo provider using pi-ai's built-in Anthropic/OpenAI streaming via proxy |

### External Dependencies

| Extension | Description |
|-----------|-------------|
| `with-deps/` | Extension with its own package.json and dependencies (demonstrates jiti module resolution) |
| `file-trigger.ts` | Watches a trigger file and injects contents into conversation |

## Writing Extensions

See [docs/extensions.md](../../docs/extensions.md) for full documentation.

```typescript
import type { ExtensionAPI } from "@punch-bot/cli";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  // Subscribe to lifecycle events
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
      const ok = await ctx.ui.confirm("Dangerous!", "Allow rm -rf?");
      if (!ok) return { block: true, reason: "Blocked by user" };
    }
  });

  // Register custom tools
  pi.registerTool({
    name: "greet",
    label: "Greeting",
    description: "Generate a greeting",
    parameters: Type.Object({
      name: Type.String({ description: "Name to greet" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      return {
        content: [{ type: "text", text: `Hello, ${params.name}!` }],
        details: {},
      };
    },
  });

  // Register commands
  pi.registerCommand("hello", {
    description: "Say hello",
    handler: async (args, ctx) => {
      ctx.ui.notify("Hello!", "info");
    },
  });
}
```

## Key Patterns

**Use StringEnum for string parameters** (required for Google API compatibility):
```typescript
import { StringEnum } from "@punch-bot/ai";

// Good
action: StringEnum(["list", "add"] as const)

// Bad - doesn't work with Google
action: Type.Union([Type.Literal("list"), Type.Literal("add")])
```

**State persistence via details:**
```typescript
// Store state in tool result details for proper forking support
return {
  content: [{ type: "text", text: "Done" }],
  details: { todos: [...todos], nextId },  // Persisted in session
};

// Reconstruct on session events
pi.on("session_start", async (_event, ctx) => {
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type === "message" && entry.message.toolName === "my_tool") {
      const details = entry.message.details;
      // Reconstruct state from details
    }
  }
});
```
