import { NextRequest, NextResponse } from "next/server";
import { listSkills } from "@/lib/skill-registry";
import { getSessionWorkspace } from "@/lib/workspace";

/**
 * Skill catalog for the pickers. Pass `?sessionId=` to include skills found in
 * that session's workspace (`.agents/skills`, `.chatmol/skills`, `.claude/skills`).
 */
export async function GET(request: NextRequest) {
  try {
    const sessionId = request.nextUrl.searchParams.get("sessionId")?.trim();
    const cwd = sessionId ? getSessionWorkspace(sessionId) : undefined;
    const skills = listSkills(cwd ? { cwd } : {}).map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      category: s.category,
      tags: s.tags,
      source: s.source,
      modelInvocable: s.modelInvocable,
      userInvocable: s.userInvocable,
    }));
    skills.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
    return NextResponse.json(skills);
  } catch (error) {
    console.error("Failed to load skills:", error);
    return NextResponse.json([], { status: 500 });
  }
}
