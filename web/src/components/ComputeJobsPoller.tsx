"use client";

import { useEffect, useRef, useState } from "react";
import { useComputeJobsStore, isActiveStatus } from "@/lib/compute-jobs-store";
import { checkComputeJobStatus } from "@/lib/api";
import { computeJobProviderLabel } from "@/lib/wemol-jobs";

const POLL_INTERVAL_MS = 25_000;

/**
 * Invisible poller: while the app is open, checks the status of any active
 * background compute jobs (WeMol, ChatMol Bio, Router) every ~25s and updates the store. Shows a transient toast when a
 * job finishes (mark-done + notify only — results are not auto-downloaded).
 */
export default function ComputeJobsPoller() {
  const [toast, setToast] = useState<string | null>(null);
  const pollingRef = useRef(false);

  useEffect(() => {
    const poll = async () => {
      if (pollingRef.current) return;
      const active = useComputeJobsStore
        .getState()
        .jobs.filter((j) => isActiveStatus(j.status));
      if (active.length === 0) return;
      pollingRef.current = true;
      try {
        for (const job of active) {
          const { status, message, progress, progressPercent } = await checkComputeJobStatus(job);
          const { updateJob } = useComputeJobsStore.getState();
          if (status !== job.status) {
            updateJob(job.id, { status, message, progress, progressPercent });
            if (status === "done") setToast(`${computeJobProviderLabel(job.provider)} job "${job.label}" finished ✓`);
            else if (status === "failed") setToast(`${computeJobProviderLabel(job.provider)} job "${job.label}" failed ✗`);
          } else if (
            (message && message !== job.message) ||
            progress !== job.progress ||
            progressPercent !== job.progressPercent
          ) {
            updateJob(job.id, { message, progress, progressPercent });
          }
        }
      } finally {
        pollingRef.current = false;
      }
    };

    const timer = setInterval(poll, POLL_INTERVAL_MS);
    // Kick once shortly after mount so freshly-submitted jobs update quickly.
    const kick = setTimeout(poll, 3_000);
    return () => {
      clearInterval(timer);
      clearTimeout(kick);
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6_000);
    return () => clearTimeout(t);
  }, [toast]);

  if (!toast) return null;
  return (
    <div className="fixed bottom-4 right-4 z-50 rounded-lg border border-border bg-bg-secondary px-4 py-2.5 text-sm text-text-primary shadow-lg">
      {toast}
    </div>
  );
}
