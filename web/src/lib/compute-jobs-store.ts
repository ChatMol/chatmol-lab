import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ComputeJob } from "./types";

// Standalone, localStorage-persisted registry of tracked background compute jobs
// (WeMol, ChatMol Bio, ChatMol Router).
// Kept separate from the main (non-persisted) app store so jobs survive a
// reload/relaunch and the in-app poller can resume checking them.
interface ComputeJobsState {
  jobs: ComputeJob[];
  addJob: (job: ComputeJob) => void;
  updateJob: (id: string, updates: Partial<ComputeJob>) => void;
  removeJob: (id: string) => void;
  clearFinished: () => void;
}

export const useComputeJobsStore = create<ComputeJobsState>()(
  persist(
    (set) => ({
      jobs: [],
      addJob: (job) =>
        set((s) =>
          s.jobs.some((j) => j.id === job.id) ? s : { jobs: [job, ...s.jobs] }
        ),
      updateJob: (id, updates) =>
        set((s) => ({
          jobs: s.jobs.map((j) =>
            j.id === id ? { ...j, ...updates, updatedAt: Date.now() } : j
          ),
        })),
      removeJob: (id) => set((s) => ({ jobs: s.jobs.filter((j) => j.id !== id) })),
      clearFinished: () =>
        set((s) => ({
          jobs: s.jobs.filter((j) => j.status !== "done" && j.status !== "failed"),
        })),
    }),
    // Storage key kept from the WeMol-only era so tracked jobs survive the upgrade.
    { name: "chatmol-wemol-jobs" }
  )
);

/** Statuses that still need polling. */
export function isActiveStatus(status: ComputeJob["status"]): boolean {
  return status === "pending" || status === "running" || status === "unknown";
}
