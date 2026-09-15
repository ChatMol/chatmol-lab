import { NextRequest, NextResponse } from "next/server";
import * as fs from "fs";
import * as path from "path";

import { auth } from "@/lib/auth";
import { getChatSession, updateChatSession, verifySessionOwnership } from "@/lib/session-db";
import {
  buildInvokedSkillsSection,
  buildSkillCatalogSection,
  getSkill,
  listSkills,
  parseInvokedSkillNames,
  type SkillDefinition,
} from "@/lib/skill-registry";
import { buildMemorySection, listMemories } from "@/lib/memory";
import { distillMemories } from "@/lib/memory-distill";
import { getSessionWorkspace } from "@/lib/workspace";
import { appendAgentEvent, type AgentEventType } from "@/lib/agent-events";
import { pushSessionToCloud } from "@/lib/cloud-sync";
import { loadSettings, getEffectiveApiConfig, getFastApiConfig, getUserSystemPrompt } from "@/lib/settings";
import { getModelContextWindow, missingKeyMessage } from "@/lib/llm-providers";
import { buildMcpPromptSection, getMcpToolCatalog } from "@/lib/mcp";
import { availableCatalogProviders } from "@/lib/compute/registry";
import { buildComputePromptSection, COMPUTE_TOOL_DEFINITIONS } from "@/lib/compute/tools";
import { formatSelectionForModel, parseSelectionContext } from "@/lib/structure-selection";
import { MCP_PRESETS } from "@/lib/mcp-presets";
import { getComputeGate } from "@/lib/compute/gate";
import {
  consumeApprovedCommands,
  createPendingApproval,
  filterCommandsByPendingHashes,
  getApprovalExpiresAt,
  hashApprovalCommand,
} from "@/lib/approvals";
import {
  buildContextProjection,
  getContextCompactionConfig,
  createModelSummarizer,
  type ContextProjection,
  mergeProjectedTurnMessages,
  type ContextCompactionRecord,
} from "@/lib/context-compaction";
import {
  type TurnMessage,
  type ToolResult,
  type SSESender,
  buildSystemPrompt,
  ALL_TOOLS,
  getWorkspaceFiles,
  runAgentLoop,
  processToolOutput,
} from "@/lib/tools";
import { getRuntimeManifestSection } from "@/lib/runtime-manifest";
import {
  buildRunSubagentToolDefinition,
  buildFixedSubagentPrompt,
  listFixedSubagents,
  normalizeFixedSubagentIds,
} from "@/lib/subagents";
import { buildReplyLanguageSection, detectReplyLanguage, languageSample } from "@/lib/reply-language";
import { buildComputeCostPolicySection } from "@/lib/wemol-policy";

const WORKSPACE_DIR = process.env.WORKSPACE_DIR || "/tmp/chatmol-workspace";
const SESSIONS_DIR = path.join(WORKSPACE_DIR, ".sessions");

// Ensure directories exist
try { fs.mkdirSync(WORKSPACE_DIR, { recursive: true }); } catch {}
try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch {}

// --- Session persistence ---
interface PersistedSession {
  id: string;
  messages: TurnMessage[];
  createdAt: number;
  updatedAt: number;
}

const sessions: Map<string, { messages: TurnMessage[] }> = new Map();

/**
 * Repair message alternation: ensure no consecutive user messages exist.
 * Anthropic's API requires strict user/assistant alternation. Consecutive
 * user messages can accumulate when the agent loop fails mid-conversation.
 * This inserts a minimal assistant placeholder between consecutive user messages.
 */
function repairMessageAlternation(messages: TurnMessage[]): TurnMessage[] {
  if (messages.length <= 1) return messages;
  const repaired: TurnMessage[] = [messages[0]];
  for (let i = 1; i < messages.length; i++) {
    const prev = repaired[repaired.length - 1];
    const curr = messages[i];
    // tool messages following assistant are fine (OpenAI format)
    if (curr.role === "user" && prev.role === "user") {
      repaired.push({ role: "assistant", content: "[continued]" });
    }
    repaired.push(curr);
  }
  return repaired;
}

// Same-process fast path for approvals. The database is the durable source,
// but this avoids a race if a user approves immediately after the SSE event.
const pendingApprovalHashes: Map<string, Set<string>> = new Map();

