"use client";

import { useState, useEffect, lazy, Suspense } from "react";
import { isolatedHtml } from "@/lib/html-preview";
import {
  X,
  Download,
  Maximize2,
  Minimize2,
  ExternalLink,
  FileText,
  Copy,
  Check,
  Eye,
  Code,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useAppStore } from "@/lib/store";
import { fetchFile, getFileServeUrl } from "@/lib/api";
import { isStructureFile, getArtifactType } from "@/lib/types";
import type { Artifact } from "@/lib/types";

const MolstarViewer = lazy(() => import("./MolstarViewer"));

function CodeViewer({ content, language }: { content: string; language?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="relative h-full">
      <button
        onClick={handleCopy}
        className="absolute top-2 right-2 z-10 p-1.5 bg-bg-tertiary border border-border rounded-md hover:bg-bg-hover transition-colors"
      >
        {copied ? (
          <Check className="w-3.5 h-3.5 text-success" />
        ) : (
          <Copy className="w-3.5 h-3.5 text-text-muted" />
        )}
      </button>
      <pre className="h-full overflow-auto p-4 text-sm font-mono text-text-primary bg-bg-primary">
        <code>{content}</code>
      </pre>
    </div>
  );
}

function ImageViewer({ src, alt }: { src: string; alt: string }) {
  return (
    <div className="flex items-center justify-center h-full bg-bg-primary p-4">
      <img
        src={src}
        alt={alt}
        className="max-w-full max-h-full object-contain rounded"
      />
    </div>
  );
}

