/**
 * MCP (Model Context Protocol) client for stdio servers.
 *
 * Modeled on dsh-mcp-client: every enabled server's tools are exposed to the
 * model as native tools named `mcp__<server>__<tool>`, server processes stay
 * alive across calls (PyMOL / ChimeraX sessions are stateful), and results are
 * flattened to text with images written into the session workspace.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import * as fs from "fs";
import * as path from "path";

import { isMcpPresetId, resolvePresetLaunch } from "./mcp-presets";
import { pluginMcpServerConfigs } from "./plugins";
import { loadSettings, type McpServerConfig } from "./settings";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export interface McpRemoteTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Shape shared with tools.ts ToolDefinition (kept structural to avoid a cycle). */
export interface McpToolDefinition {
  name: string;
  description: string;
  input_schema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}

export interface McpCallOutput {
  output: string;
  success: boolean;
  /** Workspace-relative paths of images the server returned. */
  imagePaths: string[];
}

export const MCP_TOOL_PREFIX = "mcp__";
const REQUEST_TIMEOUT_MS = 20_000;
// Must stay below the agent-loop timeout for mcp__ tools (see TOOL_TIMEOUTS in
// tools.ts) so a slow MCP call surfaces this layer's error instead of being cut
// off by the outer race, and above what bundled servers wait internally (the
// PyMOL preset waits up to 120s for a ray-traced render).
const CALL_TIMEOUT_MS = 150_000;
const IDLE_TTL_MS = 10 * 60_000;
const TOOL_CACHE_TTL_MS = 60_000;

// ---------------------------------------------------------------------------
// Tool naming
// ---------------------------------------------------------------------------

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48);
}

