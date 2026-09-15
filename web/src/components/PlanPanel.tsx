"use client";

import {
  ChevronRight,
  CheckCircle2,
  Circle,
  Loader2,
  AlertCircle,
  FileText,
  FolderOpen,
  Search,
  ListTodo,
  Files,
  FlaskConical,
  Bot,
} from "lucide-react";
import { useAppStore } from "@/lib/store";
import SubagentsPanel from "./SubagentsPanel";
import type { PlanStep, Artifact } from "@/lib/types";
import { isStructureFile, getArtifactType } from "@/lib/types";
import { fetchFileList } from "@/lib/api";
import { useState, useEffect, useCallback } from "react";

function PlanStepItem({ step, depth = 0 }: { step: PlanStep; depth?: number }) {
  const { updatePlanStep } = useAppStore();
  const [expanded, setExpanded] = useState(true);

  const statusIcon = {
    pending: <Circle className="w-4 h-4 text-text-muted" />,
    in_progress: <Loader2 className="w-4 h-4 text-warning animate-spin" />,
    completed: <CheckCircle2 className="w-4 h-4 text-success" />,
    error: <AlertCircle className="w-4 h-4 text-error" />,
  };

  return (
    <div>
      <div
        className={`flex items-start gap-2 py-1.5 px-2 rounded-md hover:bg-bg-hover transition-colors cursor-default ${
          step.status === "in_progress" ? "bg-bg-hover" : ""
        }`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
      >
        {step.substeps && step.substeps.length > 0 && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="mt-0.5 text-text-muted hover:text-text-secondary"
          >
            <ChevronRight
              className={`w-3.5 h-3.5 transition-transform ${expanded ? "rotate-90" : ""}`}
            />
          </button>
        )}
        <div className="mt-0.5 shrink-0">{statusIcon[step.status]}</div>
        <div className="flex-1 min-w-0">
          <div
            className={`text-sm ${
              step.status === "completed"
                ? "text-text-muted line-through"
                : step.status === "in_progress"
                  ? "text-text-primary font-medium"
                  : "text-text-secondary"
            }`}
          >
            {step.title}
          </div>
          {step.description && (step.status === "in_progress" || step.status === "completed" || step.status === "error") && (
            <div className={`text-xs mt-0.5 ${
              step.status === "error" ? "text-error" : "text-text-muted"
            }`}>
              {step.description}
            </div>
          )}
        </div>
      </div>
      {expanded &&
        step.substeps?.map((sub) => (
          <PlanStepItem key={sub.id} step={sub} depth={depth + 1} />
        ))}
    </div>
  );
}

function PlanView() {
  const session = useAppStore((s) => s.getActiveSession());
  const plan = session?.plan || [];

  if (plan.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center px-6">
        <ListTodo className="w-10 h-10 text-text-muted mb-3" />
        <div className="text-sm text-text-muted">No plan yet</div>
        <div className="text-xs text-text-muted mt-1">
          Plans appear for multi-step tasks
        </div>
      </div>
    );
  }

  return (
    <div className="py-2">
      {plan.map((step) => (
        <PlanStepItem key={step.id} step={step} />
      ))}
    </div>
  );
}

function FileIcon({ type }: { type: string }) {
  if (isStructureFile(type as any)) {
    return <FlaskConical className="w-4 h-4 text-accent" />;
  }
  return <FileText className="w-4 h-4 text-text-muted" />;
}

interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children: Map<string, TreeNode>;
}

function buildTree(files: string[]): TreeNode {
  const root: TreeNode = { name: "", path: "", isDir: true, children: new Map() };
  for (const filePath of files) {
    const parts = filePath.split("/");
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      if (!current.children.has(part)) {
        current.children.set(part, {
          name: part,
          path: parts.slice(0, i + 1).join("/"),
          isDir: !isLast,
          children: new Map(),
        });
      }
      current = current.children.get(part)!;
    }
  }
  return root;
}

function filterTree(node: TreeNode, text: string): TreeNode | null {
  if (!node.isDir) {
    return node.name.toLowerCase().includes(text) ? node : null;
  }
  const filtered = new Map<string, TreeNode>();
  for (const [key, child] of node.children) {
    const result = filterTree(child, text);
    if (result) filtered.set(key, result);
  }
  if (filtered.size === 0) return null;
  return { ...node, children: filtered };
}

