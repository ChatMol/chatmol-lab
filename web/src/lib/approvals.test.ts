import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMock = vi.hoisted(() => ({
  pendingApproval: {
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
    create: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock("./db", () => ({
  prisma: prismaMock,
}));

import {
  consumeApprovedCommands,
  createPendingApproval,
  filterCommandsByPendingHashes,
  hashApprovalCommand,
} from "./approvals";

describe("approvals", () => {
  beforeEach(() => {
    for (const fn of Object.values(prismaMock.pendingApproval)) {
      fn.mockReset();
    }
    prismaMock.pendingApproval.updateMany.mockResolvedValue({ count: 0 });
    prismaMock.pendingApproval.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.pendingApproval.create.mockResolvedValue({});
    prismaMock.pendingApproval.update.mockResolvedValue({});
  });

  it("hashes commands deterministically without storing the raw command", async () => {
    const command = "cat /tmp/session/output.log";
    const commandHash = hashApprovalCommand(command);

    await createPendingApproval({
      sessionId: "s1",
      userId: "u1",
      command,
      toolName: "bash",
      expiresAt: 123456,
      now: 1000,
    });

    expect(commandHash).toBe(hashApprovalCommand(command));
    expect(commandHash).not.toContain(command);
    expect(prismaMock.pendingApproval.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        sessionId: "s1",
        userId: "u1",
        commandHash,
        toolName: "bash",
        status: "pending",
        expiresAt: new Date(123456),
      }),
    });
    const createData = prismaMock.pendingApproval.create.mock.calls[0][0].data;
    expect(JSON.stringify(createData)).not.toContain(command);
  });

  it("accepts a command only when a pending hash exists", () => {
    const accepted = "rm -rf /tmp/session/build";
    const pending = new Set([hashApprovalCommand(accepted)]);

    expect(filterCommandsByPendingHashes([accepted, "echo nope"], pending)).toEqual([accepted]);
  });

  it("consumes approved commands once", async () => {
    const command = "cat /tmp/session/output.log";
    prismaMock.pendingApproval.findFirst.mockResolvedValueOnce({ id: "approval_1" });

    const approved = await consumeApprovedCommands("s1", "u1", [command, command], 2000);

    expect(approved).toEqual([command]);
    expect(prismaMock.pendingApproval.findFirst).toHaveBeenCalledTimes(1);
    expect(prismaMock.pendingApproval.update).toHaveBeenCalledWith({
      where: { id: "approval_1" },
      data: {
        status: "consumed",
        approvedAt: new Date(2000),
        consumedAt: new Date(2000),
      },
    });
  });

  it("rejects expired or unknown commands", async () => {
    prismaMock.pendingApproval.findFirst.mockResolvedValueOnce(null);

    const approved = await consumeApprovedCommands("s1", null, ["echo denied"], 3000);

    expect(approved).toEqual([]);
    expect(prismaMock.pendingApproval.update).not.toHaveBeenCalled();
  });
});
