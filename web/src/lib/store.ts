import { create } from "zustand";
import { transcriptToDisplayMessages } from "./transcript-display";
import type {
  Message,
  ToolCall,
  PlanStep,
  Artifact,
  Session,
  ArtifactType,
  AgentRunStatus,
  SubagentRun,
  SubagentTraceItem,
} from "./types";
import { getArtifactType } from "./types";
import {
  getSessions,
  createSessionApi,
  deleteSessionApi,
  renameSessionApi,
  getSessionData,
  saveSessionData,
  generateSessionTitle,
} from "./api";
import type { StructureSelectionContext } from "./structure-selection";

interface AppState {
  // Session
  sessions: Session[];
  activeSessionId: string | null;
  sessionsLoaded: boolean;

  // UI state
  selectedArtifact: Artifact | null;
  /** Lower right-panel tab (historically the left panel). */
  leftPanelTab: "plan" | "results" | "subagents";
  isAgentThinking: boolean;
  inputValue: string;
  leftPanelOpen: boolean;
  rightPanelOpen: boolean;
  sidebarOpen: boolean;
  openArtifactPaths: string[];
  workspaceFiles: string[];
  activeSkills: string[];
  /** Residues selected in the Mol* viewer (right panel), attachable to chat. */
  structureSelection: StructureSelectionContext | null;
  attachStructureSelection: boolean;
  /** Settings modal visibility (shared so chat errors can open it). */
  settingsOpen: boolean;

