#!/usr/bin/env node
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { chmod, copyFile, readdir, stat } from "node:fs/promises";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const RUNTIME_DIR = path.join(ROOT, "build", "runtime");
const DOWNLOAD_DIR = path.join(RUNTIME_DIR, "downloads");
const WEMOL_DIR = path.join(RUNTIME_DIR, "wemol-cli");

// Which platform's runtime to bundle. Defaults to the host so that a CI matrix
// builds the right assets per-runner (macOS runner -> mac, Windows runner -> win).
// Override with RUNTIME_TARGET=mac|win.
const TARGET =
  process.env.RUNTIME_TARGET ||
  (process.platform === "win32" ? "win" : process.platform === "darwin" ? "mac" : process.platform);

// Per-platform runtime assets. wemolMember is the file to locate inside the
// wemol-cli archive; wemolOut is the name it is stored as under build/runtime.
const TARGETS = {
  mac: {
    platform: "darwin-arm64",
    miniforge: {
      id: "miniforge",
      version: "26.3.2-3",
      fileName: "Miniforge3-26.3.2-3-MacOSX-arm64.sh",
      url: "https://github.com/conda-forge/miniforge/releases/download/26.3.2-3/Miniforge3-26.3.2-3-MacOSX-arm64.sh",
      sha256: "59168f1e24d0a4ad9932021170809fca836cd240e183eeeb331d5bcfc0098168",
    },
    wemol: {
      id: "wemol-cli",
      version: "v1.1.0",
      fileName: "wemol-cli-v1.1.0-macos-apple-silicon.zip",
      url: "https://github.com/wecomput/wemol-cli/releases/download/v1.1.0/wemol-cli-v1.1.0-macos-apple-silicon.zip",
      sha256: "96d61e943c5e562426c24024b09d79c209002ff345dba639ed697c33f37b19d8",
    },
    wemolMember: "wemol-cli",
    wemolOut: "wemol-cli",
  },
  win: {
    platform: "win32-x64",
    miniforge: {
      id: "miniforge",
      version: "26.3.2-3",
      fileName: "Miniforge3-26.3.2-3-Windows-x86_64.exe",
      url: "https://github.com/conda-forge/miniforge/releases/download/26.3.2-3/Miniforge3-26.3.2-3-Windows-x86_64.exe",
      sha256: "14a8635465b5190537ddad6286746ffebbc55a1ed2a7bb14a506595fe3191e1e",
    },
    wemol: {
      id: "wemol-cli",
      version: "v1.1.0",
      fileName: "wemol-cli-v1.1.0-windows-x86_64.zip",
      url: "https://github.com/wecomput/wemol-cli/releases/download/v1.1.0/wemol-cli-v1.1.0-windows-x86_64.zip",
      sha256: "2b533e530e789882743db719873bf4aac298ab4355f6c5b7706a6b9f240b494a",
    },
    wslMiniforge: {
      id: "miniforge-linux-x86_64",
      version: "26.3.2-3",
      fileName: "Miniforge3-26.3.2-3-Linux-x86_64.sh",
      url: "https://github.com/conda-forge/miniforge/releases/download/26.3.2-3/Miniforge3-26.3.2-3-Linux-x86_64.sh",
      sha256: "848194851a98903134187fbb4ab50efe87b003e0c0f808f97644b7524a62bf2c",
    },
    wemolMember: "wemol-cli.exe",
    wemolOut: "wemol-cli.exe",
  },
};

const cfg = TARGETS[TARGET];
if (!cfg) {
  throw new Error(`Unsupported RUNTIME_TARGET "${TARGET}" (expected mac or win).`);
}

function sha256(filePath) {
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
        response.resume();
        download(response.headers.location, dest).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`HTTP ${response.statusCode} for ${url}`));
        return;
      }
      const out = createWriteStream(dest, { mode: 0o644 });
      response.pipe(out);
      out.on("finish", () => out.close(resolve));
      out.on("error", reject);
    });
    request.on("error", reject);
  });
}

async function ensureAsset(asset) {
  const dest = path.join(DOWNLOAD_DIR, asset.fileName);
  if (existsSync(dest) && sha256(dest) === asset.sha256) {
    console.log(`runtime asset ok: ${asset.fileName}`);
    return dest;
  }
  if (existsSync(dest)) {
    console.warn(`runtime asset checksum changed, re-downloading: ${asset.fileName}`);
    rmSync(dest);
  }
  console.log(`downloading runtime asset: ${asset.fileName}`);
  await download(asset.url, dest);
  const actual = sha256(dest);
  if (actual !== asset.sha256) {
    rmSync(dest, { force: true });
    throw new Error(`${asset.fileName} sha256 mismatch: expected ${asset.sha256}, got ${actual}`);
  }
  return dest;
}