export function buildMcpToolName(serverId: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${sanitizeSegment(serverId)}__${sanitizeSegment(toolName)}`;
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX) && name.indexOf("__", MCP_TOOL_PREFIX.length) > 0;
}

/** Split `mcp__server__tool` into its parts (null when not an MCP name). */
export function parseMcpToolName(name: string): { serverId: string; toolName: string } | null {
  if (!name.startsWith(MCP_TOOL_PREFIX)) return null;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const sep = rest.indexOf("__");
  if (sep <= 0) return null;
  return { serverId: rest.slice(0, sep), toolName: rest.slice(sep + 2) };
}

function normalizeInputSchema(schema: unknown): McpToolDefinition["input_schema"] {
  const record = schema && typeof schema === "object" && !Array.isArray(schema)
    ? schema as Record<string, unknown>
    : {};
  const properties = record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)
    ? record.properties as Record<string, unknown>
    : {};
  const required = Array.isArray(record.required)
    ? record.required.filter((item): item is string => typeof item === "string")
    : undefined;
  return {
    type: "object",
    properties,
    ...(required && required.length > 0 ? { required } : {}),
  };
}

/** Convert one server's `tools/list` result into namespaced tool definitions. */
export function toMcpToolDefinitions(serverId: string, serverLabel: string, tools: McpRemoteTool[]): McpToolDefinition[] {
  const seen = new Set<string>();
  const defs: McpToolDefinition[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool.name !== "string" || !tool.name) continue;
    const name = buildMcpToolName(serverId, tool.name);
    if (seen.has(name)) continue;
    seen.add(name);
    const description = (tool.description || "").trim();
    defs.push({
      name,
      description: `[${serverLabel}] ${description || tool.name}`.slice(0, 1024),
      input_schema: normalizeInputSchema(tool.inputSchema),
    });
  }
  return defs;
}

// ---------------------------------------------------------------------------
// Result flattening
// ---------------------------------------------------------------------------

interface McpContentItem {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
  resource?: { uri?: string; text?: string; mimeType?: string };
}

function extensionForMime(mime: string | undefined): string {
  if (!mime) return "png";
  if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
  if (mime.includes("gif")) return "gif";
  if (mime.includes("webp")) return "webp";
  if (mime.includes("svg")) return "svg";
  return "png";
}

/**
 * Flatten an MCP `tools/call` result into text for the model. Images are
 * written to `<workspace>/mcp-images/` so they can be saved as artifacts.
 */
export function flattenMcpCallResult(
  result: unknown,
  serverId: string,
  toolName: string,
  workspace: string,
  writeFile: (absPath: string, data: Buffer) => void = (p, d) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, d);
  },
): McpCallOutput {
  const record = result && typeof result === "object" ? result as { content?: unknown; isError?: unknown; structuredContent?: unknown } : {};
  const isError = record.isError === true;
  const parts: string[] = [];
  const imagePaths: string[] = [];
  const content = Array.isArray(record.content) ? record.content as McpContentItem[] : [];
  let imageIndex = 0;

  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    switch (item.type) {
      case "text":
        if (typeof item.text === "string") parts.push(item.text);
        break;
      case "image": {
        if (typeof item.data !== "string") break;
        imageIndex += 1;
        const ext = extensionForMime(item.mimeType);
        const rel = path.posix.join("mcp-images", `${sanitizeSegment(serverId)}-${sanitizeSegment(toolName)}-${Date.now()}-${imageIndex}.${ext}`);
        try {
          writeFile(path.join(workspace, rel), Buffer.from(item.data, "base64"));
          imagePaths.push(rel);
          parts.push(`[image saved to workspace: ${rel} — register it with save_artifact(type="image") to show it]`);
        } catch (err) {
          parts.push(`[image could not be saved: ${err instanceof Error ? err.message : String(err)}]`);
        }
        break;
      }
      case "resource_link":
        parts.push(`[resource ${item.name || ""} ${item.uri || ""}]`.trim());
        break;
      case "resource":
        if (item.resource?.text) parts.push(item.resource.text);
        else parts.push(`[resource ${item.resource?.uri || ""}]`);
        break;
      case "audio":
        parts.push("[audio content not supported]");
        break;
      default:
        parts.push(`[unsupported content type: ${String(item.type)}]`);
    }
  }

  if (parts.length === 0 && record.structuredContent !== undefined) {
    parts.push(JSON.stringify(record.structuredContent, null, 2));
  }
  if (parts.length === 0) {
    parts.push(isError ? "MCP tool reported an error without details." : "(no content)");
  }
  return { output: parts.join("\n"), success: !isError, imagePaths };
}

// ---------------------------------------------------------------------------
// Persistent client pool
// ---------------------------------------------------------------------------

interface McpClient {
  key: string;
  server: McpServerConfig;
  child: ChildProcessWithoutNullStreams;
  pending: Map<number, PendingRequest>;
  nextId: number;
  closed: boolean;
  stderr: string;
  lastUsed: number;
  ready: Promise<void>;
  tools?: { at: number; list: McpRemoteTool[] };
  idleTimer?: NodeJS.Timeout;
}

const clients = new Map<string, McpClient>();

function enabledServers(): McpServerConfig[] {
  const fromSettings = loadSettings().mcpServers.filter((server) => server.enabled !== false);
  const ids = new Set(fromSettings.map((server) => server.id));
  // Enabled plugins contribute servers from their .mcp.json (ids `<plugin>-<server>`).
  const fromPlugins: McpServerConfig[] = pluginMcpServerConfigs()
    .filter((server) => !ids.has(server.id))
    .map((server) => ({
      id: server.id,
      name: server.name,
      command: server.command,
      ...(server.args ? { args: server.args } : {}),
      ...(server.env ? { env: server.env } : {}),
      enabled: true,
    }));
  return [...fromSettings, ...fromPlugins];
}

function findServer(serverId: string): McpServerConfig | null {
  return enabledServers().find((server) => server.id === serverId) || null;
}

function serverLabel(server: McpServerConfig): string {
  return server.name || server.id;
}

function resolveLaunch(server: McpServerConfig, cwd: string): { command: string; args: string[]; env: Record<string, string> } {
  if (server.preset && isMcpPresetId(server.preset)) {
    const resolved = resolvePresetLaunch(server.preset, cwd);
    if ("error" in resolved) throw new Error(`${serverLabel(server)}: ${resolved.error}`);
    return { ...resolved.launch, env: { ...resolved.launch.env, ...(server.env || {}) } };
  }
  if (!server.command) throw new Error(`MCP server "${server.id}" has no command configured.`);
  return { command: server.command, args: server.args || [], env: server.env || {} };
}

function writeJson(child: ChildProcessWithoutNullStreams, message: unknown): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function closeClient(client: McpClient, reason: string): void {
  if (client.closed) return;
  client.closed = true;
  if (client.idleTimer) clearTimeout(client.idleTimer);
  for (const item of client.pending.values()) item.reject(new Error(reason));
  client.pending.clear();
  if (clients.get(client.key) === client) clients.delete(client.key);
  try {
    client.child.kill();
  } catch {
    // already gone
  }
}

function touch(client: McpClient): void {
  client.lastUsed = Date.now();
  if (client.idleTimer) clearTimeout(client.idleTimer);
  client.idleTimer = setTimeout(() => {
    if (Date.now() - client.lastUsed >= IDLE_TTL_MS) closeClient(client, "MCP server idle timeout");
  }, IDLE_TTL_MS);
  client.idleTimer.unref?.();
}

function request(client: McpClient, method: string, params: Record<string, unknown> = {}, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
  if (client.closed) return Promise.reject(new Error("MCP server is closed"));
  touch(client);
  const id = client.nextId++;
  const promise = new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      client.pending.delete(id);
      reject(new Error(`MCP request timed out: ${method}`));
    }, timeoutMs);
    client.pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
  });
  writeJson(client.child, { jsonrpc: "2.0", id, method, params });
  return promise;
}

function spawnClient(server: McpServerConfig, cwd: string, key: string): McpClient {
  const launch = resolveLaunch(server, cwd);
  const child = spawn(launch.command, launch.args, {
    cwd,
    env: { ...process.env, ...launch.env },
    stdio: "pipe",
  });

  const client: McpClient = {
    key,
    server,
    child,
    pending: new Map(),
    nextId: 1,
    closed: false,
    stderr: "",
    lastUsed: Date.now(),
    ready: Promise.resolve(),
  };

  let stdoutBuffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBuffer += chunk.toString("utf8");
    let newline = stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (line) {
        try {
          const message = JSON.parse(line) as JsonRpcResponse;
          if (typeof message.id === "number" && client.pending.has(message.id)) {
            const item = client.pending.get(message.id)!;
            client.pending.delete(message.id);
            if (message.error) {
              item.reject(new Error(message.error.message || `MCP error ${message.error.code ?? ""}`));
            } else {
              item.resolve(message.result);
            }
          }
        } catch {
          // Non-JSON log line from the server; ignore.
        }
      }
      newline = stdoutBuffer.indexOf("\n");
    }
  });
  child.stderr.on("data", (chunk: Buffer) => {
    client.stderr = (client.stderr + chunk.toString("utf8")).slice(-4000);
  });
  child.on("error", (error) => closeClient(client, `MCP server failed to start: ${error.message}`));
  child.on("close", (code) => {
    closeClient(client, `MCP server exited with code ${code ?? "unknown"}${client.stderr ? `: ${client.stderr.slice(-400)}` : ""}`);
  });

  client.ready = (async () => {
    await request(client, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "chatmol-lab", version: "1.0.0" },
    });
    writeJson(child, { jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  })().catch((err) => {
    const detail = client.stderr ? ` (${client.stderr.trim().split("\n").slice(-3).join(" | ")})` : "";
    closeClient(client, `MCP init failed: ${err instanceof Error ? err.message : String(err)}`);
    throw new Error(`${serverLabel(server)} failed to start: ${err instanceof Error ? err.message : String(err)}${detail}`);
  });
  return client;
}

async function getClient(server: McpServerConfig, cwd: string): Promise<McpClient> {
  const key = `${server.id}::${cwd}`;
  let client = clients.get(key);
  if (!client || client.closed) {
    client = spawnClient(server, cwd, key);
    clients.set(key, client);
  }
  await client.ready;
  return client;
}

async function listServerTools(client: McpClient): Promise<McpRemoteTool[]> {
  if (client.tools && Date.now() - client.tools.at < TOOL_CACHE_TTL_MS) return client.tools.list;
  const tools: McpRemoteTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await request(client, "tools/list", cursor ? { cursor } : {}) as { tools?: McpRemoteTool[]; nextCursor?: string } | null;
    if (Array.isArray(result?.tools)) tools.push(...result!.tools);
    const next = typeof result?.nextCursor === "string" && result.nextCursor ? result.nextCursor : undefined;
    if (!next || next === cursor) break;
    cursor = next;
  }
  client.tools = { at: Date.now(), list: tools };
  return tools;
}

/** Stop every pooled server process (used by tests and shutdown hooks). */
export function shutdownMcpClients(): void {
  for (const client of Array.from(clients.values())) closeClient(client, "shutdown");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface McpToolCatalog {
  definitions: McpToolDefinition[];
  servers: Array<{ id: string; label: string; preset?: string; toolCount: number; error?: string }>;
}

/**
 * Namespaced tool definitions for every enabled server. Servers that fail to
 * start are reported (not thrown) so one broken server never blocks a chat.
 */
export async function getMcpToolCatalog(cwd: string, opts: { timeoutMs?: number } = {}): Promise<McpToolCatalog> {
  const servers = enabledServers();
  const catalog: McpToolCatalog = { definitions: [], servers: [] };
  if (servers.length === 0) return catalog;
  const timeoutMs = opts.timeoutMs ?? 8_000;

  await Promise.all(servers.map(async (server) => {
    const label = serverLabel(server);
    try {
      const tools = await Promise.race([
        getClient(server, cwd).then(listServerTools),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out while listing tools")), timeoutMs)),
      ]);
      const defs = toMcpToolDefinitions(server.id, label, tools);
      catalog.definitions.push(...defs);
      catalog.servers.push({ id: server.id, label, preset: server.preset, toolCount: defs.length });
    } catch (err) {
      catalog.servers.push({
        id: server.id,
        label,
        preset: server.preset,
        toolCount: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }));
  catalog.definitions.sort((a, b) => a.name.localeCompare(b.name));
  return catalog;
}

/** Call `mcp__server__tool` with the given arguments. */
export async function callNamespacedMcpTool(
  name: string,
  args: Record<string, unknown>,
  cwd: string,
): Promise<McpCallOutput> {
  const parsed = parseMcpToolName(name);
  if (!parsed) throw new Error(`Not an MCP tool name: ${name}`);
  const server = enabledServers().find((s) => sanitizeSegment(s.id) === parsed.serverId);
  if (!server) throw new Error(`MCP server "${parsed.serverId}" is not configured or disabled.`);
  const client = await getClient(server, cwd);
  const tools = await listServerTools(client);
  const remote = tools.find((t) => sanitizeSegment(t.name) === parsed.toolName);
  const toolName = remote?.name || parsed.toolName;
  const result = await request(client, "tools/call", { name: toolName, arguments: args }, CALL_TIMEOUT_MS);
  return flattenMcpCallResult(result, server.id, toolName, cwd);
}

/** System-prompt section describing the enabled MCP servers. */
export function buildMcpPromptSection(catalog: McpToolCatalog, presetHints: Record<string, string>): string {
  if (catalog.servers.length === 0) return "";
  const lines: string[] = ["\n\n## MCP Servers (external tools)"];
  lines.push("Tools named `mcp__<server>__<tool>` come from user-enabled MCP servers and run on the user's machine. Use them like any other tool.");
  for (const server of catalog.servers) {
    if (server.error) {
      lines.push(`- ${server.label} (${server.id}): unavailable — ${server.error.slice(0, 200)}. Tell the user if they ask for it.`);
      continue;
    }
    const hint = server.preset ? presetHints[server.preset] : undefined;
    lines.push(`- ${server.label} (${server.id}): ${server.toolCount} tools.${hint ? ` ${hint}` : ""}`);
  }
  return lines.join("\n");
}

// --- Legacy generic tools (kept for ad-hoc use) ---

export async function listMcpTools(serverId: string | undefined, cwd: string): Promise<unknown> {
  const servers = serverId ? [findServer(serverId)].filter(Boolean) as McpServerConfig[] : enabledServers();
  if (servers.length === 0) {
    return { servers: [], message: serverId ? `MCP server "${serverId}" is not configured or disabled.` : "No MCP servers configured." };
  }
  const results = [];
  for (const server of servers) {
    try {
      const client = await getClient(server, cwd);
      const tools = await listServerTools(client);
      results.push({ serverId: server.id, name: serverLabel(server), tools });
    } catch (error) {
      results.push({ serverId: server.id, name: serverLabel(server), error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { servers: results };
}

export async function callMcpTool(
  serverId: string,
  toolName: string,
  args: Record<string, unknown>,
  cwd: string,
): Promise<unknown> {
  const server = findServer(serverId);
  if (!server) throw new Error(`MCP server "${serverId}" is not configured or disabled.`);
  const client = await getClient(server, cwd);
  const result = await request(client, "tools/call", { name: toolName, arguments: args }, CALL_TIMEOUT_MS);
  return flattenMcpCallResult(result, server.id, toolName, cwd);
}
