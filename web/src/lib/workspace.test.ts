import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { safeResolvePath } from "./workspace";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe("workspace real path boundary", () => {
  it("allows files, new descendants and internal links but rejects external and dangling links", () => {
    const root = mkdtempSync(join(tmpdir(), "workspace-boundary-")); dirs.push(root);
    const workspace = join(root, "workspace"); const outside = join(root, "outside");
    mkdirSync(workspace); mkdirSync(outside); mkdirSync(join(workspace, "data"));
    writeFileSync(join(workspace, "data", "ok.txt"), "ok");
    symlinkSync(outside, join(workspace, "escape"), "junction");
    symlinkSync(join(workspace, "data"), join(workspace, "inside"), "junction");
    symlinkSync(join(outside, "missing"), join(workspace, "dangling"));
    expect(safeResolvePath("inside/ok.txt", workspace)).toBe(join(realpathSync(workspace), "data/ok.txt"));
    expect(safeResolvePath("inside/new/deep.txt", workspace)).toBe(join(realpathSync(workspace), "data/new/deep.txt"));
    expect(safeResolvePath("escape/new.txt", workspace)).toBeNull();
    expect(safeResolvePath("dangling", workspace)).toBeNull();
    expect(safeResolvePath("../outside/x", workspace)).toBeNull();
    mkdirSync(join(workspace, ".private"));
    symlinkSync(join(workspace, ".private"), join(workspace, "alias"), "junction");
    expect(safeResolvePath("alias/key", workspace)).toBeNull();
  });
});
