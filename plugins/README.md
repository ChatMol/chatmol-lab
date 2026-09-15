# Bundled plugins

Each directory here is a plugin in the Claude Code / Codex layout, loaded by
ChatMol Lab at startup (`web/src/lib/plugins.ts`):

```
plugins/<name>/
├── plugin.json        # name, version, description (also read from .claude-plugin/ or .codex-plugin/)
├── skills/<id>/SKILL.md   # Agent Skills — usable unchanged in Claude Code, Codex, DeepSeek Harness
├── agents/<id>.md         # subagent definitions (name, description, tools, model, skills + persona)
└── .mcp.json              # optional MCP servers ({ "mcpServers": { id: { command, args, env } } })
```

Users install more plugins from Settings → Plugins & Skills (a git URL or an
absolute folder path); those live under `~/.chatmol-lab/plugins` and are
recorded in `~/.chatmol-lab/plugins.json`. Skills are also discovered from
`~/.chatmol-lab/skills`, `~/.agents/skills`, `~/.claude/skills` and a session
workspace's `.agents/skills` / `.chatmol/skills` / `.claude/skills`.

`chatmol` is the plugin shipped with the app: the scientific skills plus the
WeMol subagents (`wemol-docs`, `wemol-monitor`); the same files are published
in the `ChatMol-Skills` repository. The `general` subagent is a runtime
capability (`web/src/lib/builtin-agents.ts`), not a plugin file, and its id
cannot be redefined by a plugin.
