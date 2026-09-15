import { NextRequest, NextResponse } from "next/server";
import {
  loadSettings,
  saveSettings,
  maskApiKey,
  isMaskedKey,
  getUserNvidiaApiKey,
  saveUserNvidiaApiKey,
  getUserSystemPrompt,
  saveUserSystemPrompt,
  getUserWemolCredentials,
  saveUserWemolCredentials,
  getUserWemolStatus,
  saveUserWemolStatus,
  normalizeComputeBackend,
} from "@/lib/settings";
import { loginAndVerifyWemolAccount } from "@/lib/wemol-cli";
import { auth } from "@/lib/auth";
import { getRuntimeStatus } from "@/lib/runtime";
import { LLM_PROVIDERS, LLM_PROVIDER_IDS, normalizeLlmProvider } from "@/lib/llm-providers";
import { normalizeToolReviewMode } from "@/lib/tool-review";
import { normalizeWemolComputeProfile } from "@/lib/wemol-policy";

export async function GET() {
  const settings = loadSettings();
  const authSession = await auth();
  const userId = authSession?.user?.id || null;

  const nvidiaKey = await getUserNvidiaApiKey(userId);
  const userPrompt = await getUserSystemPrompt(userId);
  const wemolCreds = await getUserWemolCredentials(userId);
  const wemolStatus = await getUserWemolStatus(userId);

  return NextResponse.json({
    provider: settings.provider,
    providers: LLM_PROVIDER_IDS.map((id) => {
      const spec = LLM_PROVIDERS[id];
      return {
        id,
        label: spec.label,
        note: spec.note,
        keyUrl: spec.keyUrl,
        envKey: spec.envKey,
        defaultModel: spec.defaultModel,
        defaultFastModel: spec.defaultFastModel,
        models: spec.models,
        hasKey: Boolean(settings.apiKeys[id] || process.env[spec.envKey]),
        maskedKey: maskApiKey(settings.apiKeys[id] || process.env[spec.envKey] || ""),
      };
    }),
    apiKey: maskApiKey(settings.apiKey),
    llmBaseUrl: settings.llmBaseUrl,
    chatmolBioApiKey: maskApiKey(settings.chatmolBioApiKey),
    chatmolBioBaseUrl: settings.chatmolBioBaseUrl,
    model: settings.model,
    fastModel: settings.fastModel,
    maxOutputTokens: settings.maxOutputTokens,
    shellPath: settings.shellPath,
    workspaceDir: settings.workspaceDir,
    mpnnPython: settings.mpnnPython,
    mpnnScript: settings.mpnnScript,
    mcpServers: settings.mcpServers.map((server) => ({
      ...server,
      env: server.env ? Object.fromEntries(Object.keys(server.env).map((key) => [key, "********"])) : undefined,
    })),
    systemPrompt: userPrompt,
    nvidiaApiKey: maskApiKey(nvidiaKey),
    wemolUsername: wemolCreds?.username || "",
    wemolPassword: wemolCreds ? "********" : "",
    wemolStatus,
    runtime: getRuntimeStatus(),
    toolReviewMode: settings.toolReviewMode,
    computeBackend: settings.computeBackend,
    wemolComputeProfile: settings.wemolComputeProfile,
    memoryEnabled: settings.memoryEnabled,
  });
}

