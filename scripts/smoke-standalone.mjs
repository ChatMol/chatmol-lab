/**
 * Start the built standalone server and require it to answer.
 *
 * `next build` succeeding says nothing about whether the server it produced
 * can boot. Two releases shipped an installer whose server threw on startup
 * and answered every request with 500, because a dependency loaded through
 * eval('require') never made it into the standalone output. CI was green both
 * times: it built the app and never ran it.
 *
 * A proxy variable is set on purpose — that is the branch that was broken, and
 * it only runs when one is present. The address is a dead port: the proxy is
 * never used, it only has to be configured for the code path to execute.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const built = path.join(repoRoot, "web", ".next", "standalone");
const port = Number(process.env.SMOKE_PORT || 3999);
const url = `http://127.0.0.1:${port}/api/deployment`;

if (!fs.existsSync(path.join(built, "web", "server.js"))) {
  console.error(`No standalone server at ${built} — run \`npm run build\` first.`);
  process.exit(1);
}

// Run from a copy outside the repository. In place, `require` walks up to the
// repo's own node_modules and finds packages the installer does not ship — the
// missing-undici bug passes this test in place and fails once copied, which is
// exactly what the installer does when it puts standalone under Resources/.
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "chatmol-smoke-"));
const standalone = path.join(workspace, "standalone");
fs.cpSync(built, standalone, { recursive: true });
const server = path.join(standalone, "web", "server.js");

const child = spawn(process.execPath, [server], {
  cwd: standalone,
  env: {
    ...process.env,
    HTTPS_PROXY: "http://127.0.0.1:9",
    WORKSPACE_DIR: workspace,
    DATABASE_URL: `file:${path.join(workspace, "smoke.db")}`,
    NEXTAUTH_SECRET: "smoke-test-secret",
    HOSTNAME: "127.0.0.1",
    PORT: String(port),
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let output = "";
child.stdout.on("data", (chunk) => (output += chunk));
child.stderr.on("data", (chunk) => (output += chunk));

const stop = () => {
  child.kill("SIGTERM");
  fs.rmSync(workspace, { recursive: true, force: true });
};

const deadline = Date.now() + 90_000;
let status = 0;
while (Date.now() < deadline) {
  if (child.exitCode !== null) break;
  try {
    status = (await fetch(url)).status;
    if (status === 200) break;
  } catch {
    // not listening yet
  }
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

stop();

if (status !== 200) {
  console.error(`Standalone server never answered 200 at ${url} (last status: ${status || "no response"}).`);
  console.error(output.trimEnd() || "(no server output)");
  process.exit(1);
}

if (!/Setting global proxy dispatcher/.test(output)) {
  console.error("Server answered, but the proxy dispatcher never loaded — the branch this test exists for did not run.");
  console.error(output.trimEnd());
  process.exit(1);
}

console.log(`Standalone server answered 200 at ${url}, proxy dispatcher loaded.`);
