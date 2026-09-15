"use client";

import { useEffect, useState } from "react";

export interface DeploymentInfo {
  mode: "local" | "hosted";
  electron: boolean;
  cloud: { remoteUrl: string; connected: boolean };
}

let cached: DeploymentInfo | null = null;
let inflight: Promise<DeploymentInfo | null> | null = null;

export async function fetchDeployment(force = false): Promise<DeploymentInfo | null> {
  if (cached && !force) return cached;
  if (!inflight) {
    inflight = fetch("/api/deployment", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<DeploymentInfo>) : null))
      .then((info) => { cached = info; return info; })
      .catch(() => null)
      .finally(() => { inflight = null; });
  }
  return inflight;
}

/** Deployment facts for the UI; `null` until the first fetch resolves. */
export function useDeployment(): DeploymentInfo | null {
  const [info, setInfo] = useState<DeploymentInfo | null>(cached);
  useEffect(() => {
    let live = true;
    fetchDeployment().then((next) => { if (live) setInfo(next); });
    return () => { live = false; };
  }, []);
  return info;
}
