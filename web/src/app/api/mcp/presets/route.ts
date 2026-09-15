import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";

import { auth } from "@/lib/auth";
import { isElectronServer } from "@/lib/electron";
import {
  MCP_PRESETS,
  MCP_PRESET_IDS,
  describePresetStatus,
  isMcpPresetId,
  resolvePresetPython,
  type McpPresetId,
} from "@/lib/mcp-presets";
import { loadSettings, saveSettings, type McpServerConfig } from "@/lib/settings";

export const dynamic = "force-dynamic";

function run(command: string, args: string[], timeoutMs: number): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ code: -1, out: err instanceof Error ? err.message : String(err) });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      resolve({ code: -2, out: `${out}\n[timed out after ${timeoutMs}ms]` });
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, out: `${out}\n${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

let mcpModuleCache: { python: string; ok: boolean; at: number } | null = null;

async function checkMcpModule(python: string, force = false): Promise<boolean> {
  if (!force && mcpModuleCache && mcpModuleCache.python === python && Date.now() - mcpModuleCache.at < 60_000) {
    return mcpModuleCache.ok;
  }
  const result = await run(python, ["-c", "import mcp.server.fastmcp"], 20_000);
  const ok = result.code === 0;
  mcpModuleCache = { python, ok, at: Date.now() };
  return ok;
}

async function allowed(): Promise<boolean> {
  if (isElectronServer()) return true;
  const session = await auth();
  return Boolean(session?.user?.id);
}

async function buildStatus(force = false) {
  const settings = loadSettings();
  const python = resolvePresetPython();
  const mcpModule = python ? await checkMcpModule(python, force) : null;
  const presets = MCP_PRESET_IDS.map((id) => {
    const entry = settings.mcpServers.find((s) => s.preset === id || s.id === id);
    return describePresetStatus(id, Boolean(entry && entry.enabled !== false), mcpModule);
  });
  const custom = settings.mcpServers
    .filter((s) => !isMcpPresetId(s.preset || ""))
    .map((s) => ({ id: s.id, name: s.name || s.id, command: s.command, args: s.args || [], enabled: s.enabled !== false }));
  return { python, mcpModule, presets, custom };
}

export async function GET(request: NextRequest) {
  if (!(await allowed())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const force = request.nextUrl.searchParams.get("refresh") === "1";
  return NextResponse.json(await buildStatus(force), { headers: { "Cache-Control": "no-store" } });
}

function setPresetEnabled(servers: McpServerConfig[], id: McpPresetId, enabled: boolean): McpServerConfig[] {
  const preset = MCP_PRESETS[id];
  const others = servers.filter((s) => s.preset !== id && s.id !== id);
  if (!enabled) return others;
  return [...others, { id, preset: id, name: preset.label, command: "", enabled: true }];
}

export async function POST(request: NextRequest) {
  if (!(await allowed())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await request.json().catch(() => ({}));
  const action = typeof body.action === "string" ? body.action : "";

  if (action === "toggle") {
    const id = body.id;
    if (!isMcpPresetId(id)) return NextResponse.json({ error: "Unknown preset" }, { status: 400 });
    const settings = loadSettings();
    saveSettings({ mcpServers: setPresetEnabled(settings.mcpServers, id, body.enabled !== false) });
    return NextResponse.json(await buildStatus());
  }

  if (action === "install-mcp") {
    const python = resolvePresetPython();
    if (!python) return NextResponse.json({ error: "No Python interpreter found" }, { status: 400 });
    // The bundled servers use the v1 FastMCP API; mcp 2.x renamed it, so pin.
    const result = await run(python, ["-m", "pip", "install", "--upgrade", "mcp>=1.2,<2"], 10 * 60_000);
    const status = await buildStatus(true);
    return NextResponse.json({ ...status, install: { ok: result.code === 0, log: result.out.slice(-3000) } });
  }

  if (action === "set-custom") {
    if (!Array.isArray(body.servers)) return NextResponse.json({ error: "servers must be an array" }, { status: 400 });
    const settings = loadSettings();
    const presets = settings.mcpServers.filter((s) => isMcpPresetId(s.preset || ""));
    saveSettings({ mcpServers: [...presets, ...body.servers] });
    return NextResponse.json(await buildStatus());
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
