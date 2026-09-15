# Getting started

## Your first five minutes

1. **Install.** Download the installer for macOS (Apple silicon) or Windows (x64) from the [releases page](https://github.com/ChatMol/chatmol-lab/releases). The installers are not notarized yet: on macOS right-click the app and choose **Open** the first time — on macOS 15 and later, open it once, then allow it under **System Settings → Privacy & Security**; on Windows choose **More info → Run anyway**.
2. **Add one model key.** Open Settings → API and paste a key for OpenAI, Anthropic, Gemini, DeepSeek or OpenRouter, or point it at a local OpenAI-compatible server (Ollama, vLLM, LM Studio). Nothing else is required. There is no account to create.
3. **Pick a folder.** New sessions get a workspace under `~/.chatmol-lab/workspace`. To work inside your own project folder, use the folder picker at the top of the chat.
4. **Ask something.** Try: *Fetch 1UBQ, tell me its secondary structure composition, and show it in the viewer.* Tool calls fold into one activity line you can expand; the structure opens in the Mol\* panel on the right.
5. **Click residues.** Select residues in the viewer and they attach to your next message, so "these residues" means exactly those.

## Optional connections

| What you want | What to add in Settings |
|---|---|
| Structure prediction, docking, protein design without a GPU | An NVIDIA NIM key (free tier at build.nvidia.com) |
| Antibody humanization, ADMET, MD and other industrial modules | Your WeMol account |
| Live PyMOL or ChimeraX window driven from chat | Settings → General → Molecular viewers (one-click `mcp` install) |
| Extra tools from any stdio MCP server | Settings → MCP servers |
| More skills or subagents | Settings → Plugins & Skills, from a folder or a git URL |

## Where things live

Everything stays on your machine unless a tool you configured sends it somewhere.

| Path | Contents |
|---|---|
| `~/.chatmol-lab/workspace/` | Session workspaces (uploads, generated files) |
| `~/.chatmol-lab/sessions/` | Chat history |
| `~/.chatmol-lab/plugins/`, `skills/`, `agents/` | Installed plugins, your skills and subagents |
| `~/.chatmol-lab/runtime/` | The bundled Python runtime the agent uses |

## Running from source

Node.js 20 or newer.

```bash
git clone https://github.com/ChatMol/chatmol-lab.git
cd chatmol-lab
cp .env.example web/.env.local     # put one provider key here, or use Settings
npm install
cd web && npx prisma generate && npx prisma db push && cd ..
npm run dev                        # http://localhost:3000
npm run electron:dev               # the desktop shell against the local app
npm run electron:build             # build an installer
```

`npx prisma generate` must run before `npm run dev`, `npm test` or `npm run build`. See [Desktop app](desktop-app.md) and [Architecture](architecture.md) for more.