function TableViewer({ content }: { content: string }) {
  const rows = content.split("\n").map((line) => line.split(","));
  const headers = rows[0] || [];
  const data = rows.slice(1);

  return (
    <div className="h-full overflow-auto">
      <table className="w-full text-sm border-collapse">
        <thead className="sticky top-0 bg-bg-tertiary">
          <tr>
            {headers.map((h, i) => (
              <th
                key={i}
                className="px-3 py-2 text-left border-b border-border text-text-secondary font-medium"
              >
                {h.trim().replace(/^"|"$/g, "")}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.slice(0, 1000).map((row, i) => (
            <tr key={i} className="hover:bg-bg-hover">
              {row.map((cell, j) => (
                <td
                  key={j}
                  className="px-3 py-1.5 border-b border-border text-text-primary"
                >
                  {cell.trim().replace(/^"|"$/g, "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {data.length > 1000 && (
        <div className="text-center py-2 text-xs text-text-muted">
          Showing first 1000 of {data.length} rows
        </div>
      )}
    </div>
  );
}

function MarkdownViewer({ content }: { content: string }) {
  return (
    <div className="h-full overflow-auto p-4">
      <div className="markdown-body">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
      </div>
    </div>
  );
}

function HtmlViewer({ content }: { content: string }) {
  const [showSource, setShowSource] = useState(false);

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-1 px-2 py-1 border-b border-border bg-bg-primary shrink-0">
        <button
          onClick={() => setShowSource(false)}
          className={`flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors ${
            !showSource
              ? "bg-bg-tertiary text-text-primary"
              : "text-text-muted hover:text-text-secondary"
          }`}
        >
          <Eye className="w-3 h-3" />
          Rendered
        </button>
        <button
          onClick={() => setShowSource(true)}
          className={`flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors ${
            showSource
              ? "bg-bg-tertiary text-text-primary"
              : "text-text-muted hover:text-text-secondary"
          }`}
        >
          <Code className="w-3 h-3" />
          Source
        </button>
      </div>
      {showSource ? (
        <div className="flex-1 min-h-0 overflow-hidden">
          <CodeViewer content={content} language="html" />
        </div>
      ) : (
        <div className="flex-1 min-h-0 relative">
          <iframe
            srcDoc={isolatedHtml(content)}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            className="absolute inset-0 w-full h-full border-0 bg-white"
            title="HTML Preview"
          />
        </div>
      )}
    </div>
  );
}

function FastaViewer({ content }: { content: string }) {
  const sequences = content.split(">").filter(Boolean);

  return (
    <div className="h-full overflow-auto p-4 space-y-3">
      {sequences.map((seq, i) => {
        const lines = seq.trim().split("\n");
        const header = lines[0];
        const sequence = lines.slice(1).join("");
        return (
          <div key={i} className="bg-bg-primary border border-border rounded-lg p-3">
            <div className="text-xs text-accent font-mono mb-2 break-all">
              &gt;{header}
            </div>
            <div className="text-sm font-mono text-text-primary break-all leading-relaxed tracking-wider">
              {sequence.match(/.{1,80}/g)?.map((chunk, j) => (
                <div key={j}>{chunk}</div>
              ))}
            </div>
            <div className="text-xs text-text-muted mt-2">
              Length: {sequence.length} residues
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function FilePreview() {
  const { selectedArtifact, selectArtifact, activeSessionId, openArtifactPaths, closeArtifactTab, setStructureSelection } = useAppStore();
  const session = useAppStore((s) => s.getActiveSession());
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // Deduplicate artifacts by path (keep last), then ensure unique IDs for React keys
  const allArtifacts = (() => {
    const raw = session?.artifacts || [];
    const byPath = new Map<string, Artifact>();
    for (const a of raw) byPath.set(a.path, a);
    return Array.from(byPath.values());
  })();
  // Only show artifacts that are in openArtifactPaths (preserving open order)
  const openArtifacts = openArtifactPaths
    .map((p) => allArtifacts.find((a) => a.path === p))
    .filter((a): a is Artifact => a !== undefined);

  useEffect(() => {
    // Always clear stale content immediately so the previous file's data
    // never leaks into the next viewer while the fetch is in-flight.
    setContent(null);

    if (!selectedArtifact) return;

    // If the artifact already has content, use it
    if (selectedArtifact.content) {
      setContent(selectedArtifact.content);
      return;
    }

    // Otherwise fetch
    setLoading(true);
    fetchFile(selectedArtifact.path, activeSessionId || undefined)
      .then((data) => {
        setContent(data);
        setLoading(false);
      })
      .catch(() => {
        setContent(null);
        setLoading(false);
      });
  }, [selectedArtifact]);

  if (!selectedArtifact) {
    return (
      <div className="flex flex-col items-center justify-center h-full bg-bg-secondary text-text-muted text-center px-6">
        <FileText className="w-12 h-12 mb-3 opacity-30" />
        <div className="text-sm">Select a file to preview</div>
        <div className="text-xs mt-1">
          Molecular structures will render in 3D
        </div>
      </div>
    );
  }

  const renderContent = () => {
    if (loading) {
      return (
        <div className="flex items-center justify-center h-full">
          <div className="flex items-center gap-2 text-text-secondary">
            <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            <span className="text-sm">Loading...</span>
          </div>
        </div>
      );
    }

    if (!content && selectedArtifact.type !== "image") {
      return (
        <div className="flex items-center justify-center h-full text-text-muted">
          <div className="text-center">
            <div className="text-sm">Unable to load file content</div>
            <div className="text-xs mt-1">File may not be accessible</div>
          </div>
        </div>
      );
    }

    // Derive type from the file path (which always has the real extension),
    // falling back to the stored type for edge cases.
    const fileFromPath = selectedArtifact.path.split(/[/\\]/).pop() || selectedArtifact.name;
    const detectedType = getArtifactType(fileFromPath);
    const effectiveType = detectedType !== "unknown" ? detectedType : selectedArtifact.type;

    if (isStructureFile(effectiveType)) {
      return (
        <Suspense
          fallback={
            <div className="flex items-center justify-center h-full">
              <div className="w-5 h-5 border-2 border-accent border-t-transparent rounded-full animate-spin" />
            </div>
          }
        >
          <MolstarViewer
            data={content || ""}
            format={effectiveType as "pdb" | "cif" | "mmcif"}
            filename={selectedArtifact.name}
            onSelectionChange={(ctx) =>
              setStructureSelection(ctx ? { ...ctx, path: selectedArtifact.path } : null)
            }
          />
        </Suspense>
      );
    }

    switch (effectiveType) {
      case "csv":
      case "tsv":
        return <TableViewer content={content || ""} />;
      case "fasta":
        return <FastaViewer content={content || ""} />;
      case "html":
        return <HtmlViewer content={content || ""} />;
      case "markdown":
        return <MarkdownViewer content={content || ""} />;
      case "image":
        return (
          <ImageViewer
            src={selectedArtifact.previewUrl || getFileServeUrl(selectedArtifact.path, activeSessionId || undefined)}
            alt={selectedArtifact.name}
          />
        );
      case "python":
      case "r":
      case "json":
        return (
          <CodeViewer content={content || ""} language={selectedArtifact.type} />
        );
      default:
        return <CodeViewer content={content || ""} />;
    }
  };

  return (
    <div
      className={`flex flex-col h-full bg-bg-secondary border-l border-border ${
        expanded ? "fixed inset-0 z-50" : ""
      }`}
    >
      {/* Tabs */}
      {openArtifacts.length > 1 && (
        <div className="flex items-center overflow-x-auto border-b border-border bg-bg-primary">
          {openArtifacts.map((artifact) => (
            <button
              key={artifact.id}
              onClick={() => selectArtifact(artifact)}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs whitespace-nowrap border-r border-border transition-colors ${
                selectedArtifact?.id === artifact.id
                  ? "bg-bg-secondary text-text-primary"
                  : "text-text-muted hover:text-text-secondary hover:bg-bg-hover"
              }`}
            >
              <FileText className="w-3 h-3" />
              <span>{artifact.name}</span>
              <span
                role="button"
                onClick={(e) => {
                  e.stopPropagation();
                  closeArtifactTab(artifact.path);
                }}
                className="ml-1 hover:text-error cursor-pointer"
              >
                <X className="w-3 h-3" />
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-bg-secondary">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium text-text-primary truncate">
            {selectedArtifact.name}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => {
              // Ensure download filename has the file extension from the path
              const pathExt = selectedArtifact.path.includes(".") ? selectedArtifact.path.split(".").pop() : "";
              const nameHasExt = selectedArtifact.name.includes(".") && selectedArtifact.name.split(".").pop() === pathExt;
              const downloadName = pathExt && !nameHasExt ? `${selectedArtifact.name}.${pathExt}` : selectedArtifact.name;

              if (selectedArtifact.type === "image" || !content) {
                // Use download endpoint for binary files
                const a = document.createElement("a");
                a.href = `/api/files/download?path=${encodeURIComponent(selectedArtifact.path)}${activeSessionId ? `&sessionId=${encodeURIComponent(activeSessionId)}` : ""}`;
                a.download = downloadName;
                a.click();
              } else {
                const blob = new Blob([content], {
                  type: "application/octet-stream",
                });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = downloadName;
                a.click();
                URL.revokeObjectURL(url);
              }
            }}
            className="p-1.5 text-text-muted hover:text-text-secondary rounded-md hover:bg-bg-hover transition-colors"
            title="Download"
          >
            <Download className="w-4 h-4" />
          </button>
          <button
            onClick={() => setExpanded(!expanded)}
            className="p-1.5 text-text-muted hover:text-text-secondary rounded-md hover:bg-bg-hover transition-colors"
            title={expanded ? "Minimize" : "Maximize"}
          >
            {expanded ? (
              <Minimize2 className="w-4 h-4" />
            ) : (
              <Maximize2 className="w-4 h-4" />
            )}
          </button>
          <button
            onClick={() => closeArtifactTab(selectedArtifact.path)}
            className="p-1.5 text-text-muted hover:text-text-secondary rounded-md hover:bg-bg-hover transition-colors"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">{renderContent()}</div>
    </div>
  );
}