async function findFile(dir, name) {
  for (const entry of await readdir(dir)) {
    const full = path.join(dir, entry);
    const info = await stat(full);
    if (info.isDirectory()) {
      const found = await findFile(full, name);
      if (found) return found;
      continue;
    }
    if (entry === name) return full;
  }
  return null;
}

function extractZip(zipPath, destDir) {
  // Windows runners ship bsdtar (tar.exe) which reads zips; macOS uses unzip.
  if (process.platform === "win32") {
    execFileSync("tar", ["-xf", zipPath, "-C", destDir], { stdio: "inherit" });
  } else {
    execFileSync("/usr/bin/unzip", ["-q", zipPath, "-d", destDir], { stdio: "inherit" });
  }
}

async function extractWemolCli(zipPath) {
  const outPath = path.join(WEMOL_DIR, cfg.wemolOut);
  if (existsSync(outPath) && statSync(outPath).size > 0) {
    console.log("runtime wemol-cli ok");
    return outPath;
  }

  const tmpDir = path.join(WEMOL_DIR, ".extract");
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  extractZip(zipPath, tmpDir);

  const extracted = await findFile(tmpDir, cfg.wemolMember);
  if (!extracted) {
    throw new Error(`Could not find ${cfg.wemolMember} inside ${zipPath}`);
  }
  await copyFile(extracted, outPath);
  if (process.platform !== "win32") {
    await chmod(outPath, 0o755);
  }
  rmSync(tmpDir, { recursive: true, force: true });
  console.log(`runtime wemol-cli extracted: ${outPath}`);
  return outPath;
}

mkdirSync(DOWNLOAD_DIR, { recursive: true });
mkdirSync(WEMOL_DIR, { recursive: true });

console.log(`preparing desktop runtime for target: ${TARGET} (${cfg.platform})`);

// Only this target's installers may ship: build/runtime is copied verbatim
// into the app resources, so downloads for other targets (kept for
// cross-building) are parked next to it in build/runtime-downloads-parked.
const PARK_DIR = path.join(RUNTIME_DIR, "..", "runtime-downloads-parked");
const KEEP = new Set([cfg.miniforge.fileName, cfg.wemol.fileName, cfg.wslMiniforge?.fileName].filter(Boolean));
mkdirSync(PARK_DIR, { recursive: true });
mkdirSync(DOWNLOAD_DIR, { recursive: true });
for (const name of readdirSync(PARK_DIR)) {
  if (KEEP.has(name) && !existsSync(path.join(DOWNLOAD_DIR, name))) {
    renameSync(path.join(PARK_DIR, name), path.join(DOWNLOAD_DIR, name));
  }
}
for (const name of readdirSync(DOWNLOAD_DIR)) {
  if (!KEEP.has(name)) {
    renameSync(path.join(DOWNLOAD_DIR, name), path.join(PARK_DIR, name));
    console.log(`parked download for another target: ${name}`);
  }
}

// The same invariant applies to the extracted CLI, which was missed: the two
// platforms store it under different names (wemol-cli vs wemol-cli.exe), so
// building for one target and then the other left both in build/runtime and
// every installer shipped the other platform's binary — 6 MB of wemol-cli.exe
// rode inside the macOS dmg. Clean runners never saw it; a machine that has
// cross-built does.
for (const name of readdirSync(PARK_DIR)) {
  if (name === cfg.wemolOut && !existsSync(path.join(WEMOL_DIR, name))) {
    renameSync(path.join(PARK_DIR, name), path.join(WEMOL_DIR, name));
  }
}
for (const name of readdirSync(WEMOL_DIR)) {
  if (name === cfg.wemolOut || name === ".extract") continue;
  renameSync(path.join(WEMOL_DIR, name), path.join(PARK_DIR, name));
  console.log(`parked wemol-cli for another target: ${name}`);
}

await ensureAsset(cfg.miniforge);
if (cfg.wslMiniforge) {
  await ensureAsset(cfg.wslMiniforge);
}
const wemolZip = await ensureAsset(cfg.wemol);
await extractWemolCli(wemolZip);

const manifest = {
  schemaVersion: 1,
  platform: cfg.platform,
  generatedAt: new Date().toISOString(),
  conda: {
    distribution: "Miniforge3",
    note: "Mambaforge is deprecated upstream; this Miniforge release includes mamba.",
    envName: "chatmol",
    installer: cfg.miniforge,
  },
  wemolCli: {
    executable: `wemol-cli/${cfg.wemolOut}`,
    archive: cfg.wemol,
  },
  ...(cfg.wslMiniforge ? {
    wslConda: {
      distribution: "Miniforge3",
      installer: cfg.wslMiniforge,
      prefix: "~/.chatmol/miniforge",
    },
  } : {}),
};

writeFileSync(path.join(RUNTIME_DIR, "runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`runtime manifest written: ${path.join(RUNTIME_DIR, "runtime-manifest.json")}`);
