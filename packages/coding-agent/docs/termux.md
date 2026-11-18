# Run Pi on Android with Termux

Pi runs on Android through [Termux](https://termux.dev/), a terminal emulator and Linux environment. Print, JSON, and RPC modes, file tools, and shell commands are supported. Extensions can copy text to the Android clipboard through Termux:API.

## Before you begin

Install Termux from [GitHub or F-Droid](https://github.com/termux/termux-app#installation). Do not use the deprecated Google Play build.

[Termux:API](https://github.com/termux/termux-api#installation) is optional. Install it only when an extension should copy text to the Android clipboard, or when shell commands need Android device APIs.

## Install Pi

1. Update Termux packages:

   ```bash
   pkg update && pkg upgrade
   ```

2. Install Node.js and Git:

   ```bash
   pkg install nodejs git
   ```

3. Install Pi:

   ```bash
   npm install -g --ignore-scripts @punch-bot/cli
   ```

4. Verify the installation:

   ```bash
   pi --version
   ```

5. Open the folder you want to work in:

   ```bash
   cd /path/to/working-folder
   ```

Continue with the main [Quickstart](quickstart.md#2-choose-a-model) to connect a model and run your first task.

## Access Android shared storage

Termux cannot access shared Android storage until you grant permission. Run this once:

```bash
termux-setup-storage
```

After approval, Android shared storage is available under `/storage/emulated/0` and through the links Termux creates under `~/storage/`.

Only grant this permission when Pi should be able to access those files. Commands and tools running in Termux use the same storage permissions as the Termux process.

## Use clipboard commands

The SDK's `copyToClipboard()`, which extensions can call, uses `termux-clipboard-set` in Termux. Shell commands can use `termux-clipboard-set` and `termux-clipboard-get` directly. Install the Termux:API app and its command-line package:

```bash
pkg install termux-api
```

Verify the integration:

```bash
printf 'Pi clipboard test' | termux-clipboard-set
termux-clipboard-get
```

The second command should print `Pi clipboard test`.

The Termux clipboard API supports text only.

## Add Termux-specific instructions

Pi detects that it is running in Termux, but it cannot infer how you want it to interact with Android. Add only the environment details relevant to your work to `~/.pi/agent/AGENTS.md`:

````markdown
# Termux environment

- Pi runs in Termux on Android.
- Shared Android storage is under `/storage/emulated/0`.
- Open URLs with `termux-open-url "https://example.com"`.
- Open files with `termux-open <path>`.
- Do not access shared storage unless the task requires it.
````

Pi reads the file at startup, so the change applies to the next Pi process.

## Troubleshooting

### Clipboard integration fails

Confirm that you installed both components:

1. The Termux:API Android app from the same source as Termux
2. The `termux-api` command-line package

Then run the clipboard verification commands above outside Pi. If they fail there, fix the Termux:API installation before retrying the extension that copies text.

### Shared storage reports permission denied

Run `termux-setup-storage`, approve the Android permission request, and retry the path under `~/storage/` or `/storage/emulated/0`.

### Pi is not found after installation

Open a new Termux shell and run:

```bash
npm prefix -g
command -v pi
```

Confirm that the global npm binary directory is on `PATH`, then reinstall Pi if the package is missing.