async function loadSession(sessionId: string): Promise<{ messages: TurnMessage[] }> {
  if (sessions.has(sessionId)) {
    return sessions.get(sessionId)!;
  }

  try {
    const dbSession = await getChatSession(sessionId);
    if (dbSession && Array.isArray(dbSession.messages) && dbSession.messages.length > 0) {
      const session = { messages: dbSession.messages as TurnMessage[] };
      sessions.set(sessionId, session);
      return session;
    }
  } catch {}

  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const filePath = path.join(SESSIONS_DIR, `${safe}.json`);
  if (fs.existsSync(filePath)) {
    try {
      const data: PersistedSession = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      const session = { messages: data.messages || [] };
      sessions.set(sessionId, session);
      return session;
    } catch {}
  }

  const session = { messages: [] as TurnMessage[] };
  sessions.set(sessionId, session);
  return session;
}

async function saveSession(
  sessionId: string,
  userId: string | null,
  options: { pushCloud?: boolean } = {},
): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) return;

  const { pushCloud = true } = options;

  try {
    await updateChatSession(sessionId, { messages: session.messages }, { userId });
    if (pushCloud) {
      await pushSessionToCloud(sessionId);
    }
  } catch (err) {
    console.error("Failed to save session to DB:", err);
  }

  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    const data: PersistedSession = {
      id: sessionId,
      messages: session.messages,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    fs.writeFileSync(path.join(SESSIONS_DIR, `${sessionId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`), JSON.stringify(data));
  } catch {}
}

