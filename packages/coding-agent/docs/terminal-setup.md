# Configure your terminal

Most modern terminals work with Pi without additional setup. Use this page when modified keys, scrolling, links, images, colors, or input-method editor (IME) positioning do not behave as expected.

Pi uses extended-key protocols so terminals can distinguish combinations such as `Shift+Enter` and `Alt+Enter` from plain `Enter`. Terminal proxies, multiplexers, and built-in IDE terminals can change or discard that information.

Pi auto-detects truecolor support for themed output. If detection fails behind a terminal proxy or multiplexer, use this advanced override:

| Capability | Environment variable | JSON setting |
|------------|----------------------|--------------|
| Truecolor | `PI_TRUE_COLOR=1\|0\|auto` | `terminal.trueColor: true\|false\|"auto"` |

Use `/hotkeys` to inspect Pi's active shortcuts. See [Keybindings](keybindings.md) to change them.

## Terminal emulators

Pi's headless modes do not capture keyboard or mouse input and do not use an alternate screen. Terminal-specific key mappings, fullscreen scrolling workarounds, and hardware-cursor settings are not required. An RPC client owns its own input and display behavior.