export async function PUT(request: NextRequest) {
  try {
    const body = await request.json();
    const updates: Record<string, unknown> = {};

    // Provider first: the API key below is stored under this provider.
    if (body.provider !== undefined) {
      updates.provider = normalizeLlmProvider(body.provider);
    }
    if (body.chatmolBioApiKey !== undefined && typeof body.chatmolBioApiKey === "string" && !isMaskedKey(body.chatmolBioApiKey)) {
      updates.chatmolBioApiKey = body.chatmolBioApiKey.trim();
    }
    if (body.chatmolBioBaseUrl !== undefined && typeof body.chatmolBioBaseUrl === "string") {
      updates.chatmolBioBaseUrl = body.chatmolBioBaseUrl.trim();
    }
    if (body.llmBaseUrl !== undefined && typeof body.llmBaseUrl === "string") {
      updates.llmBaseUrl = body.llmBaseUrl.trim();
    }
    if (body.fastModel !== undefined && typeof body.fastModel === "string") {
      updates.fastModel = body.fastModel.trim();
    }

    // Handle API key: if masked value is sent back, preserve existing key
    if (body.apiKey !== undefined) {
      if (isMaskedKey(body.apiKey) || body.apiKey === "") {
        // Don't update — keep existing key
      } else {
        updates.apiKey = body.apiKey;
      }
    }

    // Model
    if (body.model !== undefined && typeof body.model === "string") {
      updates.model = body.model.trim();
    }

    // Shell PATH
    if (body.shellPath !== undefined && typeof body.shellPath === "string") {
      updates.shellPath = body.shellPath.trim();
    }

    // Max output tokens
    if (body.maxOutputTokens !== undefined) {
      const val = Number(body.maxOutputTokens);
      if (val > 0) updates.maxOutputTokens = val;
    }

    if (body.mcpServers !== undefined && Array.isArray(body.mcpServers)) {
      updates.mcpServers = body.mcpServers;
    }
    if (body.computeBackend !== undefined) {
      updates.computeBackend = normalizeComputeBackend(body.computeBackend);
    }
    if (body.toolReviewMode !== undefined) {
      updates.toolReviewMode = normalizeToolReviewMode(body.toolReviewMode);
    }
    if (body.wemolComputeProfile !== undefined) {
      updates.wemolComputeProfile = normalizeWemolComputeProfile(body.wemolComputeProfile);
    }
    if (body.memoryEnabled !== undefined) {
      updates.memoryEnabled = body.memoryEnabled !== false;
    }

    saveSettings(updates as any);

    // Per-user storage in database (requires auth)
    const authSession = await auth();
    const userId = authSession?.user?.id || null;

    if (body.nvidiaApiKey !== undefined) {
      if (!(isMaskedKey(body.nvidiaApiKey) || body.nvidiaApiKey === "")) {
        if (userId) {
          await saveUserNvidiaApiKey(userId, body.nvidiaApiKey);
        }
      }
    }

    // System prompt: per-user storage
    if (body.systemPrompt !== undefined && typeof body.systemPrompt === "string") {
      await saveUserSystemPrompt(userId, body.systemPrompt);
    }

    let wemolStatus = await getUserWemolStatus(userId);

    // WeMol credentials: per-user storage plus immediate CLI verification
    if (body.wemolUsername !== undefined && body.wemolPassword !== undefined) {
      const user = body.wemolUsername?.trim();
      const pass = body.wemolPassword;
      if (user && pass && pass !== "********") {
        await saveUserWemolCredentials(userId, user, pass);
        wemolStatus = await loginAndVerifyWemolAccount(user, pass);
        await saveUserWemolStatus(userId, wemolStatus);
      }
    }

    const nvidiaKey = await getUserNvidiaApiKey(userId);
    const userPrompt = await getUserSystemPrompt(userId);
    const wemolCreds = await getUserWemolCredentials(userId);
    wemolStatus = await getUserWemolStatus(userId);

    // Return the new effective settings (masked)
    const settings = loadSettings();
    return NextResponse.json({
      apiKey: maskApiKey(settings.apiKey),
      model: settings.model,
      maxOutputTokens: settings.maxOutputTokens,
      shellPath: settings.shellPath,
      workspaceDir: settings.workspaceDir,
      mpnnPython: settings.mpnnPython,
      mpnnScript: settings.mpnnScript,
      mcpServers: settings.mcpServers.map((server) => ({
        ...server,
        env: server.env ? Object.fromEntries(Object.keys(server.env).map((key) => [key, "********"])) : undefined,
      })),
      systemPrompt: userPrompt,
      nvidiaApiKey: maskApiKey(nvidiaKey),
      wemolUsername: wemolCreds?.username || "",
      wemolPassword: wemolCreds ? "********" : "",
      wemolStatus,
      runtime: getRuntimeStatus(),
      toolReviewMode: settings.toolReviewMode,
      computeBackend: settings.computeBackend,
      chatmolBioApiKey: maskApiKey(settings.chatmolBioApiKey),
      chatmolBioBaseUrl: settings.chatmolBioBaseUrl,
      wemolComputeProfile: settings.wemolComputeProfile,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "Failed to save settings" },
      { status: 500 }
    );
  }
}
