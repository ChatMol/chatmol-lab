import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("system prompt settings", () => {
  let tmpDir: string;
  let originalSettingsPath: string | undefined;
  let originalElectronFlag: string | undefined;

  beforeEach(() => {
    vi.resetModules();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatmol-settings-"));
    originalSettingsPath = process.env.SETTINGS_PATH;
    originalElectronFlag = process.env.NEXT_PUBLIC_IS_ELECTRON;
    process.env.SETTINGS_PATH = path.join(tmpDir, ".settings.json");
    delete process.env.NEXT_PUBLIC_IS_ELECTRON;
  });

  afterEach(() => {
    if (originalSettingsPath === undefined) {
      delete process.env.SETTINGS_PATH;
    } else {
      process.env.SETTINGS_PATH = originalSettingsPath;
    }
    if (originalElectronFlag === undefined) {
      delete process.env.NEXT_PUBLIC_IS_ELECTRON;
    } else {
      process.env.NEXT_PUBLIC_IS_ELECTRON = originalElectronFlag;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists and reads a local unauthenticated custom system prompt", async () => {
    const { getUserSystemPrompt, saveUserSystemPrompt } = await import("./settings");

    await saveUserSystemPrompt(null, "Prefer concise scientific reports.");

    expect(await getUserSystemPrompt(null)).toBe("Prefer concise scientific reports.");
    expect(JSON.parse(fs.readFileSync(process.env.SETTINGS_PATH!, "utf-8")).systemPrompt)
      .toBe("Prefer concise scientific reports.");
  });

  it("uses the file prompt as the guest fallback for chat requests", async () => {
    fs.writeFileSync(process.env.SETTINGS_PATH!, JSON.stringify({ systemPrompt: "Always cite artifact paths." }));
    const { getUserSystemPrompt } = await import("./settings");

    expect(await getUserSystemPrompt(null)).toBe("Always cite artifact paths.");
  });
});