  // Actions
  setSettingsOpen: (open: boolean) => void;
  setStructureSelection: (context: StructureSelectionContext | null) => void;
  setAttachStructureSelection: (attach: boolean) => void;
  loadSessions: () => Promise<void>;
  createSession: () => string;
  deleteSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;
  setActiveSession: (id: string) => void;
  addMessage: (message: Message) => void;
  updateMessage: (id: string, updates: Partial<Message>) => void;
  appendToMessage: (id: string, content: string) => void;
  appendToContentBlock: (messageId: string, text: string) => void;
  appendToReasoningBlock: (messageId: string, text: string) => void;
  addToolUseBlock: (messageId: string, toolCallId: string) => void;
  addToolCall: (messageId: string, toolCall: ToolCall) => void;
  resolveToolCall: (messageId: string, toolName: string, result: string, success: boolean) => void;
  setPlan: (steps: PlanStep[]) => void;
  updatePlanStep: (id: string, updates: Partial<PlanStep>) => void;
  updateRunStatus: (status: Partial<AgentRunStatus> & Pick<AgentRunStatus, "phase" | "label">) => void;
  clearRunStatus: () => void;
  addArtifact: (artifact: Artifact) => void;
  upsertSubagentRun: (sessionId: string, run: SubagentRun) => void;
  appendSubagentTrace: (sessionId: string, runId: string, item: SubagentTraceItem) => void;
  updateSubagentRun: (sessionId: string, runId: string, updates: Partial<SubagentRun>) => void;
  selectArtifact: (artifact: Artifact | null) => void;
  setLeftPanelTab: (tab: "plan" | "results" | "subagents") => void;
  setAgentThinking: (thinking: boolean) => void;
  setInputValue: (value: string) => void;
  toggleLeftPanel: () => void;
  toggleRightPanel: () => void;
  toggleSidebar: () => void;
  closeArtifactTab: (path: string) => void;
  getActiveSession: () => Session | undefined;
  loadSessionData: (id: string) => Promise<void>;
  saveActiveSession: (options?: { includeMessages?: boolean }) => void;
  generateTitle: (sessionId: string, firstMessage: string) => void;
  setWorkspaceFiles: (files: string[]) => void;
  addActiveSkill: (skillId: string) => void;
  removeActiveSkill: (skillId: string) => void;
  setActiveSkills: (skills: string[]) => void;
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Complete the oldest still-running call with this name.
 *
 * Results arrive in the order the calls were announced, and parallel subagents
 * announce both calls up front, so matching from the end attached each result
 * to the wrong task.
 */
export function resolveFirstRunningToolCall(
  toolCalls: ToolCall[],
  toolName: string,
  result: string,
  success: boolean,
): ToolCall[] {
  const index = toolCalls.findIndex((call) => call.name === toolName && call.status === "running");
  if (index === -1) return toolCalls;
  const next = [...toolCalls];
  next[index] = {
    ...next[index],
    status: success ? "completed" : "error",
    result,
    ...(success ? {} : { errorOutput: result }),
  };
  return next;
}

export const useAppStore = create<AppState>()((set, get) => ({
  sessions: [],
  activeSessionId: null,
  sessionsLoaded: false,
  selectedArtifact: null,
  leftPanelTab: "plan",
  isAgentThinking: false,
  inputValue: "",
  leftPanelOpen: true,
  rightPanelOpen: false,
  sidebarOpen: true,
  openArtifactPaths: [],
  workspaceFiles: [],
  activeSkills: [],
  structureSelection: null,
  attachStructureSelection: true,
  settingsOpen: false,

  setSettingsOpen: (open) => set({ settingsOpen: open }),

  setStructureSelection: (context) => set({ structureSelection: context }),
  setAttachStructureSelection: (attach) => set({ attachStructureSelection: attach }),

  loadSessions: async () => {
    try {
      const serverSessions = await getSessions();
      const sessions: Session[] = serverSessions.map((s) => ({
        id: s.id,
        title: s.title,
        createdAt: s.updatedAt,
        updatedAt: s.updatedAt,
        messages: [],
        plan: [],
        artifacts: [],
        subagentRuns: [],
        runStatus: null,
      }));
      set({ sessions, sessionsLoaded: true });
    } catch {
      set({ sessionsLoaded: true });
    }
  },

  createSession: () => {
    const id = generateId();
    const session: Session = {
      id,
      title: "New Research Session",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      plan: [],
      artifacts: [],
      subagentRuns: [],
      runStatus: null,
    };
    set((state) => ({
      sessions: [...state.sessions, session],
      activeSessionId: id,
      selectedArtifact: null,
      openArtifactPaths: [],
    }));
    // Persist to DB asynchronously
    createSessionApi(id).catch(console.error);
    return id;
  },

  deleteSession: (id) => {
    set((state) => {
      const sessions = state.sessions.filter((s) => s.id !== id);
      const activeSessionId =
        state.activeSessionId === id
          ? sessions.length > 0
            ? sessions[sessions.length - 1].id
            : null
          : state.activeSessionId;
      return { sessions, activeSessionId };
    });
    deleteSessionApi(id).catch(console.error);
  },

  renameSession: (id, title) => {
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === id ? { ...s, title, updatedAt: Date.now() } : s
      ),
    }));
    renameSessionApi(id, title).catch(console.error);
  },

  setActiveSession: (id) => set({ activeSessionId: id, selectedArtifact: null, openArtifactPaths: [] }),

  addMessage: (message) =>
    set((state) => {
      const sessions = state.sessions.map((s) => {
        if (s.id === state.activeSessionId) {
          return {
            ...s,
            messages: [...s.messages, message],
            updatedAt: Date.now(),
          };
        }
        return s;
      });
      return { sessions };
    }),

  updateMessage: (id, updates) =>
    set((state) => {
      const sessions = state.sessions.map((s) => {
        if (s.id === state.activeSessionId) {
          return {
            ...s,
            messages: s.messages.map((m) =>
              m.id === id ? { ...m, ...updates } : m
            ),
            updatedAt: Date.now(),
          };
        }
        return s;
      });
      return { sessions };
    }),

  appendToMessage: (id, content) =>
    set((state) => {
      const sessions = state.sessions.map((s) => {
        if (s.id === state.activeSessionId) {
          return {
            ...s,
            messages: s.messages.map((m) =>
              m.id === id ? { ...m, content: m.content + content } : m
            ),
          };
        }
        return s;
      });
      return { sessions };
    }),

  appendToContentBlock: (messageId, text) =>
    set((state) => {
      const sessions = state.sessions.map((s) => {
        if (s.id === state.activeSessionId) {
          return {
            ...s,
            messages: s.messages.map((m) => {
              if (m.id !== messageId) return m;
              const blocks = m.contentBlocks ? [...m.contentBlocks] : [];
              const last = blocks[blocks.length - 1];
              if (last && last.type === "text") {
                blocks[blocks.length - 1] = { type: "text", text: last.text + text };
              } else {
                blocks.push({ type: "text", text });
              }
              return { ...m, content: m.content + text, contentBlocks: blocks };
            }),
          };
        }
        return s;
      });
      return { sessions };
    }),

  appendToReasoningBlock: (messageId, text) =>
    set((state) => {
      const sessions = state.sessions.map((s) => {
        if (s.id === state.activeSessionId) {
          return {
            ...s,
            messages: s.messages.map((m) => {
              if (m.id !== messageId) return m;
              const blocks = m.contentBlocks ? [...m.contentBlocks] : [];
              const last = blocks[blocks.length - 1];
              if (last && last.type === "reasoning") {
                blocks[blocks.length - 1] = { type: "reasoning", text: last.text + text };
              } else {
                blocks.push({ type: "reasoning", text });
              }
              return { ...m, contentBlocks: blocks };
            }),
          };
        }
        return s;
      });
      return { sessions };
    }),

  addToolUseBlock: (messageId, toolCallId) =>
    set((state) => {
      const sessions = state.sessions.map((s) => {
        if (s.id === state.activeSessionId) {
          return {
            ...s,
            messages: s.messages.map((m) => {
              if (m.id !== messageId) return m;
              const blocks = m.contentBlocks ? [...m.contentBlocks] : [];
              blocks.push({ type: "tool_use", toolCallId });
              return { ...m, contentBlocks: blocks };
            }),
          };
        }
        return s;
      });
      return { sessions };
    }),

  addToolCall: (messageId, toolCall) =>
    set((state) => {
      const sessions = state.sessions.map((s) => {
        if (s.id === state.activeSessionId) {
          return {
            ...s,
            messages: s.messages.map((m) => {
              if (m.id !== messageId) return m;
              const currentToolCalls = m.toolCalls || [];
              const blocks = m.contentBlocks ? [...m.contentBlocks] : [];
              blocks.push({ type: "tool_use", toolCallId: toolCall.id });
              return {
                ...m,
                toolCalls: [...currentToolCalls, toolCall],
                contentBlocks: blocks,
              };
            }),
          };
        }
        return s;
      });
      return { sessions };
    }),

  resolveToolCall: (messageId, toolName, result, success) =>
    set((state) => {
      const sessions = state.sessions.map((s) => {
        if (s.id === state.activeSessionId) {
          return {
            ...s,
            messages: s.messages.map((m) => {
              if (m.id !== messageId) return m;
              return { ...m, toolCalls: resolveFirstRunningToolCall(m.toolCalls || [], toolName, result, success) };
            }),
          };
        }
        return s;
      });
      return { sessions };
    }),

  setPlan: (steps) =>
    set((state) => {
      const sessions = state.sessions.map((s) => {
        if (s.id === state.activeSessionId) {
          // Merge: preserve higher-rank statuses from existing steps
          const STATUS_RANK: Record<string, number> = { pending: 0, in_progress: 1, completed: 2, error: 2 };
          const existingById = new Map(s.plan.map((p) => [p.id, p]));
          const merged = steps.map((step) => {
            const existing = existingById.get(step.id);
            if (existing) {
              const existingRank = STATUS_RANK[existing.status] ?? 0;
              const newRank = STATUS_RANK[step.status] ?? 0;
              // Keep whichever status is further along
              if (existingRank > newRank) {
                return { ...step, status: existing.status };
              }
            }
            return step;
          });
          return { ...s, plan: merged, updatedAt: Date.now() };
        }
        return s;
      });
      return { sessions };
    }),

  updatePlanStep: (id, updates) =>
    set((state) => {
      const sessions = state.sessions.map((s) => {
        if (s.id === state.activeSessionId) {
          return {
            ...s,
            plan: s.plan.map((step) =>
              step.id === id ? { ...step, ...updates } : step
            ),
            updatedAt: Date.now(),
          };
        }
        return s;
      });
      return { sessions };
    }),

  updateRunStatus: (status) =>
    set((state) => ({
      sessions: state.sessions.map((s) => {
        if (s.id !== state.activeSessionId) return s;
        return {
          ...s,
          runStatus: {
            ...(s.runStatus ?? {}),
            ...status,
            updatedAt: Date.now(),
          },
          updatedAt: Date.now(),
        };
      }),
    })),

  clearRunStatus: () =>
    set((state) => ({
      sessions: state.sessions.map((s) =>
        s.id === state.activeSessionId ? { ...s, runStatus: null } : s
      ),
    })),

  addArtifact: (artifact) =>
    set((state) => {
      const sessions = state.sessions.map((s) => {
        if (s.id === state.activeSessionId) {
          const exists = s.artifacts.some((a) => a.path === artifact.path);
          return {
            ...s,
            artifacts: exists
              ? s.artifacts.map((a) =>
                  a.path === artifact.path ? artifact : a
                )
              : [...s.artifacts, artifact],
            updatedAt: Date.now(),
          };
        }
        return s;
      });
      const openArtifactPaths = state.openArtifactPaths.includes(artifact.path)
        ? state.openArtifactPaths
        : [...state.openArtifactPaths, artifact.path];
      return { sessions, openArtifactPaths };
    }),

  upsertSubagentRun: (sessionId, run) =>
    set((state) => ({
      sessions: state.sessions.map((session) => {
        if (session.id !== sessionId) return session;
        const runs = session.subagentRuns || [];
        const index = runs.findIndex((item) => item.id === run.id);
        const nextRuns = index >= 0
          ? runs.map((item) => item.id === run.id ? { ...item, ...run, trace: run.trace.length > 0 ? run.trace : item.trace } : item)
          : [...runs, run];
        return { ...session, subagentRuns: nextRuns };
      }),
    })),

  appendSubagentTrace: (sessionId, runId, item) =>
    set((state) => ({
      sessions: state.sessions.map((session) => {
        if (session.id !== sessionId) return session;
        const runs = session.subagentRuns || [];
        return {
          ...session,
          subagentRuns: runs.map((run) => (
            run.id === runId
              ? {
                  ...run,
                  trace: (() => {
                    const previous = run.trace[run.trace.length - 1];
                    if (
                      previous &&
                      previous.type === "assistant" &&
                      item.type === "assistant" &&
                      previous.title === item.title
                    ) {
                      return [
                        ...run.trace.slice(0, -1),
                        {
                          ...previous,
                          content: `${previous.content || ""}${item.content || ""}`,
                          ts: item.ts,
                        },
                      ];
                    }
                    return [...run.trace, item];
                  })(),
                  updatedAt: item.ts,
                }
              : run
          )),
        };
      }),
    })),

  updateSubagentRun: (sessionId, runId, updates) =>
    set((state) => ({
      sessions: state.sessions.map((session) => {
        if (session.id !== sessionId) return session;
        const runs = session.subagentRuns || [];
        return {
          ...session,
          subagentRuns: runs.map((run) => (
            run.id === runId
              ? { ...run, ...updates, trace: updates.trace || run.trace }
              : run
          )),
        };
      }),
    })),

  selectArtifact: (artifact) =>
    set((state) => {
      const openArtifactPaths = artifact && !state.openArtifactPaths.includes(artifact.path)
        ? [...state.openArtifactPaths, artifact.path]
        : state.openArtifactPaths;
      return { selectedArtifact: artifact, rightPanelOpen: artifact !== null, openArtifactPaths };
    }),

  setLeftPanelTab: (tab) => set({ leftPanelTab: tab }),
  setAgentThinking: (thinking) => set({ isAgentThinking: thinking }),
  setInputValue: (value) => set({ inputValue: value }),
  toggleLeftPanel: () =>
    set((state) => ({ leftPanelOpen: !state.leftPanelOpen })),
  toggleRightPanel: () =>
    set((state) => ({ rightPanelOpen: !state.rightPanelOpen })),
  toggleSidebar: () =>
    set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  closeArtifactTab: (path) =>
    set((state) => {
      const openArtifactPaths = state.openArtifactPaths.filter((p) => p !== path);
      const wasCurrent = state.selectedArtifact?.path === path;
      if (!wasCurrent) return { openArtifactPaths };
      // Auto-select last remaining open tab, or deselect
      if (openArtifactPaths.length === 0) {
        return { openArtifactPaths, selectedArtifact: null };
      }
      const session = state.sessions.find((s) => s.id === state.activeSessionId);
      const lastPath = openArtifactPaths[openArtifactPaths.length - 1];
      const next = session?.artifacts.find((a) => a.path === lastPath) || null;
      return { openArtifactPaths, selectedArtifact: next };
    }),

  getActiveSession: () => {
    const state = get();
    return state.sessions.find((s) => s.id === state.activeSessionId);
  },

  loadSessionData: async (id) => {
    try {
      const data = await getSessionData(id);
      if (!data) return;
      const rawMessages = Array.isArray(data.messages) ? data.messages : [];
      // Internal instructions (for example automatic WeMol job completion
      // follow-ups) are part of the canonical transcript for the LLM, but are
      // not user-authored chat bubbles.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const visibleRawMessages = rawMessages.filter((m: any) => m?.hidden !== true);
      const plan = Array.isArray(data.plan) ? data.plan : [];
      const artifacts = Array.isArray(data.artifacts) ? data.artifacts : [];
      // Only populate if we got real data
      if (visibleRawMessages.length === 0 && plan.length === 0 && artifacts.length === 0) return;
      // Raw transcripts (OpenAI-style tool_calls + role=tool results) and
      // frontend snapshots both become display messages. Consecutive assistant
      // turns between two user messages merge, so their tool calls fold into one
      // activity line after a reload, exactly as they do while streaming.
      const messages: Message[] = transcriptToDisplayMessages(visibleRawMessages, id);
      set((state) => ({
        sessions: state.sessions.map((s) => {
          if (s.id !== id) return s;
          // Race guard: if the user started using this session while the load
          // was in flight (e.g. sent a message / a turn is streaming), do NOT
          // clobber the live messages with the stale DB snapshot.
          if (s.messages.length > 0) return s;
          return { ...s, messages, plan, artifacts, subagentRuns: s.subagentRuns || [] };
        }),
      }));
    } catch {}
  },

  saveActiveSession: (options = {}) => {
    const state = get();
    const session = state.sessions.find((s) => s.id === state.activeSessionId);
    if (!session || session.messages.length === 0) return;
    const includeMessages = options.includeMessages !== false;
    // Strip streaming flags before persisting when messages are explicitly saved.
    const messages = includeMessages
      ? session.messages.map(({ isStreaming, ...rest }) => rest)
      : undefined;
    saveSessionData(session.id, messages, session.plan, session.artifacts).catch(console.error);
  },

  generateTitle: (sessionId, firstMessage) => {
    // Defer title generation so it never competes with the conversation
    setTimeout(() => {
      generateSessionTitle(sessionId, firstMessage)
        .then((title) => {
          if (title) {
            set((state) => ({
              sessions: state.sessions.map((s) =>
                s.id === sessionId ? { ...s, title } : s
              ),
            }));
            renameSessionApi(sessionId, title).catch(console.error);
          }
        })
        .catch(console.error);
    }, 500);
  },

  setWorkspaceFiles: (files) => set({ workspaceFiles: files }),

  addActiveSkill: (skillId) =>
    set((state) => ({
      activeSkills: state.activeSkills.includes(skillId)
        ? state.activeSkills
        : [...state.activeSkills, skillId],
    })),

  removeActiveSkill: (skillId) =>
    set((state) => ({
      activeSkills: state.activeSkills.filter((s) => s !== skillId),
    })),

  setActiveSkills: (skills) => set({ activeSkills: skills }),
}));