function TreeNodeItem({
  node,
  depth,
  artifactMap,
  selectedPath,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  artifactMap: Map<string, Artifact>;
  selectedPath: string | null;
  onSelect: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState(depth < 2);

  if (node.isDir) {
    const children = Array.from(node.children.values()).sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return (
      <div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1.5 w-full px-2 py-1 rounded-md text-sm text-text-secondary hover:bg-bg-hover transition-colors"
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
        >
          <ChevronRight className={`w-3 h-3 text-text-muted transition-transform ${expanded ? "rotate-90" : ""}`} />
          <FolderOpen className="w-4 h-4 text-accent-dim" />
          <span className="truncate">{node.name}</span>
        </button>
        {expanded && children.map((child) => (
          <TreeNodeItem
            key={child.path}
            node={child}
            depth={depth + 1}
            artifactMap={artifactMap}
            selectedPath={selectedPath}
            onSelect={onSelect}
          />
        ))}
      </div>
    );
  }

  const isSelected = selectedPath === node.path;
  return (
    <button
      onClick={() => onSelect(node.path)}
      className={`flex items-center gap-1.5 w-full px-2 py-1 rounded-md text-sm transition-colors ${
        isSelected ? "bg-bg-active text-text-primary" : "text-text-secondary hover:bg-bg-hover"
      }`}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
    >
      <FileIcon type={getArtifactType(node.name)} />
      <span className="truncate">{node.name}</span>
    </button>
  );
}

function ResultsView() {
  const session = useAppStore((s) => s.getActiveSession());
  const { selectArtifact, selectedArtifact, workspaceFiles, setWorkspaceFiles } = useAppStore();
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const artifacts = session?.artifacts || [];
  const [filterText, setFilterText] = useState("");

  const refreshFiles = useCallback(() => {
    if (activeSessionId) {
      fetchFileList(activeSessionId).then((files) => setWorkspaceFiles(files)).catch(() => {});
    }
  }, [activeSessionId, setWorkspaceFiles]);

  useEffect(() => {
    refreshFiles();
  }, [refreshFiles]);

  // Build artifact lookup by path
  const artifactMap = new Map<string, Artifact>();
  for (const a of artifacts) {
    // Store by relative path (filename portion after workspace dir)
    const parts = a.path.split("/");
    const name = parts[parts.length - 1];
    artifactMap.set(a.path, a);
    artifactMap.set(name, a);
  }

  // Merge workspace files with artifact paths
  const allFiles = new Set<string>(workspaceFiles);
  // artifacts may have absolute paths — extract relative names too
  for (const a of artifacts) {
    const parts = a.path.split("/");
    allFiles.add(parts[parts.length - 1]);
  }

  const tree = buildTree(Array.from(allFiles));
  const lowerFilter = filterText.toLowerCase();
  const displayTree = filterText ? filterTree(tree, lowerFilter) : tree;

  const handleFileSelect = (filePath: string) => {
    // Check if there's an existing artifact for this path
    const existing = artifactMap.get(filePath);
    if (existing) {
      selectArtifact(existing);
      return;
    }
    // Create an on-the-fly artifact
    const fileName = filePath.split("/").pop() || filePath;
    const type = getArtifactType(fileName);
    const artifact: Artifact = {
      id: `ws-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name: fileName,
      type,
      path: filePath,
    };
    selectArtifact(artifact);
  };

  const selectedPath = selectedArtifact?.path?.split("/").pop() || null;

  const children = displayTree
    ? Array.from(displayTree.children.values()).sort((a, b) => {
        if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      })
    : [];

  return (
    <div className="flex flex-col h-full">
      {/* Search */}
      <div className="px-3 py-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted" />
          <input
            type="text"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder="Filter files..."
            className="w-full bg-bg-primary border border-border rounded-md pl-8 pr-3 py-1.5 text-xs text-text-primary placeholder-text-muted outline-none focus:border-accent-dim transition-colors"
          />
        </div>
      </div>

      {/* File tree */}
      <div className="flex-1 overflow-y-auto px-3 py-1">
        {children.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 text-center">
            <Files className="w-8 h-8 text-text-muted mb-2" />
            <div className="text-xs text-text-muted">
              {workspaceFiles.length === 0 && artifacts.length === 0
                ? "No files yet"
                : "No matching files"}
            </div>
          </div>
        ) : (
          children.map((node) => (
            <TreeNodeItem
              key={node.path}
              node={node}
              depth={0}
              artifactMap={artifactMap}
              selectedPath={selectedPath}
              onSelect={handleFileSelect}
            />
          ))
        )}
      </div>
    </div>
  );
}

export default function PlanPanel() {
  const { leftPanelTab, setLeftPanelTab } = useAppStore();
  const subagentRuns = useAppStore((s) => s.getActiveSession()?.subagentRuns?.length || 0);

  return (
    <div className="flex flex-col h-full bg-bg-secondary">
      {/* Tab headers */}
      <div className="flex border-b border-border">
        <button
          onClick={() => setLeftPanelTab("plan")}
          className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-medium transition-colors ${
            leftPanelTab === "plan"
              ? "text-accent border-b-2 border-accent"
              : "text-text-muted hover:text-text-secondary"
          }`}
        >
          <ListTodo className="w-3.5 h-3.5" />
          Plan
        </button>
        <button
          onClick={() => setLeftPanelTab("results")}
          className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-medium transition-colors ${
            leftPanelTab === "results"
              ? "text-accent border-b-2 border-accent"
              : "text-text-muted hover:text-text-secondary"
          }`}
        >
          <Files className="w-3.5 h-3.5" />
          Results
        </button>
        <button
          onClick={() => setLeftPanelTab("subagents")}
          className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-medium transition-colors ${
            leftPanelTab === "subagents"
              ? "text-accent border-b-2 border-accent"
              : "text-text-muted hover:text-text-secondary"
          }`}
        >
          <Bot className="w-3.5 h-3.5" />
          Subagents
          {subagentRuns > 0 && (
            <span className="rounded-full bg-bg-tertiary px-1.5 py-0.5 text-[10px] text-text-muted">{subagentRuns}</span>
          )}
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {leftPanelTab === "plan" ? <PlanView /> : leftPanelTab === "results" ? <ResultsView /> : <SubagentsPanel />}
      </div>
    </div>
  );
}
