"use client";

/**
 * ChatMol Lab (open source) runs in local mode only: there is no hosted
 * account flow, so this screen is reached only when CHATMOL_DEPLOYMENT=hosted
 * is set without a hosted adapter.
 */
export type HostedEntryState = "landing" | "waitlist";

export default function HostedEntry({ state }: { state: HostedEntryState; email?: string | null }) {
  void state;
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-bg-primary">
      <div className="max-w-md rounded-xl border border-border bg-bg-secondary p-8 text-center">
        <h1 className="text-lg font-semibold text-text-primary">Hosted mode is not available in this build</h1>
        <p className="mt-2 text-sm text-text-secondary">
          ChatMol Lab runs as a local workbench. Remove <code>CHATMOL_DEPLOYMENT=hosted</code> from the environment to
          use it without an account.
        </p>
      </div>
    </div>
  );
}
