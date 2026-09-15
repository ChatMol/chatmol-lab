import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";

import {
  getDefaultRuntimeShellPath,
  getRuntimeStatus,
  getWslRuntimePrelude,
  windowsPathToWsl,
} from "./runtime";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "chatmol-runtime-"));
  tempDirs.push(dir);
  return dir;
}

function touchExecutable(filePath: string) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, "#!/bin/sh\n");
  chmodSync(filePath, 0o755);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("getRuntimeStatus", () => {
  it("discovers the bundled native conda runtime on macOS", () => {
    const prefix = makeTempDir();
    touchExecutable(path.join(prefix, "bin", "conda"));
    touchExecutable(path.join(prefix, "bin", "python"));
    touchExecutable(path.join(prefix, "bin", "wemol-cli"));

    const status = getRuntimeStatus(
      {
        IS_ELECTRON: "true",
        CHATMOL_CONDA_PREFIX: prefix,
      },
      "darwin",
    );

    expect(status.isElectron).toBe(true);
    expect(status.activeBackend).toBe("native");
    expect(status.native.ready).toBe(true);
    expect(status.native.pathPrepend).toBe(path.posix.join(prefix, "bin"));
    expect(getDefaultRuntimeShellPath({ CHATMOL_CONDA_PREFIX: prefix }, "darwin")).toBe(
      path.posix.join(prefix, "bin"),
    );
  });

  it("falls back to the system backend when no managed runtime exists", () => {
    const status = getRuntimeStatus({}, "darwin");

    expect(status.activeBackend).toBe("system");
    expect(status.native.ready).toBe(false);
    expect(status.native.pathPrepend).toBe("");
  });

  it("keeps Windows native conda paths in Windows form when tested off-platform", () => {
    const prefix = String.raw`C:\Users\me\AppData\Roaming\chatmol-lab\runtime\mambaforge`;
    const pathPrepend = [
      prefix,
      String.raw`C:\Users\me\AppData\Roaming\chatmol-lab\runtime\mambaforge\Scripts`,
      String.raw`C:\Users\me\AppData\Roaming\chatmol-lab\runtime\mambaforge\Library\bin`,
    ].join(";");

    const status = getRuntimeStatus({ CHATMOL_CONDA_BIN: pathPrepend }, "win32");

    expect(status.pathDelimiter).toBe(";");
    expect(status.native.prefix).toBe(prefix);
    expect(status.native.conda.path).toBe(String.raw`${prefix}\Scripts\conda.exe`);
    expect(status.native.python.path).toBe(String.raw`${prefix}\python.exe`);
  });

  it("prefers the WSL runtime backend on Windows when it is ready", () => {
    const status = getRuntimeStatus({ CHATMOL_WSL_READY: "1" }, "win32");

    expect(status.activeBackend).toBe("wsl");
    expect(status.wsl.prefix).toBe("$HOME/.chatmol/miniforge");
    expect(status.wsl.pathPrepend).toBe(
      "$HOME/.chatmol/miniforge/bin:$HOME/.chatmol/miniforge/condabin",
    );
  });
});

describe("Windows/WSL path helpers", () => {
  it("converts Windows drive paths to WSL mount paths", () => {
    expect(windowsPathToWsl(String.raw`C:\Users\me\work file`)).toBe("/mnt/c/Users/me/work file");
    expect(windowsPathToWsl(String.raw`D:\data\run1`)).toBe("/mnt/d/data/run1");
  });

  it("builds a WSL shell prelude that activates the managed conda PATH", () => {
    const prelude = getWslRuntimePrelude({
      CHATMOL_WSL_READY: "1",
      CHATMOL_WSL_CONDA_PREFIX: "~/.chatmol/miniforge",
    });

    expect(prelude).toContain('export CHATMOL_CONDA_PREFIX="$HOME/.chatmol/miniforge"');
    expect(prelude).toContain(
      'export PATH="$HOME/.chatmol/miniforge/bin:$HOME/.chatmol/miniforge/condabin:$PATH"',
    );
  });
});
