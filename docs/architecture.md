# Architecture

For contributors. Users need only [Getting started](getting-started.md).

## Layout

```
chatmol-lab/
├── web/                Next.js 15 app (App Router, React 19, TypeScript)
│   ├── src/app/        Pages and API routes (api/chat is the agent loop)
│   ├── src/components/ UI: ChatPanel, MolstarViewer, FilePreview, Settings
│   ├── src/lib/        Tools, sandbox, registries, memory, providers
│   └── analysis/       Python used by analyze_structure (biotite, Biopython)
├── plugins/chatmol/    Bundled plugin: skills/*/SKILL.md and agents/*.md
├── electron/           Desktop shell
└── scripts/            Runtime preparation and checks
```

## Agent loop

`web/src/app/api/chat/route.ts` runs one tool-use loop per request (up to 30 iterations): send the conversation and tool definitions to the model, review and execute each tool call, stream `token`, `tool_call`, `tool_result`, `artifact`, `plan` and `approval_required` events to the client, repeat until the model answers. Anthropic native and OpenAI-compatible request shapes are both supported. The system prompt carries the workspace file list, a runtime manifest (which Python packages and CLI tools are actually installed), the skill catalog and the memory index.

## Tools

| Group | Tools |
|---|---|
| Files and shell | `bash` (sandboxed), `read_file`, `write_file`, `list_files`, `save_artifact` |
| Structures | `fetch_pdb`, `inspect_structure` (chains, numbering, gaps, ligands), `analyze_structure` (secondary structure, superposition, interfaces, SASA, confidence) |
| Databases | `search_database` over UniProt, PDB, PubMed, Ensembl, NCBI Gene, KEGG, Reactome, ChEMBL, PubChem, AlphaFold DB and more |
| NVIDIA NIM | `nvidia_openfold2`, `nvidia_openfold3`, `nvidia_boltz2`, `nvidia_rfdiffusion`, `nvidia_proteinmpnn`, `nvidia_diffdock`, `nvidia_colabfold_msa`, `nvidia_genmol`, `nvidia_molmim`, `nvidia_evo2` |
| WeMol | `wemol_cli` (schema-driven module and flow submission, background job tracking) |
| Orchestration | `create_plan`, `run_subagent` (parallel when several are requested in one turn), `skill`, `memory`, `wait` |
| MCP | every enabled server's tools as `mcp__<server>__<tool>` |

## Tool review and sandbox

`toolReviewMode`: `auto` (default), `reviewer`, `manual`, `unrestricted`. In `auto` only `bash` is policed. A hard blocklist runs first; then the command is classified as safe (read-only, runs), confirm (structural evidence of privilege, process or network danger, always asks) or review (a fast model judges it against the task). On macOS the process also runs under Seatbelt in workspace-write mode: a denied write returns as a tool-result fact, the model may retry once with a justification, and a fast model rates that retry (risk × user authorization) before it runs.

## Skills, subagents, plugins

- **Skills** follow the Agent Skills standard (`<id>/SKILL.md`, frontmatter `name`, `description`). Roots, nearest wins: the session workspace, `~/.chatmol-lab/skills`, `~/.agents/skills`, `~/.claude/skills`, enabled plugins. The prompt lists names and descriptions only; the model loads a body with the `skill` tool, and a leading `/name` injects it directly.
- **Subagents** are `agents/<id>.md` files (frontmatter `name`, `description`, `tools`, `model`, `skills`; body is the persona). `general` is a runtime built-in.
- **Plugins** are directories with `skills/`, `agents/`, `.mcp.json` and a manifest (`plugin.json`, `.claude-plugin/` or `.codex-plugin/`; `marketplace.json` expands). Installed from a folder or git URL into `~/.chatmol-lab/plugins`.

## Memory and context

Cross-session memory: an index in the prompt, a `memory` tool, and an end-of-run distillation step. Long sessions are compacted dsh-style: oversized tool results are pruned and the oldest span is condensed by the fast model; `/compact` does it on demand.

## UI

Three panels: sessions sidebar, chat with a plan panel, and a right panel with file preview, the Mol\* viewer (residue selection attaches to the next message), tools catalog and subagent traces. State is a Zustand store persisted to localStorage; sessions are also persisted server-side as JSON.

## Key files

| File | Purpose |
|---|---|
| `web/src/lib/tools.ts` | Tool definitions, executor, agent loop |
| `web/src/lib/bash-policy.ts`, `sandbox.ts`, `tool-review.ts` | Command classification, Seatbelt sandbox, reviewers |
| `web/src/lib/runtime-manifest.ts`, `runtime.ts` | Interpreter probing, bundled runtime PATH |
| `web/src/lib/skill-registry.ts`, `agent-registry.ts`, `plugins.ts` | Skills, subagents, plugins |
| `web/src/lib/memory.ts`, `memory-distill.ts`, `context-compaction.ts` | Memory and compaction |
| `web/src/lib/nvidia-bio.ts`, `wemol-cli.ts`, `structure-report.ts` | Scientific backends and structure inventory |
| `web/src/components/ChatPanel.tsx`, `MolstarViewer.tsx` | Chat and viewer |
