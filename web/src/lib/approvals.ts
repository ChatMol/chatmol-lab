import * as crypto from "crypto";

import { prisma } from "./db";

export type ApprovalStatus = "pending" | "approved" | "consumed" | "expired" | "revoked";

export interface PendingApprovalRecord {
  id: string;
  sessionId: string;
  userId: string | null;
  commandHash: string;
  toolName: string | null;
  status: ApprovalStatus;
  createdAt: Date;
  expiresAt: Date;
  approvedAt: Date | null;
  consumedAt: Date | null;
}

export interface PendingApprovalInput {
  sessionId: string;
  userId: string | null;
  command: string;
  toolName?: string | null;
  now?: number;
  expiresAt?: number;
}

export interface PendingApprovalResult {
  commandHash: string;
  expiresAt: number;
}

const DEFAULT_APPROVAL_TTL_MS = 30 * 60 * 1000;

export function hashApprovalCommand(command: string): string {
  return crypto.createHash("sha256").update(command, "utf8").digest("hex");
}

export function getApprovalTtlMs(): number {
  const raw = Number.parseInt(process.env.APPROVAL_TTL_MS || "", 10);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_APPROVAL_TTL_MS;
  return raw;
}

export function getApprovalExpiresAt(now = Date.now()): number {
  return now + getApprovalTtlMs();
}

export function filterCommandsByPendingHashes(
  commands: string[],
  pendingHashes: Set<string>,
): string[] {
  const accepted: string[] = [];
  const seen = new Set<string>();
  for (const command of commands) {
    if (typeof command !== "string" || seen.has(command)) continue;
    seen.add(command);
    if (pendingHashes.has(hashApprovalCommand(command))) {
      accepted.push(command);
    }
  }
  return accepted;
}

export async function expirePendingApprovals(now = Date.now()): Promise<void> {
  await prisma.pendingApproval.updateMany({
    where: {
      status: "pending",
      expiresAt: { lte: new Date(now) },
    },
    data: { status: "expired" },
  });
}

export async function createPendingApproval(
  input: PendingApprovalInput,
): Promise<PendingApprovalResult> {
  const now = input.now ?? Date.now();
  const expiresAt = input.expiresAt ?? getApprovalExpiresAt(now);
  const commandHash = hashApprovalCommand(input.command);

  await expirePendingApprovals(now);
  await prisma.pendingApproval.deleteMany({
    where: {
      sessionId: input.sessionId,
      commandHash,
      status: "pending",
    },
  });
  await prisma.pendingApproval.create({
    data: {
      sessionId: input.sessionId,
      userId: input.userId,
      commandHash,
      toolName: input.toolName ?? null,
      status: "pending",
      expiresAt: new Date(expiresAt),
    },
  });

  return { commandHash, expiresAt };
}

export async function consumeApprovedCommands(
  sessionId: string,
  userId: string | null,
  commands: string[],
  now = Date.now(),
): Promise<string[]> {
  if (commands.length === 0) return [];

  await expirePendingApprovals(now);

  const accepted: string[] = [];
  const seen = new Set<string>();
  const nowDate = new Date(now);

  for (const command of commands) {
    if (typeof command !== "string" || seen.has(command)) continue;
    seen.add(command);

    const commandHash = hashApprovalCommand(command);
    const pending = await prisma.pendingApproval.findFirst({
      where: {
        sessionId,
        userId,
        commandHash,
        status: "pending",
        expiresAt: { gt: nowDate },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (!pending) continue;

    await prisma.pendingApproval.update({
      where: { id: pending.id },
      data: {
        status: "consumed",
        approvedAt: nowDate,
        consumedAt: nowDate,
      },
    });
    accepted.push(command);
  }

  return accepted;
}
