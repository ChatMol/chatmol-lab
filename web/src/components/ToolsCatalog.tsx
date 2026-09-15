"use client";

import { useState, useEffect } from "react";
import { Search, Tag, Cpu, ChevronDown, ChevronRight, Wrench } from "lucide-react";
import { useAppStore } from "@/lib/store";

interface Skill {
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
}

// Static GPU requirements map (see plugins/chatmol/skills/_shared/SKILL.md)
const GPU_MAP: Record<string, { gpu: string; vram: string }> = {};

const GPU_TIER_COLORS: Record<string, string> = {
  T4: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  A10G: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  L40S: "bg-purple-500/15 text-purple-400 border-purple-500/30",
  A100: "bg-amber-500/15 text-amber-400 border-amber-500/30",
};

function GpuBadge({ gpu, vram }: { gpu: string; vram: string }) {
  const colors = GPU_TIER_COLORS[gpu] || "bg-bg-tertiary text-text-muted border-border";
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium border ${colors}`}
      title={`Modal GPU: ${gpu} (${vram} VRAM)`}
    >
      <Cpu className="w-2.5 h-2.5" />
      {gpu}
      <span className="opacity-70">{vram}</span>
    </span>
  );
}

export default function ToolsCatalog() {
  const { activeSkills, addActiveSkill, removeActiveSkill } = useAppStore();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [search, setSearch] = useState("");
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch("/api/skills")
      .then((res) => res.json())
      .then((data) => setSkills(Array.isArray(data) ? data : []))
      .catch(() => setSkills([]));
  }, []);

  const query = search.toLowerCase();
  const filtered = skills.filter(
    (s) =>
      s.name.toLowerCase().includes(query) ||
      s.description.toLowerCase().includes(query) ||
      s.tags.some((t) => t.toLowerCase().includes(query))
  );

  // Group by category
  const grouped = new Map<string, Skill[]>();
  for (const s of filtered) {
    const cat = s.category || "general";
    if (!grouped.has(cat)) grouped.set(cat, []);
    grouped.get(cat)!.push(s);
  }

  const toggleCategory = (cat: string) => {
    setCollapsedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  const toggleSkill = (id: string) => {
    if (activeSkills.includes(id)) {
      removeActiveSkill(id);
    } else {
      addActiveSkill(id);
    }
  };

  return (
    <div className="flex flex-col h-full bg-bg-secondary">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-2">
          <Wrench className="w-3.5 h-3.5 text-accent" />
          <span className="text-xs font-semibold text-text-primary">Tools</span>
          <span className="text-[10px] text-text-muted bg-bg-tertiary px-1.5 py-0.5 rounded-full">
            {skills.length}
          </span>
        </div>
        {activeSkills.length > 0 && (
          <span className="text-[10px] text-accent bg-accent/10 px-1.5 py-0.5 rounded-full">
            {activeSkills.length} active
          </span>
        )}
      </div>

      {/* Search */}
      <div className="px-3 py-2 flex-shrink-0">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tools..."
            className="w-full pl-8 pr-3 py-1.5 bg-bg-tertiary border border-border rounded-lg text-text-primary placeholder-text-muted focus:border-accent-dim outline-none text-xs"
          />
        </div>
      </div>

      {/* Tools list */}
      <div className="flex-1 overflow-y-auto px-3 pb-2">
        {filtered.length === 0 ? (
          <div className="text-center py-6 text-text-muted text-xs">
            No tools found
          </div>
        ) : (
          Array.from(grouped.entries()).map(([category, categorySkills]) => {
            const isCollapsed = collapsedCategories.has(category);
            return (
              <div key={category} className="mb-2">
                <button
                  onClick={() => toggleCategory(category)}
                  className="flex items-center gap-1.5 w-full text-left text-[10px] font-medium text-text-muted uppercase tracking-wide mb-1 px-1 py-0.5 hover:text-text-secondary transition-colors"
                >
                  {isCollapsed ? (
                    <ChevronRight className="w-3 h-3" />
                  ) : (
                    <ChevronDown className="w-3 h-3" />
                  )}
                  {category.replace(/-/g, " ")}
                  <span className="text-text-muted/60 ml-auto">{categorySkills.length}</span>
                </button>
                {!isCollapsed && (
                  <div className="space-y-1">
                    {categorySkills.map((skill) => {
                      const isActive = activeSkills.includes(skill.id);
                      const gpuInfo = GPU_MAP[skill.id];
                      return (
                        <button
                          key={skill.id}
                          onClick={() => toggleSkill(skill.id)}
                          className={`w-full text-left px-2.5 py-2 rounded-lg border transition-colors ${
                            isActive
                              ? "bg-accent/10 border-accent/50"
                              : "bg-bg-tertiary border-border hover:border-accent-dim"
                          }`}
                        >
                          <div className="flex items-start gap-2">
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="text-xs font-medium text-text-primary">
                                  {skill.name}
                                </span>
                                {isActive && (
                                  <span className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
                                )}
                              </div>
                              <div className="text-[11px] text-text-muted mt-0.5 line-clamp-2">
                                {skill.description}
                              </div>
                              <div className="flex flex-wrap items-center gap-1 mt-1">
                                {gpuInfo && (
                                  <GpuBadge gpu={gpuInfo.gpu} vram={gpuInfo.vram} />
                                )}
                                {skill.tags.slice(0, 3).map((tag) => (
                                  <span
                                    key={tag}
                                    className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-bg-primary text-[10px] text-text-muted"
                                  >
                                    <Tag className="w-2.5 h-2.5" />
                                    {tag}
                                  </span>
                                ))}
                              </div>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
