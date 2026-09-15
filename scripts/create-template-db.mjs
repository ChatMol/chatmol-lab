#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const webDir = path.join(root, "web");
const schemaPath = path.join(webDir, "prisma", "schema.prisma");
const templatePath = path.join(webDir, "prisma", "template.db");

if (existsSync(templatePath)) {
  rmSync(templatePath);
}

// prisma is a devDependency of the web workspace; call its bin directly so
// this works on Windows (no `npx` on PATH inside execFile) and without hoisting.
const prismaBin = path.join(
  webDir, "node_modules", ".bin", process.platform === "win32" ? "prisma.cmd" : "prisma",
);
const sql = execFileSync(
  prismaBin,
  ["migrate", "diff", "--from-empty", "--to-schema-datamodel", schemaPath, "--script"],
  {
    cwd: webDir,
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
    shell: process.platform === "win32",
  }
);

// Apply the schema. Prefer better-sqlite3 (a root dependency with prebuilds,
// so it works on Windows runners where the sqlite3 CLI is absent); fall back
// to the sqlite3 CLI on PATH when the native module was rebuilt for Electron
// and cannot load under the system Node (typical on a dev Mac).
function applyWithBetterSqlite() {
  const require = createRequire(import.meta.url);
  const Database = require("better-sqlite3");
  const db = new Database(templatePath);
  db.pragma("foreign_keys = OFF");
  db.exec(sql);
  db.pragma("foreign_keys = ON");
  db.close();
}

function applyWithSqliteCli() {
  const sqlite = spawnSync("sqlite3", [templatePath], {
    input: `PRAGMA foreign_keys = OFF;\n${sql}\nPRAGMA foreign_keys = ON;\n`,
    encoding: "utf-8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (sqlite.status !== 0) {
    throw new Error(sqlite.stderr || sqlite.stdout || sqlite.error?.message || "sqlite3 failed creating template database");
  }
}

try {
  applyWithBetterSqlite();
} catch (err) {
  console.warn(`better-sqlite3 unavailable (${err?.message?.split("\n")[0]}); using sqlite3 CLI`);
  if (existsSync(templatePath)) rmSync(templatePath);
  applyWithSqliteCli();
}

console.log(`Template database created at ${templatePath}`);
