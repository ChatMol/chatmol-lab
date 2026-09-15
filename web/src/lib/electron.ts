/**
 * Electron detection utilities.
 * Used to branch behavior between web (server-hosted) and desktop (Electron) modes.
 */

/** Client-side check: true if running inside the Electron BrowserWindow. */
export function isElectronClient(): boolean {
  if (typeof window === "undefined") return false;
  return !!(window as { electronAPI?: { isElectron: boolean } }).electronAPI
    ?.isElectron;
}

/** Server-side check: true if the Next.js server is running inside Electron. */
export function isElectronServer(): boolean {
  return process.env.NEXT_PUBLIC_IS_ELECTRON === "true";
}
