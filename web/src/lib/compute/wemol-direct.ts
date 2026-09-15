/**
 * Direct WeMol provider: runs the bundled wemol-cli with the account the user
 * configured in Settings. Jobs are billed by WeMol to that account.
 */
import type { ComputeJob } from "../types";
import { isTrackableSubmit, parseWemolJobId, summarizeWemolSubmit } from "../wemol-jobs";
import { terminalJob, type ProviderJob, type ComputeProvider, type ComputeRequest } from "./provider";

export const WEMOL_CAPABILITIES = ["wemol_cli"] as const;

async function execute(request: ComputeRequest): Promise<{ output: string; success: boolean; trackedJob?: ComputeJob }> {
    try {
      const input = request.inputs;
    const { sessionWorkspace, sessionId } = request;
    const command = (input.command as string).trim();

      // Block "job wait" — agent should not block on long-running jobs
      if (/^job\s+wait\b/i.test(command)) {
        return {
          output: "Do NOT use 'job wait' — it blocks for the entire job duration (can be 30+ minutes). Instead, use 'job status <id>' to check if the job is done. Report the job ID to the user and let them ask you to check later.",
          success: false,
        };
      }

      // Smart timeout: longer for download, shorter for queries
      const isDownload = /^job\s+download\b/i.test(command);
      const defaultTimeout = isDownload ? 300 : 120;
      const timeout = (input.timeout as number) || defaultTimeout;

      // Get user's WeMol credentials
      const { getUserWemolCredentials } = await import("../settings");
      const creds = await getUserWemolCredentials(request.userId);
      if (!creds) {
        return { output: "WeMol credentials not configured. Please set your WeMol username and password in Settings → API.", success: false };
      }

      const { resolveWemolCli, getWemolCliEnv, runWemolCli } = await import("../wemol-cli");
      const WEMOL_BIN = resolveWemolCli();
      const wemolEnv = getWemolCliEnv(WEMOL_BIN);

      // Ensure logged in (wemol-cli caches sessions locally, so this is fast on repeat calls)
      const loginResult = await runWemolCli([
        "login", "--username", creds.username, "--password", creds.password,
      ], { cwd: sessionWorkspace, timeoutMs: 15000, env: wemolEnv });
      if (loginResult.code !== 0 && !(loginResult.stdout + loginResult.stderr).includes("already")) {
        const errMsg = (loginResult.stderr || loginResult.stdout).slice(0, 500);
        return { output: `WeMol login failed: ${errMsg}`, success: false };
      }

      // Parse the command string into args
      const args = command.match(/(?:[^\s"]+|"[^"]*")+/g)?.map(s => s.replace(/^"|"$/g, "")) || [];

      const result = await runWemolCli(args, {
        cwd: sessionWorkspace,
        timeoutMs: timeout * 1000,
        env: wemolEnv,
      });

      const output = (result.stdout + (result.stderr ? `\n[stderr] ${result.stderr}` : "")).trim();
      const outputLimit = request.maxOutputChars ?? 8000;
      const truncated = output.length > outputLimit ? output.slice(0, outputLimit) + "\n...(truncated)" : output;

      // Track real (non-dry-run) `job submit` calls as background jobs.
      let trackedJob: ComputeJob | undefined;
      if (isTrackableSubmit(command) && result.code === 0) {
        const jobId = parseWemolJobId(output);
        if (jobId) {
          const now = Date.now();
          trackedJob = {
            id: jobId,
            provider: "wemol",
            sessionId,
            label: summarizeWemolSubmit(command),
            command,
            status: "pending",
            submittedAt: now,
            updatedAt: now,
          };
        }
      }

      return { output: truncated || "(no output)", success: result.code === 0, trackedJob };
    } catch (err: any) {
      return { output: `wemol_cli error: ${err.message}`, success: false };
    }
}

export const wemolDirectProvider: ComputeProvider = {
  id: "wemol-direct",
  label: "WeMol (your account)",
  kind: "direct",
  capabilities: () => WEMOL_CAPABILITIES,
  async availability({ userId }) {
    const { getUserWemolCredentials } = await import("../settings");
    const creds = await getUserWemolCredentials(userId).catch(() => null);
    return creds
      ? { ok: true }
      : { ok: false, reason: "WeMol credentials not configured. Set your WeMol username and password in Settings → API." };
  },
  async submit(request: ComputeRequest): Promise<ProviderJob> {
    const result = await execute(request);
    return terminalJob(this.id, request.capability, result);
  },
  async getJob() { return null; },
  async cancel() {},
};
