/**
 * Deployment mode.
 *
 * ChatMol Lab runs in one of two modes:
 *
 * - `local`  — the desktop app and `npm run dev`. There is no account: the
 *              server mints a session for a single local principal so every
 *              route keyed by user id keeps working. Compute is paid directly
 *              by the user (their own LLM / NVIDIA / WeMol credentials).
 * - `hosted` — the ChatMol-operated web service. Accounts, the wallet and
 *              usage limits live in the private hosted adapter
 *              (`web/src/hosted/`), never in the shared runtime.
 *
 * `hosted` is opt-in via `CHATMOL_DEPLOYMENT=hosted`; everything else is local.
 */
export type DeploymentMode = "local" | "hosted";

export function getDeploymentMode(env: NodeJS.ProcessEnv = process.env): DeploymentMode {
  return env.CHATMOL_DEPLOYMENT === "hosted" ? "hosted" : "local";
}

export function isHostedDeployment(env: NodeJS.ProcessEnv = process.env): boolean {
  return getDeploymentMode(env) === "hosted";
}

export function isLocalDeployment(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isHostedDeployment(env);
}

/** Identity of the single local principal (never an external account). */
export const LOCAL_PRINCIPAL_EMAIL = "local@chatmol.lab";
export const LOCAL_PRINCIPAL_NAME = "Local workspace";
/** Email used by pre-0.9.1 desktop builds; adopted so history is not orphaned. */
export const LEGACY_LOCAL_PRINCIPAL_EMAIL = "local@chatmol.desktop";
