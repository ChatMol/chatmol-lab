import { isElectronServer } from "./electron";
import { getDesktopSyncToken } from "./settings";
import {
  getChatSession,
  getChatSessions,
  updateChatSession,
  deleteChatSession,
  type ChatSessionRow,
} from "./session-db";

const REMOTE_URL = process.env.CHATMOL_REMOTE_URL || "https://lab.cloudmol.org";

type RemoteSessionSummary = {
  id: string;
  title: string;
  updatedAt: number;
  messageCount?: number;
};

function syncEnabled(): boolean {
  return isElectronServer() && !!getDesktopSyncToken();
}

async function remoteFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const token = getDesktopSyncToken();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${REMOTE_URL}${path}`, {
    ...init,
    headers,
  });
}

export async function pullCloudSessions(userId: string | null): Promise<void> {
  if (!userId || !syncEnabled()) return;

  try {
    const res = await remoteFetch("/api/sync/sessions");
    if (!res.ok) {
      console.warn("[cloud-sync] pull list failed:", res.status);
      return;
    }

    const remoteSessions = (await res.json()) as RemoteSessionSummary[];
    const localSessions = await getChatSessions(userId);
    const localById = new Map(localSessions.map((session) => [session.id, session]));

    for (const remote of remoteSessions) {
      const local = localById.get(remote.id);
      if (local && local.updatedAt >= remote.updatedAt) continue;

      const detailRes = await remoteFetch(`/api/sync/sessions?id=${encodeURIComponent(remote.id)}`);
      if (!detailRes.ok) continue;

      const detail = (await detailRes.json()) as ChatSessionRow | null;
      if (!detail) continue;

      await updateChatSession(
        detail.id,
        {
          title: detail.title,
          messages: detail.messages,
          plan: detail.plan,
          artifacts: detail.artifacts,
          compactions: detail.compactions,
        },
        { userId }
      );
    }
  } catch (err) {
    console.warn("[cloud-sync] pull failed:", err);
  }
}

export async function pushSessionToCloud(sessionId: string): Promise<void> {
  if (!syncEnabled()) return;

  try {
    const session = await getChatSession(sessionId);
    if (!session) return;

    const res = await remoteFetch("/api/sync/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: session.id,
        title: session.title,
        messages: session.messages,
        plan: session.plan,
        artifacts: session.artifacts,
        compactions: session.compactions,
      }),
    });
    if (!res.ok) {
      console.warn("[cloud-sync] push failed:", sessionId, res.status);
    }
  } catch (err) {
    console.warn("[cloud-sync] push failed:", err);
  }
}

export async function deleteCloudSession(sessionId: string): Promise<void> {
  if (!syncEnabled()) return;

  try {
    await remoteFetch(`/api/sync/sessions?id=${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
  } catch (err) {
    console.warn("[cloud-sync] delete failed:", err);
  }
}
