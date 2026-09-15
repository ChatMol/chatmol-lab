"use client";

import { useState } from "react";
import { Loader2, CheckCircle2, XCircle, Clock, HelpCircle, X } from "lucide-react";
import { useComputeJobsStore, isActiveStatus } from "@/lib/compute-jobs-store";
import { computeJobProviderLabel } from "@/lib/wemol-jobs";
import type { ComputeJobStatus } from "@/lib/types";

function statusMeta(status: ComputeJobStatus) {
  switch (status) {
    case "running":
      return { icon: <Loader2 className="w-3.5 h-3.5 animate-spin text-accent" />, label: "Running", cls: "text-accent" };
    case "done":
      return { icon: <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />, label: "Done", cls: "text-green-500" };
    case "failed":
      return { icon: <XCircle className="w-3.5 h-3.5 text-red-500" />, label: "Failed", cls: "text-red-500" };
    case "pending":
      return { icon: <Clock className="w-3.5 h-3.5 text-amber-500" />, label: "Pending", cls: "text-amber-500" };
    default:
      return { icon: <HelpCircle className="w-3.5 h-3.5 text-text-muted" />, label: "Unknown", cls: "text-text-muted" };
  }
}

function elapsed(fromMs: number): string {
  const s = Math.max(0, Math.floor((Date.now() - fromMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export default function ComputeJobsIndicator() {
  const jobs = useComputeJobsStore((s) => s.jobs);
  const removeJob = useComputeJobsStore((s) => s.removeJob);
  const clearFinished = useComputeJobsStore((s) => s.clearFinished);
  const [open, setOpen] = useState(false);

  if (jobs.length === 0) return null;

  const activeCount = jobs.filter((j) => isActiveStatus(j.status)).length;
  const hasFinished = jobs.some((j) => !isActiveStatus(j.status));

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        title="Background compute jobs"
        className="flex items-center gap-1.5 p-1.5 rounded-md bg-bg-tertiary/80 backdrop-blur border border-border text-text-muted hover:text-text-secondary transition-colors"
      >
        {activeCount > 0 ? (
          <Loader2 className="w-4 h-4 animate-spin text-accent" />
        ) : (
          <CheckCircle2 className="w-4 h-4 text-green-500" />
        )}
        <span className="text-xs font-medium tabular-nums">
          {activeCount > 0 ? activeCount : jobs.length}
        </span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-1 w-80 max-h-96 overflow-y-auto z-40 rounded-lg border border-border bg-bg-secondary shadow-xl">
            <div className="flex items-center justify-between px-3 py-2 border-b border-border">
              <span className="text-xs font-semibold text-text-primary">Background jobs</span>
              {hasFinished && (
                <button
                  onClick={() => clearFinished()}
                  className="text-xs text-text-muted hover:text-text-secondary"
                >
                  Clear finished
                </button>
              )}
            </div>
            <div className="divide-y divide-border">
              {jobs.map((job) => {
                const meta = statusMeta(job.status);
                return (
                  <div key={job.id} className="px-3 py-2 flex items-start gap-2">
                    <div className="mt-0.5">{meta.icon}</div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-text-primary truncate">{job.label}</span>
                        <span className={`text-[10px] font-medium flex-shrink-0 ${meta.cls}`}>{meta.label}</span>
                      </div>
                      <div className="text-[10px] text-text-muted font-mono truncate" title={job.id}>{computeJobProviderLabel(job.provider)} · {job.id}</div>
                      <div className="text-[10px] text-text-muted">{elapsed(job.submittedAt)} elapsed</div>
                      {typeof job.progressPercent === "number" && (
                        <div className="mt-1">
                          <div className="flex items-center justify-between text-[10px] text-text-muted">
                            <span>Progress</span>
                            <span className="font-mono">{job.progress || `${job.progressPercent}%`}</span>
                          </div>
                          <div className="mt-0.5 h-1 overflow-hidden rounded-full bg-bg-primary">
                            <div
                              className="h-full rounded-full bg-accent transition-all"
                              style={{ width: `${Math.max(0, Math.min(100, job.progressPercent))}%` }}
                            />
                          </div>
                        </div>
                      )}
                      {job.message && (
                        <div className="text-[10px] text-text-muted/80 mt-0.5 line-clamp-2">{job.message}</div>
                      )}
                    </div>
                    <button
                      onClick={() => removeJob(job.id)}
                      title="Remove from list"
                      className="text-text-muted hover:text-text-secondary flex-shrink-0"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="px-3 py-2 border-t border-border text-[10px] text-text-muted">
              Ask the assistant to download results when a job is done.
            </div>
          </div>
        </>
      )}
    </div>
  );
}
