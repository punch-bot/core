# Terminal Setup

Pi uses the [Kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) for reliable modifier key detection. Most modern terminals support this protocol, but some require configuration.

## Capability Overrides

Pi auto-detects truecolor support for themed output. If detection fails behind a terminal proxy or multiplexer, use this advanced override:

| Capability | Environment variable | JSON setting |
|------------|----------------------|--------------|
| Truecolor | `PI_TRUE_COLOR=1\|0\|auto` | `terminal.trueColor: true\|false\|"auto"` |

Settings take precedence over environment variables; unset or `auto` preserves detection. Only force capabilities supported by the complete terminal path, since unsupported escape sequences can corrupt rendering.

## Terminal emulators

Pi's headless modes do not capture keyboard or mouse input and do not use an alternate screen. Terminal-specific key mappings, fullscreen scrolling workarounds, and hardware-cursor settings are not required. An RPC client owns its own input and display behavior.
