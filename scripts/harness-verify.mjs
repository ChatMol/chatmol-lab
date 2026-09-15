#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

function read(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), "utf8");
}

function exists(relPath) {
  return fs.existsSync(path.join(repoRoot, relPath));
}

const checks = [];

function check(name, fn) {
  checks.push({ name, fn });
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

check("no hardcoded service secrets in agent tools", () => {
  const tools = read("web/src/lib/tools.ts");
  assert(
    !/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/.test(tools),
    "found hardcoded JWT-like bearer token",
  );
});

check("file APIs do not authorize by workspace root", () => {
  const workspace = read("web/src/lib/workspace.ts");
  assert(workspace.includes("segment.startsWith(\".\")"), "safeResolvePath does not reject hidden runtime paths");
  const fileRoutes = [
    "web/src/app/api/files/route.ts",
    "web/src/app/api/files/serve/route.ts",
    "web/src/app/api/files/download/route.ts",
  ];
  for (const relPath of fileRoutes) {
    const source = read(relPath);
    assert(!source.includes("getWorkspaceRoot"), `${relPath} still imports or uses getWorkspaceRoot`);
    assert(
      source.includes("safeResolvePath") || source.includes("normalizedWorkspace"),
      `${relPath} does not visibly validate against the session workspace`,
    );
  }
});

check("guest chat sessions are not globally readable", () => {
  const sessionDb = read("web/src/lib/session-db.ts");
  assert(
    !sessionDb.includes("if (session.userId === null) return true"),
    "verifySessionOwnership still grants public access to guest sessions",
  );
});

check("session upsert preserves ownership", () => {
  const sessionDb = read("web/src/lib/session-db.ts");
  assert(
    /updateChatSession\(\s*[\s\S]{0,400}(userId:\s*string\s*\|\s*null|userId\?:)/.test(sessionDb),
    "updateChatSession cannot receive owner userId",
  );
  assert(/create:\s*{[\s\S]*userId/.test(sessionDb), "ChatSession upsert create path does not set userId");
});

check("append-only agent event log is wired", () => {
  assert(exists("web/src/lib/agent-events.ts"), "web/src/lib/agent-events.ts is missing");
  const chatRoute = read("web/src/app/api/chat/route.ts");
  assert(chatRoute.includes("appendAgentEvent"), "chat route does not append runtime events");
  assert(chatRoute.includes("user_message"), "chat route does not log user_message events");
  assert(chatRoute.includes("done"), "chat route does not log done events");
});

check("sandbox approval can pause before command execution", () => {
  const tools = read("web/src/lib/tools.ts");
  const chatRoute = read("web/src/app/api/chat/route.ts");
  assert(
    tools.includes("sandbox_confirm") || tools.includes("approval_required"),
    "tools runtime does not emit an approval event for blocked commands",
  );
  assert(
    chatRoute.includes("approval_required") || chatRoute.includes("sandbox_confirm"),
    "chat route does not forward sandbox approval events",
  );
  assert(chatRoute.includes("loopResult.approvalRequired"), "chat route does not stop on approvalRequired");
});

/**
 * Follows what a binding is built from, one `const`/`let` at a time, so the
 * check is about where a value comes from rather than about the names a
 * future implementation might use.
 */
function declarationOf(source, name) {
  const pattern = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*(?::[^=;]+)?=`, "g");
  const match = pattern.exec(source);
  if (!match) return null;
  let index = match.index + match[0].length;
  let depth = 0;
  let quote = null;
  for (; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if ("([{".includes(char)) depth += 1;
    else if (")]}".includes(char)) depth -= 1;
    else if (char === ";" && depth <= 0) break;
  }
  return source.slice(match.index, index);
}

/**
 * The one binding allowed to read the request text.
 *
 * Naming the user's language in the prompt ("The user's latest message is
 * written in English") is the only thing that reliably keeps the answer in
 * that language; a general same-language rule does not hold. That reads the
 * message, so the check below would refuse it. The exemption is narrow: the
 * initializer must be exactly the reply-language helpers and nothing else,
 * and those helpers look at the script of the text, never at what it asks for
 * (web/src/lib/reply-language.test.ts).
 */
function readsOnlyTheLanguage(initializer) {
  if (!/\bbuildReplyLanguageSection\s*\(/.test(initializer)) return false;
  if (!/\bdetectReplyLanguage\s*\(/.test(initializer)) return false;
  const withoutCalls = initializer
    .replace(/\bbuildReplyLanguageSection\s*\(/g, "(")
    .replace(/\bdetectReplyLanguage\s*\(/g, "(")
    .replace(/\blanguageSample\s*\([^)]*\)/g, "()");
  return !/\bmessage\b/.test(withoutCalls);
}

/** The binding in `roots` that reads `forbidden`, directly or through another binding. */
function tracesBackTo(source, roots, forbidden) {
  const forbiddenRe = new RegExp(`\\b${forbidden}\\b`);
  const seen = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const declaration = declarationOf(source, name);
    if (!declaration) continue;
    const initializer = declaration.slice(declaration.indexOf("=") + 1);
    if (forbiddenRe.test(initializer) && !readsOnlyTheLanguage(initializer)) return name;
    for (const identifier of initializer.match(/\b[A-Za-z_$][\w$]*\b/g) || []) {
      if (!seen.has(identifier)) queue.push(identifier);
    }
  }
  return null;
}

check("tool exposure and the system prompt are not derived from the request text", () => {
  // A request must not take a different path, or see a different tool set,
  // because of the words or the language it was written in. The orchestrator
  // classified messages by English substrings; WeMol routing hid nvidia_*
  // tools on keyword matches. Both are gone: this follows the data instead of
  // grepping for the names they used.
  const route = read("web/src/app/api/chat/route.ts");
  for (const root of ["activeTools", "systemPrompt"]) {
    assert(declarationOf(route, root), `chat route no longer declares ${root}; update this check`);
    const via = tracesBackTo(route, [root], "message");
    assert(!via, `${root} is built from the request text (via ${via}) — tool exposure must not depend on wording`);
  }
  assert(!exists("web/src/lib/orchestrator.ts"), "web/src/lib/orchestrator.ts is back");
  // The language exemption is only sound while its helper stays tested.
  assert(exists("web/src/lib/reply-language.test.ts"), "reply-language.ts has no test; the language exemption above rests on it");

  // No shared module may turn a message into a tool list either.
  const libDir = path.join(repoRoot, "web/src/lib");
  for (const file of fs.readdirSync(libDir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))) {
    const source = read(`web/src/lib/${file}`);
    const suspicious = /export\s+(?:async\s+)?function\s+\w+\s*\([^)]*\b(?:message|request|prompt|text|query)\b[^)]*\)\s*:\s*[^{]*\b(?:ToolDefinition\[\]|NamedTool\[\]|T\[\])/.test(source);
    assert(!suspicious, `web/src/lib/${file} exports a function that turns request text into a tool list`);
  }
});

check("root package exposes harness verifier", () => {
  const pkg = JSON.parse(read("package.json"));
  assert(pkg.scripts?.["harness:verify"] === "node scripts/harness-verify.mjs", "missing harness:verify script");
});

check("cloud/local chat sync route is wired", () => {
  if (!exists("web/src/app/api/auth/desktop-token/route.ts")) {
    return "hosted-only routes are not part of this tree";
  }
  assert(exists("web/src/app/api/sync/sessions/route.ts"), "sync sessions API route is missing");
  const desktopToken = read("web/src/app/api/auth/desktop-token/route.ts");
  const desktopSession = read("web/src/app/api/auth/desktop-session/route.ts");
  const cloudSync = read("web/src/lib/cloud-sync.ts");
  const middleware = read("web/src/middleware.ts");
  assert(desktopToken.includes("desktop-sync"), "desktop-token does not mint desktop sync token");
  assert(desktopSession.includes("saveDesktopSyncToken"), "desktop-session does not persist sync token locally");
  assert(cloudSync.includes("pullCloudSessions"), "cloud sync pull helper is missing");
  assert(cloudSync.includes("pushSessionToCloud"), "cloud sync push helper is missing");
  assert(middleware.includes("SELF_AUTHENTICATED_API_PREFIXES"), "middleware no longer consults the self-authenticating prefix list");
  assert(read("web/src/lib/route-auth.ts").includes("\"/api/sync\""), "sync API is not exempt from the middleware session check, so its bearer token cannot reach it");
});

let failed = 0;
for (const { name, fn } of checks) {
  try {
    const skipped = fn();
    console.log(skipped ? `SKIP ${name} (${skipped})` : `PASS ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(`  ${err.message}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed}/${checks.length} harness checks failed.`);
  process.exit(1);
}

console.log(`\n${checks.length}/${checks.length} harness checks passed.`);
