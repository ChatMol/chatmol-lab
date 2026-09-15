import { prisma } from "./db";

export interface ChatSessionRow {
  id: string;
  userId: string | null;
  title: string;
  messages: unknown[];
  plan: unknown[];
  artifacts: unknown[];
  compactions: unknown[];
  createdAt: number;
  updatedAt: number;
}

function toRow(s: {
  id: string;
  userId: string | null;
  title: string;
  messages: string;
  plan: string;
  artifacts: string;
  compactions: string;
  createdAt: Date;
  updatedAt: Date;
}): ChatSessionRow {
  return {
    id: s.id,
    userId: s.userId,
    title: s.title,
    messages: JSON.parse(s.messages),
    plan: JSON.parse(s.plan),
    artifacts: JSON.parse(s.artifacts),
    compactions: JSON.parse(s.compactions),
    createdAt: s.createdAt.getTime(),
    updatedAt: s.updatedAt.getTime(),
  };
}

export async function createChatSession(
  id: string,
  userId: string | null
): Promise<ChatSessionRow> {
  const session = await prisma.chatSession.create({
    data: {
      id,
      userId,
      title: "New Research Session",
      messages: "[]",
      plan: "[]",
      artifacts: "[]",
      compactions: "[]",
    },
  });
  return toRow(session);
}

export async function getChatSessions(
  userId: string | null
): Promise<ChatSessionRow[]> {
  const sessions = await prisma.chatSession.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
  });
  return sessions.map(toRow);
}

export async function getChatSession(
  id: string
): Promise<ChatSessionRow | null> {
  const session = await prisma.chatSession.findUnique({ where: { id } });
  if (!session) return null;
  return toRow(session);
}

export async function updateChatSession(
  id: string,
  updates: {
    title?: string;
    messages?: unknown[];
    plan?: unknown[];
    artifacts?: unknown[];
    compactions?: unknown[];
  },
  options?: { userId: string | null }
): Promise<void> {
  const data: Record<string, unknown> = {};
  if (updates.title !== undefined) data.title = updates.title;
  if (updates.messages !== undefined)
    data.messages = JSON.stringify(updates.messages);
  if (updates.plan !== undefined) data.plan = JSON.stringify(updates.plan);
  if (updates.artifacts !== undefined)
    data.artifacts = JSON.stringify(updates.artifacts);
  if (updates.compactions !== undefined)
    data.compactions = JSON.stringify(updates.compactions);

  if (!options) {
    await prisma.chatSession.update({
      where: { id },
      data,
    });
    return;
  }

  await prisma.chatSession.upsert({
    where: { id },
    update: data,
    create: {
      id,
      userId: options.userId,
      title: updates.title || "New Research Session",
      messages: updates.messages ? JSON.stringify(updates.messages) : "[]",
      plan: updates.plan ? JSON.stringify(updates.plan) : "[]",
      artifacts: updates.artifacts ? JSON.stringify(updates.artifacts) : "[]",
      compactions: updates.compactions ? JSON.stringify(updates.compactions) : "[]",
    },
  });
}

export async function deleteChatSession(id: string): Promise<void> {
  await prisma.chatSession.delete({ where: { id } }).catch(() => {});
}

/**
 * Verify that a chat session belongs to the given user.
 * Returns true if:
 *  - The session exists and session.userId matches userId
 *  - The session exists with null userId (guest session) and userId is also null
 * Returns false if the session doesn't exist or userId doesn't match.
 */
export async function verifySessionOwnership(
  sessionId: string,
  userId: string | null,
  options: { allowMissing?: boolean } = {}
): Promise<boolean> {
  const { allowMissing = true } = options;
  const session = await prisma.chatSession.findUnique({
    where: { id: sessionId },
    select: { userId: true },
  });
  if (!session) {
    if (!allowMissing) return false;
    await createChatSession(sessionId, userId).catch(async () => {
      const existing = await prisma.chatSession.findUnique({
        where: { id: sessionId },
        select: { userId: true },
      });
      if (!existing || existing.userId !== userId) {
        throw new Error("Failed to verify session ownership");
      }
    });
    return true;
  }
  // Guest sessions are only available to unauthenticated requests.
  return session.userId === userId;
}
