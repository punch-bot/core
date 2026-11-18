# Customize Pi with themes

Themes control the colors of HTML session exports written by the RPC [`export_html`](rpc-commands.md#export_html) command or the SDK, and the `ctx.ui.theme` colors that extensions use. Pi includes the `system`, `dark`, and `light` themes, and you can create your own palette.

## Use the default theme

The `system` theme is the default. Upstream pi derives it from the colors a terminal reports. Pi's headless modes do not query the terminal, so `system` uses Pi's own hues and picks a dark or light appearance from the `COLORFGBG` environment variable, falling back to dark. `system` is a reserved name: a custom theme with that name is ignored.

<a id="selecting-a-theme"></a>

## Choose a theme

Set the `theme` [setting](settings.md#terminal-and-display):

```json
{
  "theme": "dark"
}
```

Without a `theme` setting, Pi uses `system`.

Upstream pi also accepts a `light/dark` pair that follows the terminal's appearance. Pi cannot detect the appearance, so it uses `system` for a pair. Theme names cannot contain `/` because the pair format reserves it.

Use `--use-theme` to choose the theme for one invocation without changing the saved setting:

```bash
pi --use-theme light --mode rpc
```

See [CLI resources](cli.md#resources) for the command-line option.

<a id="override-detected-capabilities"></a>

### Override truecolor detection

Pi detects truecolor support for the ANSI colors that `ctx.ui.theme` produces. If detection fails behind a terminal proxy or multiplexer, override it with `PI_TRUE_COLOR=1|0|auto` or the JSON-only `terminal.trueColor` setting (`true`, `false`, or `"auto"`). Without truecolor, Pi approximates colors with the 256-color palette.

## Create a custom theme

Copy one of the [built-in themes](https://github.com/punch-bot/core/tree/main/packages/coding-agent/src/core/theme) or create a new JSON file conforming to the [schema](https://raw.githubusercontent.com/punch-bot/core/main/packages/coding-agent/schemas/theme.schema.json). The built-in themes use OKHSL colors, with variables for colors that several roles share, so you can adjust a hue, saturation, or lightness directly.

1. Save the file as `<agent-dir>/themes/my-theme.json`. The agent directory defaults to `~/.pi/agent`.
2. Set its `name` to `my-theme`.
3. Change values in `vars` and `colors`.
4. Set `"theme": "my-theme"` in `settings.json`.

Use the theme name as the filename. Pi loads themes at startup, so restart Pi after adding or changing one. An extension command can reload a running session with `ctx.reload()`.

## Understand the theme file

| Property | Required | Responsibility |
|---|---|---|
| `$schema` | No | Enables editor validation and completion against Pi's published schema. |
| `name` | Yes | Identifies the theme in settings and `--use-theme`. It must be unique, cannot contain `/`, and cannot be `system`. |
| `appearance` | No | `"dark"` or `"light"`: the background the theme is designed for. Pi detects it from the theme colors when omitted. |
| `vars` | No | Defines reusable color values. Variables can reference other variables. |
| `colors` | Yes | Assigns colors to interface roles. The schema identifies required and optional roles. |
| `export` | No | Overrides page and panel backgrounds in HTML exports. |

Theme objects are strict: only documented top-level fields and color tokens are accepted. Define reusable custom colors under `vars`; custom keys under `colors` or `export` and additional top-level metadata are rejected.

A color can be written in six forms:

| Form | Example | Meaning |
|---|---|---|
| RGB hexadecimal | `"#0af"` or `"#00aaff"` | A three- or six-digit sRGB color. |
| OKLCH | `"oklch(62% 0.1 200)"` | Perceptual lightness, chroma, and hue. |
| OKHSL | `"okhsl(250 60% 55%)"` | Hue, saturation, and lightness. Saturation is relative to the most the sRGB gamut allows at that hue and lightness, so every value is in gamut and equal saturation looks equally colorful. |
| 256-color index | `39` | An ANSI palette index from `0` through `255`. |
| Variable reference | `"primary"` | The value of an entry in `vars`. |
| Terminal default | `""` | The terminal's default foreground or background color. |

Terminal default colors render as the terminal's own colors in ANSI output. Where Pi needs a concrete value, such as HTML export or extension color math, it uses a black or white guess based on the theme's appearance.

Pi resolves chained variable references. A missing variable or circular reference makes the theme invalid. Pi gamut-maps OKLCH to sRGB. HTML exports convert OKHSL values to hexadecimal because CSS does not support them. For ANSI output, see [Override truecolor detection](#override-detected-capabilities).

Use the [theme JSON schema](https://raw.githubusercontent.com/punch-bot/core/main/packages/coding-agent/schemas/theme.schema.json) for the exact properties, required colors, and accepted value types.

Pi reports invalid theme files during startup and reload.

## Find the color to change

Theme colors describe roles of upstream pi's terminal interface; HTML exports reuse them for messages, tool output, Markdown, diffs, and syntax highlighting. Use these groups to find the relevant part of the schema:

| Area | Color names |
|---|---|
| General interface | `accent`, `border*`, `text`, `muted`, `dim`, `success`, `error`, `warning` |
| Selection and fullscreen | `selectedBg`, `searchMatch*`, `scrollbar*` |
| Messages | `userMessage*`, `customMessage*`, `thinkingText` |
| Tool execution | `toolPendingBg`, `toolSuccessBg`, `toolErrorBg`, `toolTitle`, `toolOutput` |
| Markdown | `md*` |
| Tool diffs | `toolDiff*` |
| Syntax highlighting | `syntax*` |
| Editor modes | `thinking*`, `bashMode` |
| HTML export | `export.pageBg`, `export.cardBg`, `export.infoBg` |

The schema is the format reference. The built-in themes provide complete values that you can copy and adjust.

Five colors are optional and inherit another color when omitted:

| Optional color | Fallback |
|---|---|
| `scrollbarTrack` | `muted` |
| `scrollbarThumb` | `text` |
| `searchMatchBg` | `selectedBg` |
| `searchMatchText` | `text` |
| `thinkingMax` | `thinkingXhigh` |

If `export` colors are omitted, Pi derives HTML page and panel backgrounds from `userMessageBg`.

## Load a theme from a project or package

Place a project theme in `.pi/themes/`. Project themes load only after [project trust](security.md#understand-project-trust) is granted.

You can also load theme files and directories through the `themes` setting or distribute them in a Pi package. See [Configuration](configuration.md), [Settings](settings.md#resources), and [Pi Packages](packages.md).

Each loaded theme must have a unique name. Pi reports duplicate names as resource collisions.