export async function POST(request: NextRequest) {
  const { sessionId, message: rawMessage, skills, subagents, approvedCommands, metadata } = await request.json();
  const clientApproved: string[] = Array.isArray(approvedCommands) ? approvedCommands : [];
  // Every discovered subagent is available unless the request narrows the list.
  const requestedSubagentIds: unknown = subagents;
  const requestMetadata = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : {};
  const hiddenUserMessage = requestMetadata.hiddenUserMessage === true;
  const requestSource = typeof requestMetadata.source === "string" ? requestMetadata.source : "internal";
  // Mol* selection attached by the client becomes a structured block in the
  // model-visible user message (kept in the transcript for auditability).
  const structureSelection = parseSelectionContext(requestMetadata.structureSelection);
  const message: string = typeof rawMessage === "string" && structureSelection
    ? `${rawMessage}\n\n${formatSelectionForModel(structureSelection)}`
    : rawMessage;

  // Verify session ownership
  const authSession = await auth();
  const userId = authSession?.user?.id || null;
  if (!(await verifySessionOwnership(sessionId, userId))) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  // Server-side approved commands: only accept commands that were previously
  // blocked for this session. DB persistence survives server restarts; the
  // in-memory hash set is only a same-process race fallback.
  const previouslyBlocked = pendingApprovalHashes.get(sessionId);
  const memoryApproved = previouslyBlocked
    ? filterCommandsByPendingHashes(clientApproved, previouslyBlocked)
    : [];
  pendingApprovalHashes.delete(sessionId);

  let persistedApproved: string[] = [];
  try {
    persistedApproved = await consumeApprovedCommands(sessionId, userId, clientApproved);
  } catch (err) {
    console.error("Failed to consume persisted approvals:", err);
  }
  const approved = Array.from(new Set([...memoryApproved, ...persistedApproved]));

  // Hosted deployments meter runs through the ComputeGate; local mode is open.
  const gateDecision = await (await getComputeGate()).beforeChatRun({ userId, sessionId });
  if (!gateDecision.allowed) {
    return NextResponse.json(
      { error: gateDecision.reason, limitType: gateDecision.code ?? "quota" },
      { status: 429 }
    );
  }

  const runtimeSettings = loadSettings();
  const apiConfig = getEffectiveApiConfig(runtimeSettings);
  const reviewerApiConfig = getFastApiConfig(runtimeSettings);
  if (!apiConfig.key) {
    return NextResponse.json(
      { error: missingKeyMessage(apiConfig.provider), code: "llm_not_configured", provider: apiConfig.provider },
      { status: 400 }
    );
  }
  if (!apiConfig.url) {
    return NextResponse.json(
      { error: "No LLM endpoint configured. Set a base URL for the custom provider in Settings → API.", code: "llm_not_configured", provider: apiConfig.provider },
      { status: 400 }
    );
  }

  const sessionWorkspace = getSessionWorkspace(sessionId);
  // Subagents are agents/<id>.md files (bundled plugin, installed plugins,
  // ~/.chatmol-lab/agents, and this session workspace).
  const activeSubagentIds = requestedSubagentIds === undefined
    ? listFixedSubagents({ cwd: sessionWorkspace }).map((agent) => agent.id)
    : normalizeFixedSubagentIds(requestedSubagentIds, { cwd: sessionWorkspace });
  appendAgentEvent(sessionWorkspace, sessionId, "user_message", {
    content: message,
    ...(hiddenUserMessage ? { hidden: true, source: requestSource } : {}),
  });
  for (const command of approved) {
    appendAgentEvent(sessionWorkspace, sessionId, "approval_granted", { command });
  }

  const session = await loadSession(sessionId);
  const lastMessage = session.messages[session.messages.length - 1];
  const isApprovalRetry = approved.length > 0 && lastMessage?.role === "user" && lastMessage.content === message;
  if (!isApprovalRetry) {
    if (lastMessage?.role === "user") {
      session.messages.push({ role: "assistant", content: "[Previous response was interrupted.]" });
    }
    session.messages.push({
      role: "user",
      content: message,
      ...(hiddenUserMessage ? { hidden: true, source: requestSource } : {}),
    });
  }
  await saveSession(sessionId, userId, { pushCloud: false });

  // Skills: explicitly selected (picker chips) or invoked with a leading
  // `/name` are injected as <skill_content>; every other model-invocable skill
  // is only listed by name + description and loaded on demand via the `skill`
  // tool (dsh-style progressive disclosure).
  const selectedSkillIds: string[] = Array.isArray(skills)
    ? skills.filter((id: unknown): id is string => typeof id === "string")
    : [];
  const slashSkillIds = parseInvokedSkillNames(typeof rawMessage === "string" ? rawMessage : "");
  const invokedSkills = Array.from(new Set([...selectedSkillIds, ...slashSkillIds]))
    .map((id) => getSkill(id, { cwd: sessionWorkspace }))
    .filter((skill): skill is SkillDefinition => !!skill && (skill.userInvocable || selectedSkillIds.includes(skill.id)));
  const invokedIds = new Set(invokedSkills.map((skill) => skill.id));
  const skillCatalog = listSkills({ cwd: sessionWorkspace }).filter((skill) => !invokedIds.has(skill.id));
  const skillSection = buildInvokedSkillsSection(invokedSkills) + buildSkillCatalogSection(skillCatalog);
  const subagentSection = buildFixedSubagentPrompt(activeSubagentIds, { cwd: sessionWorkspace });
  const userPrompt = await getUserSystemPrompt(userId);
  const customPrompt = userPrompt
    ? `\n\n## Custom Instructions\n${userPrompt}`
    : "";
  // Depends on the user's setting only. Nothing here reads the request text:
  // tool exposure must not change with the wording or language of a message.
  const computeCostPolicy = buildComputeCostPolicySection(runtimeSettings.wemolComputeProfile);
  const costPolicySection = `\n\n${computeCostPolicy}`;
  // User-enabled MCP servers (PyMOL, ChimeraX, custom) expose native tools.
  const mcpCatalog = await getMcpToolCatalog(sessionWorkspace).catch(() => ({ definitions: [], servers: [] }));
  // Generic compute tools join the run only when a catalog provider is configured.
  const catalogProviders = await availableCatalogProviders(userId).catch(() => []);
  const computeToolDefinitions = catalogProviders.length > 0 ? COMPUTE_TOOL_DEFINITIONS : [];
  const computeSection = buildComputePromptSection(catalogProviders);
  const extraToolDefinitions = [...mcpCatalog.definitions, ...computeToolDefinitions];
  const mcpSection = buildMcpPromptSection(
    mcpCatalog,
    Object.fromEntries(Object.values(MCP_PRESETS).map((preset) => [preset.id, preset.promptHint])),
  );
  // What the bash interpreter really has (probed, cached). Waits briefly so a
  // cold probe never stalls the first message; later turns use the cache.
  const runtimeManifestText = await getRuntimeManifestSection().catch(() => "");
  const runtimeSection = runtimeManifestText ? `\n\n${runtimeManifestText}` : "";
  const memoryEnabled = runtimeSettings.memoryEnabled;
  const memoryOptions = { cwd: sessionWorkspace, userId };
  const memorySection = memoryEnabled ? buildMemorySection(listMemories(memoryOptions)) : "";
  // Name the reply language instead of relying on a general same-language rule,
  // which the models ignore often enough to matter (see reply-language.ts).
  // It sits before the user's own custom instructions so those can override it.
  const replyLanguageSection = buildReplyLanguageSection(detectReplyLanguage(languageSample(session.messages, message)));
  const systemPrompt = buildSystemPrompt(sessionWorkspace) + runtimeSection + costPolicySection + skillSection + subagentSection + mcpSection + computeSection + memorySection + replyLanguageSection + customPrompt;
  const runSubagentTool = buildRunSubagentToolDefinition(activeSubagentIds, { cwd: sessionWorkspace });
  const activeTools = [
    ...ALL_TOOLS,
    ...(runSubagentTool ? [runSubagentTool] : []),
    ...extraToolDefinitions,
  ];
  const chatSessionContext = await getChatSession(sessionId).catch(() => null);
  const planState = Array.isArray(chatSessionContext?.plan) ? chatSessionContext.plan : [];
  const artifactState = Array.isArray(chatSessionContext?.artifacts) ? chatSessionContext.artifacts : [];
  let compactionState = Array.isArray(chatSessionContext?.compactions)
    ? chatSessionContext.compactions
    : [];

  // Use the request signal for abort handling
  const abortSignal = request.signal;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let approvalPaused = false;
      let assistantDraftIndex: number | null = null;
      let saveTimer: ReturnType<typeof setTimeout> | null = null;
      let saveChain: Promise<void> = Promise.resolve();

      const queueSessionSave = (immediate = false) => {
        if (saveTimer) {
          if (!immediate) return;
          clearTimeout(saveTimer);
          saveTimer = null;
        }

        const runSave = () => {
          saveChain = saveChain
            .catch(() => {})
            .then(() => saveSession(sessionId, userId, { pushCloud: false }));
          return saveChain;
        };

        if (immediate) {
          void runSave();
          return;
        }

        saveTimer = setTimeout(() => {
          saveTimer = null;
          void runSave();
        }, 1_000);
      };

      const flushSessionSave = async (pushCloud: boolean) => {
        if (saveTimer) {
          clearTimeout(saveTimer);
          saveTimer = null;
        }
        saveChain = saveChain
          .catch(() => {})
          .then(() => saveSession(sessionId, userId, { pushCloud }));
        await saveChain;
      };

      const appendAssistantDraft = (content: string) => {
        if (!content) return;
        if (
          assistantDraftIndex === null ||
          session.messages[assistantDraftIndex]?.role !== "assistant"
        ) {
          session.messages.push({ role: "assistant", content: "" });
          assistantDraftIndex = session.messages.length - 1;
        }
        const draft = session.messages[assistantDraftIndex];
        draft.content = typeof draft.content === "string"
          ? draft.content + content
          : content;
        queueSessionSave();
      };

      const replaceSessionMessages = (messages: TurnMessage[], immediate = false) => {
        session.messages = messages;
        assistantDraftIndex = null;
        queueSessionSave(immediate);
      };

      const approvalPersistedHashes = new Set<string>();
      const rememberPendingApprovalHash = (commandHash: string) => {
        if (!pendingApprovalHashes.has(sessionId)) {
          pendingApprovalHashes.set(sessionId, new Set());
        }
        pendingApprovalHashes.get(sessionId)!.add(commandHash);
      };

      const persistPendingApproval = async (approval: {
        command: string;
        toolName?: string | null;
        expiresAt?: number;
      }) => {
        const result = await createPendingApproval({
          sessionId,
          userId,
          command: approval.command,
          toolName: approval.toolName,
          expiresAt: approval.expiresAt,
        });
        approvalPersistedHashes.add(result.commandHash);
        rememberPendingApprovalHash(result.commandHash);
        return { expiresAt: result.expiresAt };
      };

      const persistCompactionRecord = async (record: ContextCompactionRecord) => {
        const nextRecords = [
          ...compactionState.filter((item) => (
            !!item &&
            typeof item === "object" &&
            (item as Record<string, unknown>).id !== record.id
          )),
          record,
        ].slice(-20);
        compactionState = nextRecords;
        await updateChatSession(sessionId, { compactions: nextRecords }, { userId });
      };

      const eventTypeForSSE = (data: Record<string, unknown>): AgentEventType | null => {
        switch (data.type) {
          case "token":
            return "assistant_token";
          case "reasoning_start":
          case "reasoning":
            return "assistant_reasoning";
          case "tool_call":
            return "tool_call";
          case "tool_result":
            return "tool_result";
          case "run_event":
            return "run_event";
          case "artifact":
            return "artifact";
          case "plan":
            return "plan";
          case "select_artifact":
            return "select_artifact";
          case "error":
            return "error";
          case "approval_required":
            return "approval_required";
          case "sandbox_confirm":
            return "sandbox_confirm";
          case "wemol_job":
            return "wemol_job";
          case "compute_job":
            return "compute_job";
          default:
            return null;
        }
      };

      const send: SSESender = (data: Record<string, unknown>) => {
        try {
          let outbound = data;
          if (outbound.type === "token" && typeof outbound.content === "string") {
            appendAssistantDraft(outbound.content);
          }
          if ((outbound.type === "sandbox_confirm" || outbound.type === "approval_required") && typeof outbound.command === "string") {
            const command = outbound.command;
            const toolName = typeof outbound.toolName === "string" ? outbound.toolName : null;
            const commandHash = hashApprovalCommand(command);
            rememberPendingApprovalHash(commandHash);
            const expiresAt = typeof outbound.expiresAt === "number"
              ? outbound.expiresAt
              : getApprovalExpiresAt();
            outbound = { ...outbound, expiresAt };

            // Fallback for runAgentLoop callers that do not pass
            // onApprovalPending (for example subagent runs).
            if (!approvalPersistedHashes.has(commandHash)) {
              approvalPersistedHashes.add(commandHash);
              void persistPendingApproval({
                command,
                toolName,
                expiresAt,
              }).catch((err) => {
                approvalPersistedHashes.delete(commandHash);
                console.error("Failed to persist pending approval:", err);
              });
            }
          }
          if (outbound.type === "approval_required") {
            approvalPaused = true;
          }
          const eventType = eventTypeForSSE(outbound);
          if (eventType) {
            appendAgentEvent(sessionWorkspace, sessionId, eventType, outbound);
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(outbound)}\n\n`));
        } catch {
          // Controller closed (client disconnected)
        }
      };

      const keepaliveInterval = setInterval(() => {
        try { controller.enqueue(encoder.encode(":keepalive\n\n")); } catch {}
      }, 15_000);

      const lastPlanKey = { value: "" };

      const processToolOutputFn = (toolName: string, toolResult: ToolResult) =>
        processToolOutput(toolName, toolResult, send, lastPlanKey);

      try {
        let canonicalBaseMessages: TurnMessage[] = [...session.messages];
        const workspaceFiles = getWorkspaceFiles(sessionWorkspace, sessionWorkspace);
        const compactionConfig = getContextCompactionConfig({
          contextWindow: getModelContextWindow(apiConfig.provider, apiConfig.model),
        });
        const summarize = createModelSummarizer(reviewerApiConfig);
        const projectFor = (force: boolean) => buildContextProjection({
          messages: canonicalBaseMessages,
          systemPrompt,
          tools: activeTools,
          plan: planState,
          artifacts: artifactState,
          workspaceFiles,
          compactions: compactionState,
          config: force ? { ...compactionConfig, keepTurns: 2 } : compactionConfig,
          force,
          summarize,
        });
        const announceProjection = async (projection: ContextProjection, reason: "pressure" | "overflow") => {
          if (!projection.compacted) return;
          const compactionRunId = `context-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          send({
            type: "run_event",
            event: "context_compaction_start",
            runId: compactionRunId,
            ts: Date.now(),
            reason,
            triggerApproxTokens: compactionConfig.triggerApproxTokens,
            keepTurns: compactionConfig.keepTurns,
            originalContextSize: projection.originalSize,
          });
          if (projection.record) {
            await persistCompactionRecord(projection.record).catch((err) => {
              console.error("Failed to persist compaction record:", err);
            });
          }
          send({
            type: "run_event",
            event: "context_compacted",
            runId: compactionRunId,
            ts: Date.now(),
            reason,
            originalApproxTokens: projection.originalSize.approxTokens,
            compactedApproxTokens: projection.compactedSize.approxTokens,
            retainedTurns: compactionConfig.keepTurns,
            retainedStartIndex: projection.retainedStartIndex,
            summarizedMessages: projection.summarizedMessages,
            droppedReasoningChars: projection.droppedReasoningChars,
            summarizedToolOutputChars: projection.summarizedToolOutputChars,
            reusedSummary: projection.reusedRecord === true,
            summaryMode: projection.record?.summaryMode,
          });
        };

        let projection = await projectFor(false);
        await announceProjection(projection, "pressure");

        const updateSessionFromLoopMessages = (messages: TurnMessage[], immediate = false) => {
          if (projection.compacted) {
            session.messages = mergeProjectedTurnMessages(
              canonicalBaseMessages,
              projection.baseTurnMessageCount,
              messages,
            );
            assistantDraftIndex = null;
            queueSessionSave(immediate);
            return;
          }
          replaceSessionMessages(messages, immediate);
        };

        const runLoop = () => runAgentLoop(
          projection.turnMessages,
          projection.systemPrompt,
          activeTools,
          apiConfig,
          sessionWorkspace,
          sessionId,
          send,
          processToolOutputFn,
          approved,
          30,
          undefined,
          abortSignal,
          userId,
          (messages) => updateSessionFromLoopMessages(messages, true),
          async (approval) => persistPendingApproval(approval),
          {
            apiConfig,
            reviewerApiConfig,
            extraTools: extraToolDefinitions,
            enabledSubagentIds: activeSubagentIds,
            send,
            toolReviewMode: runtimeSettings.toolReviewMode,
            computeCostPolicy,
            replyLanguageSection,
            memoryEnabled,
          },
        );

        let loopResult = await runLoop();
        if (loopResult.status === "context_overflow" && !abortSignal.aborted) {
          // Overflow recovery (dsh-style): everything the loop produced is
          // already merged into the canonical transcript; condense it
          // aggressively and re-run once.
          updateSessionFromLoopMessages(loopResult.turnMessages, true);
          canonicalBaseMessages = [...session.messages];
          projection = await projectFor(true);
          await announceProjection(projection, "overflow");
          if (projection.compacted) {
            loopResult = await runLoop();
          } else {
            send({ type: "error", message: loopResult.error || "Context window exceeded and nothing could be compacted." });
          }
        }
        if (loopResult.approvalRequired) {
          approvalPaused = true;
        }

        // If the model produced no usable answer, send a precise diagnostic.
        // API/stream failures already emitted their own error event inside
        // runAgentLoop, so avoid overwriting those with a generic message.
        if (
          loopResult.status === "empty_response" &&
          !loopResult.textContent &&
          !abortSignal.aborted &&
          !loopResult.approvalRequired
        ) {
          console.error(`[chat/route] Agent loop produced no output for sessionId=${sessionId}, message="${message.slice(0, 80)}"`);
          send({ type: "error", message: loopResult.error || "The model returned no response. Please try again." });
        }

        // Persist full conversation (including tool calls/results) so
        // follow-up messages have context about previous tool outputs.
        updateSessionFromLoopMessages(loopResult.turnMessages, true);
      } catch (err: any) {
        appendAgentEvent(sessionWorkspace, sessionId, "error", { message: err.message || "Unknown error" });
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", message: err.message || "Unknown error" })}\n\n`));
        // Ensure session doesn't end with a dangling user message (which would
        // cause consecutive user messages on the next request, breaking the API).
        const lastMsg = session.messages[session.messages.length - 1];
        if (lastMsg && lastMsg.role === "user") {
          session.messages.push({ role: "assistant", content: "[Error occurred — please try again.]" });
        }
      }

      // Repair any corrupted session state: ensure messages alternate properly.
      // Consecutive user messages can accumulate from past bugs and permanently
      // break the LLM API (Anthropic requires strict alternation).
      if (!approvalPaused) {
        session.messages = repairMessageAlternation(session.messages);
      }

      await flushSessionSave(true);

      // Memory distillation: the fast model turns durable knowledge from this
      // run into memory entries (bounded, best effort, never an error).
      if (memoryEnabled && !approvalPaused && !abortSignal.aborted) {
        try {
          const distilled = await distillMemories(session.messages.slice(-24) as TurnMessage[], reviewerApiConfig, memoryOptions);
          if (distilled.saved.length > 0) {
            appendAgentEvent(sessionWorkspace, sessionId, "memory_saved", { names: distilled.saved.map((entry) => entry.name) });
            send({
              type: "run_event",
              event: "memory_saved",
              names: distilled.saved.map((entry) => entry.name),
              scopes: distilled.saved.map((entry) => entry.scope),
            });
          }
        } catch (err) {
          console.warn("[memory] distillation skipped:", err instanceof Error ? err.message : String(err));
        }
      }

      clearInterval(keepaliveInterval);
      appendAgentEvent(sessionWorkspace, sessionId, "done", { approvalPaused });
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new NextResponse(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
  });
}
