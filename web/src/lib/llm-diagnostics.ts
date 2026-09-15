import { mkdirSync, writeFileSync } from "fs";
import { join, isAbsolute } from "path";
import { randomUUID } from "crypto";

/** Opt-in local captures contain research content. Never collect HTTP headers. */
export function captureLlmDiagnostic(kind: string, payload: unknown, secrets: string[] = []): void {
  const dir = process.env.CHATMOL_LLM_DIAGNOSTICS_DIR;
  if (!dir || !isAbsolute(dir)) return;
  try {
    let text = JSON.stringify(payload, (key, value) =>
      /^(authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)$/i.test(key) ? "[REDACTED]" : value, 2);
    for (const secret of secrets.filter(Boolean)) text = text.split(JSON.stringify(secret).slice(1, -1)).join("[REDACTED]");
    // Refuse oversized captures instead of silently truncating a replay request.
    if (Buffer.byteLength(text) > 20 * 1024 * 1024) { console.warn("[llm-diagnostics] capture exceeds 20 MiB; skipped"); return; }
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, `${Date.now()}-${kind.replace(/[^a-z0-9-]/gi, "_")}-${randomUUID()}.json`), text, { mode: 0o600, flag: "wx" });
  } catch { console.warn("[llm-diagnostics] could not save local capture"); }
}
