"use client";

import { useState, useEffect } from "react";
import { Search, X, Tag } from "lucide-react";

interface Skill {
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
}

interface SkillPickerProps {
  open: boolean;
  onClose: () => void;
  onSelect: (skillIds: string[]) => void;
  selectedSkills: string[];
}

export default function SkillPicker({
  open,
  onClose,
  onSelect,
  selectedSkills,
}: SkillPickerProps) {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(
    new Set(selectedSkills)
  );

  useEffect(() => {
    if (open) {
      fetch("/api/skills")
        .then((res) => res.json())
        .then((data) => setSkills(Array.isArray(data) ? data : []))
        .catch(() => setSkills([]));
    }
  }, [open]);

  useEffect(() => {
    setSelected(new Set(selectedSkills));
  }, [selectedSkills]);

  if (!open) return null;

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

  const toggleSkill = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const handleConfirm = () => {
    onSelect(Array.from(selected));
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="w-full max-w-2xl max-h-[80vh] flex flex-col bg-bg-secondary border border-border rounded-xl shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h3 className="text-lg font-semibold text-text-primary">
            Select Skills
          </h3>
          <button
            onClick={onClose}
            className="p-1 text-text-muted hover:text-text-primary transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Search */}
        <div className="px-4 py-3 border-b border-border">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-muted" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search skills..."
              className="w-full pl-10 pr-4 py-2 bg-bg-tertiary border border-border rounded-lg text-text-primary placeholder-text-muted focus:border-accent-dim outline-none text-sm"
              autoFocus
            />
          </div>
        </div>

        {/* Skills list */}
        <div className="flex-1 overflow-y-auto px-4 py-2">
          {filtered.length === 0 ? (
            <div className="text-center py-8 text-text-muted text-sm">
              No skills found
            </div>
          ) : (
            Array.from(grouped.entries()).map(([category, categorySkills]) => (
              <div key={category} className="mb-4">
                <div className="text-xs font-medium text-text-muted uppercase tracking-wide mb-2 px-1">
                  {category.replace(/-/g, " ")}
                </div>
                <div className="space-y-1.5">
                  {categorySkills.map((skill) => (
                    <button
                      key={skill.id}
                      onClick={() => toggleSkill(skill.id)}
                      className={`w-full text-left px-3 py-2.5 rounded-lg border transition-colors ${
                        selected.has(skill.id)
                          ? "bg-accent/10 border-accent"
                          : "bg-bg-tertiary border-border hover:border-accent-dim"
                      }`}
                    >
                      <div className="flex items-start gap-2.5">
                        <input
                          type="checkbox"
                          checked={selected.has(skill.id)}
                          onChange={() => {}}
                          className="mt-0.5 accent-[var(--accent)]"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-text-primary">
                            {skill.name}
                          </div>
                          <div className="text-xs text-text-muted mt-0.5 line-clamp-2">
                            {skill.description}
                          </div>
                          {skill.tags.length > 0 && (
                            <div className="flex flex-wrap gap-1 mt-1.5">
                              {skill.tags.slice(0, 4).map((tag) => (
                                <span
                                  key={tag}
                                  className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-bg-primary text-[10px] text-text-muted"
                                >
                                  <Tag className="w-2.5 h-2.5" />
                                  {tag}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-3 border-t border-border">
          <div className="text-xs text-text-muted">
            {selected.size} skill{selected.size !== 1 ? "s" : ""} selected
          </div>
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3 py-1.5 rounded-lg border border-border text-text-secondary hover:bg-bg-hover transition-colors text-sm"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              className="px-3 py-1.5 rounded-lg bg-accent text-white hover:opacity-90 transition-opacity text-sm"
            >
              Confirm
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
