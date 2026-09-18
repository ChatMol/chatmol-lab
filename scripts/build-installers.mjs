/**
 * Build the release installers locally, in an order that is safe to repeat.
 *
 * `build/runtime` is copied verbatim into the app, and only one platform's
 * assets may be in it at a time, so the runtime has to be re-prepared between
 * targets. Doing that by hand is how a Windows binary ends up inside a macOS
 * dmg: nothing errors, the installer is just wrong. This encodes the order,
 * writes the checksums, and leaves the runtime on the host platform.
 *
 *   node scripts/build-installers.mjs            # every target this host can build
 *   node scripts/build-installers.mjs mac        # just one
 *
 * macOS can build both: electron-builder ships nsis and needs no Wine for it.
 * Windows and Linux hosts cannot produce the mac dmg.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const dist = path.join(repoRoot, "dist");

const TARGETS = {
  mac: { runtime: "mac", args: ["--mac", "dmg", "--arm64"], hosts: ["darwin"], ext: ".dmg" },
  win: { runtime: "win", args: ["--win", "nsis", "--x64"], hosts: ["darwin", "win32", "linux"], ext: ".exe" },
};

const requested = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
const names = requested.length > 0 ? requested : Object.keys(TARGETS);
for (const name of names) {
  if (!TARGETS[name]) {
    console.error(`Unknown target "${name}". Known: ${Object.keys(TARGETS).join(", ")}`);
    process.exit(1);
  }
  if (!TARGETS[name].hosts.includes(process.platform)) {
    console.error(`Cannot build ${name} on ${process.platform}.`);
    process.exit(1);
  }
}

const run = (command, args, env = {}) =>
  execFileSync(command, args, { cwd: repoRoot, stdio: "inherit", env: { ...process.env, ...env } });
const npm = (script, env) => run("npm", ["run", script], env);

// Shared across targets, so once.
npm("build");
npm("electron:compile");
npm("electron:template-db");

for (const name of names) {
  const target = TARGETS[name];
  console.log(`\n=== ${name} ===`);
  npm("electron:runtime", { RUNTIME_TARGET: target.runtime });
  run("npx", ["electron-builder", ...target.args, "--publish", "never"], {
    // No Developer ID: the afterPack hook signs ad-hoc so macOS sees a valid
    // signature instead of reporting the app as damaged.
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
  });
}

// Leave the runtime matching this machine, so `npm run electron:dev` works.
const hostTarget = process.platform === "darwin" ? "mac" : "win";
npm("electron:runtime", { RUNTIME_TARGET: hostTarget });

const version = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
const fileFor = (name) => `chatmol-lab-${version}-${name === "mac" ? "mac-arm64" : "win-x64"}${TARGETS[name].ext}`;

const missing = names.map(fileFor).filter((file) => !fs.existsSync(path.join(dist, file)));
if (missing.length > 0) {
  console.error(`\nelectron-builder produced no ${missing.join(", ")} in dist/`);
  process.exit(1);
}

// Sum every installer of this version present in dist/, not only the ones
// this run rebuilt: writing just those would drop the other platform's line
// from a file that is published as the checksums for the whole release.
const sums = Object.keys(TARGETS)
  .map(fileFor)
  .filter((file) => fs.existsSync(path.join(dist, file)))
  .map((file) => `${createHash("sha256").update(fs.readFileSync(path.join(dist, file))).digest("hex")}  ${file}`)
  .join("\n");
fs.writeFileSync(path.join(dist, "SHA256SUMS.txt"), `${sums}\n`);
console.log(`\n${sums}\n\nwrote dist/SHA256SUMS.txt`);
