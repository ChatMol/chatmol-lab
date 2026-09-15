import { NextRequest, NextResponse } from "next/server";

import { listAgents } from "@/lib/agent-registry";
import { auth } from "@/lib/auth";
import { isElectronServer } from "@/lib/electron";
import { installPlugin, removePlugin, setPluginEnabled } from "@/lib/plugin-install";
import { listPlugins } from "@/lib/plugins";
import { listSkills } from "@/lib/skill-registry";

export const dynamic = "force-dynamic";

async function allowed(): Promise<boolean> {
  if (isElectronServer()) return true;
  const session = await auth();
  return Boolean(session?.user?.id);
}

/** Installing/removing changes a machine-wide directory: desktop only unless opted in. */
function canManage(): boolean {
  return isElectronServer() || process.env.CHATMOL_ALLOW_PLUGIN_INSTALL === "1";
}

function snapshot(extra: Record<string, unknown> = {}) {
  const skills = listSkills();
  const agents = listAgents();
  const plugins = listPlugins().map((plugin) => {
    const tag = `plugin:${plugin.key}`;
    return {
      key: plugin.key,
      name: plugin.name,
      version: plugin.version ?? null,
      description: plugin.description ?? null,
      dir: plugin.dir,
      source: plugin.source,
      origin: plugin.origin ?? null,
      enabled: plugin.enabled,
      error: plugin.error ?? null,
      skills: skills.filter((skill) => skill.source === tag).map((skill) => skill.id),
      agents: agents.filter((agent) => agent.source === tag).map((agent) => agent.id),
      mcpServers: plugin.mcpServers.map((server) => server.id),
    };
  });
  return {
    canManage: canManage(),
    plugins,
    skills: skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      source: skill.source,
      modelInvocable: skill.modelInvocable,
      userInvocable: skill.userInvocable,
    })),
    agents: agents.map((agent) => ({ id: agent.id, name: agent.name, description: agent.description, source: agent.source })),
    ...extra,
  };
}

export async function GET() {
  if (!(await allowed())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json(snapshot(), { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest) {
  if (!(await allowed())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!canManage()) return NextResponse.json({ error: "Plugin installation is only available in the desktop app." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const source = typeof body.source === "string" ? body.source : "";
  try {
    const result = await installPlugin(source);
    return NextResponse.json(snapshot({ installed: result.plugins.map((plugin) => plugin.name), log: result.log ?? "" }));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}

export async function PATCH(request: NextRequest) {
  if (!(await allowed())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!canManage()) return NextResponse.json({ error: "Plugin settings can only be changed in the desktop app." }, { status: 403 });
  const body = await request.json().catch(() => ({}));
  const key = typeof body.key === "string" ? body.key.trim() : (typeof body.name === "string" ? body.name.trim() : "");
  if (!key) return NextResponse.json({ error: "key is required" }, { status: 400 });
  try {
    setPluginEnabled(key, body.enabled !== false);
    return NextResponse.json(snapshot());
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  if (!(await allowed())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!canManage()) return NextResponse.json({ error: "Plugin removal is only available in the desktop app." }, { status: 403 });
  const key = request.nextUrl.searchParams.get("key")?.trim() || request.nextUrl.searchParams.get("name")?.trim() || "";
  if (!key) return NextResponse.json({ error: "key is required" }, { status: 400 });
  try {
    removePlugin(key);
    return NextResponse.json(snapshot());
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
