# Desktop app

The desktop app is the Next.js workbench running locally inside Electron. Electron starts (or reuses) a local daemon on a loopback port and opens the UI against it.

- **No account.** The app opens straight into a local workspace. Connecting ChatMol Cloud (Settings → General) is optional and never required.
- **Your keys.** No model keys are bundled; configure a provider in Settings → API.
- **Local data.** Sessions, workspace files, settings and the bundled runtime live under `~/.chatmol-lab/`.
- **Bundled runtime.** A conda-based Python runtime ships with the app and always comes first on the agent's PATH; scientific packages install into it on first use. Windows also gets an offline WSL2 runtime for bioconda tools.
- **Sandbox.** On macOS shell commands run under Seatbelt and can only write inside the session workspace, the runtime and the temp dir. A denied write comes back to the agent as a fact; it may retry once with a one-line justification, which a fast model rates before anything runs. Read-only commands run, destructive ones ask.

## Data directories

| Path | Contents |
|---|---|
| `~/.chatmol-lab/daemon.json` | Local daemon pid, port, version and health token |
| `~/.chatmol-lab/workspace/` | Session workspaces |
| `~/.chatmol-lab/sessions/` | Persisted chat sessions |
| `~/.chatmol-lab/chatmol.db` | SQLite database |
| `~/.chatmol-lab/runtime/` | Bundled Python runtime |
| `~/.chatmol-lab/plugins/`, `plugins.json` | Installed plugins and their state |

## Building

```bash
npm run build               # Next.js
npm run electron:compile    # Electron TypeScript
npx electron-builder --mac  # macOS arm64 (build on Apple silicon)
npx electron-builder --win  # Windows x64 NSIS installer
```

macOS x64 needs an Intel Mac; Sharp and Prisma native modules do not cross-compile. Electron sources are in `electron/main.ts` (window, protocol handler, daemon lifecycle) and `electron/preload.ts` (IPC bridge).

## Cloud connection

Connecting ChatMol Cloud opens the system browser for a one-time code exchange with PKCE; the `chatmol://` protocol carries the callback. Only the cloud token is stored; the local workspace and sessions are unchanged. Session sync is off by default.
