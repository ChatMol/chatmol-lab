import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ancestorsWithin,
  buildSeatbeltProfile,
  classifySeatbeltDenial,
  describeSandboxPolicyForModel,
  getSandboxDenial,
  isSeatbeltAvailable,
  recordSandboxDenial,
  renderSandboxDenial,
  resolveSandboxPolicy,
  validateEscalation,
  wasSandboxDenied,
} from "./sandbox";

describe("sandbox policy", () => {
  it("writes deny-then-allow so the narrower allow wins under SBPL last-match semantics", () => {
    const profile = buildSeatbeltProfile({
      mode: "workspace-write",
      workspaceRoot: "/ws/root/sessA",
      extraWritableRoots: ["/rt/env", "/private/tmp"],
      unreadableRoots: ["/ws/root", "/Users/me/.ssh"],
      readableExceptions: ["/ws/root/sessA"],
    });
    expect(profile.indexOf("(deny file-write*)")).toBeLessThan(profile.indexOf('(allow file-write* (subpath "/ws/root/sessA")'));
    expect(profile.indexOf('(deny file-read* (subpath "/ws/root")')).toBeLessThan(profile.indexOf('(allow file-read* (subpath "/ws/root/sessA"))'));
    expect(profile).toContain('(subpath "/rt/env")');
    expect(profile).toContain('(subpath "/Users/me/.ssh")');
    expect(profile).toContain('(literal "/dev/null")');
  });

  it("resolves sibling sessions as unreadable and the own session as the exception", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cm-sbx-"));
    const session = path.join(root, "sess1");
    fs.mkdirSync(session);
    const policy = resolveSandboxPolicy({ sessionWorkspace: session, workspaceRoot: root, runtimeRoots: ["/definitely/missing"], tmpDir: os.tmpdir() });
    const realRoot = fs.realpathSync(root);
    expect(policy.workspaceRoot).toBe(fs.realpathSync(session));
    expect(policy.unreadableRoots).toContain(realRoot);
    expect(policy.readableExceptions).toContain(fs.realpathSync(session));
    expect(policy.extraWritableRoots).not.toContain("/definitely/missing");
    expect(policy.extraWritableRoots).toContain("/private/tmp");
  });

  it("classifies EPERM on a failed run as a denial, never on a successful one", () => {
    expect(classifySeatbeltDenial("sh: /Users/x/a.txt: Operation not permitted", 1)).toBe(true);
    expect(classifySeatbeltDenial("PermissionError: [Errno 1] Operation not permitted: '/Users/x'", 1)).toBe(true);
    expect(classifySeatbeltDenial("couldn't create cache file (errno=Operation not permitted)", 0)).toBe(false);
    expect(classifySeatbeltDenial("ModuleNotFoundError: No module named 'Bio'", 1)).toBe(false);
  });

  it("renders the denial as a policy fact with the escalation hint", () => {
    const text = renderSandboxDenial("workspace-write", "/ws/sess", true);
    expect(text).toContain("[sandbox: file access denied under workspace-write mode");
    expect(text).toContain("sandbox_permissions");
    expect(renderSandboxDenial("workspace-write", "/ws/sess", false)).not.toContain("sandbox_permissions");
  });

  it("remembers denials per session so a same-command escalation is valid", () => {
    recordSandboxDenial("s1", "echo x > /Users/me/out.txt\n", "sh: /Users/me/out.txt: Operation not permitted");
    expect(wasSandboxDenied("s1", "echo x > /Users/me/out.txt")).toBe(true);
    expect(getSandboxDenial("s1", "echo x > /Users/me/out.txt")?.detail).toMatch(/Operation not permitted/);
    expect(wasSandboxDenied("s1", "echo y > /Users/me/out.txt")).toBe(false);
    expect(wasSandboxDenied("s2", "echo x > /Users/me/out.txt")).toBe(false);
    expect(wasSandboxDenied("s1", "echo x > /Users/me/out.txt", Date.now() + 60 * 60_000)).toBe(false);
  });
});

describe("sandbox escalation validation", () => {
  const enforcing = { sandboxEnforcing: true, priorDenial: true, currentMode: "workspace-write" as const };

  it("accepts a justified retry of a denied command", () => {
    expect(validateEscalation({ sandboxPermissions: "danger-full-access", justification: "Needs to save under ~/Desktop as the user asked." }, enforcing)).toBeNull();
  });

  it("is a no-op without escalation fields", () => {
    expect(validateEscalation({}, enforcing)).toBeNull();
  });

  it("fails closed on speculative, unjustified, unknown-mode, or unsandboxed requests", () => {
    expect(validateEscalation({ sandboxPermissions: "danger-full-access", justification: "x" }, { ...enforcing, priorDenial: false })).toMatch(/not denied/);
    expect(validateEscalation({ sandboxPermissions: "danger-full-access" }, enforcing)).toMatch(/justification/);
    expect(validateEscalation({ sandboxPermissions: "workspace-write", justification: "x" }, enforcing)).toMatch(/must be/);
    expect(validateEscalation({ sandboxPermissions: "danger-full-access", justification: "x" }, { ...enforcing, sandboxEnforcing: false })).toMatch(/not available/);
    expect(validateEscalation({ sandboxPermissions: "danger-full-access", justification: "x" }, { ...enforcing, currentMode: "danger-full-access" })).toMatch(/already/);
  });

  it("describes the workspace policy, the unsandboxed host, or nothing", () => {
    expect(describeSandboxPolicyForModel({ backend: "seatbelt", enforcing: true }, "workspace-write", "/ws")).toContain("workspace-write");
    // No OS sandbox: the model is told every bash call stops for approval.
    const unsandboxed = describeSandboxPolicyForModel({ backend: "none", enforcing: false }, "workspace-write", "/ws");
    expect(unsandboxed).toContain("No OS sandbox is enforcing");
    expect(unsandboxed).toContain("approval");
    expect(describeSandboxPolicyForModel({ backend: "seatbelt", enforcing: true }, "danger-full-access", "/ws")).toBe("");
  });
});

// Real Seatbelt run on macOS hosts that have sandbox-exec; skipped elsewhere.
describe.skipIf(!isSeatbeltAvailable())("seatbelt enforcement (macOS)", () => {
  let root: string;
  let session: string;
  let sibling: string;
  let outside: string;
  let profile: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.homedir(), ".cm-sbx-test-"));
    session = path.join(root, "sessA");
    sibling = path.join(root, "sessB");
    outside = fs.mkdtempSync(path.join(os.homedir(), ".cm-sbx-outside-"));
    fs.mkdirSync(session);
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, "secret.txt"), "secret");
    fs.writeFileSync(path.join(session, "inside.txt"), "inside");
    const policy = resolveSandboxPolicy({ sessionWorkspace: session, workspaceRoot: root, tmpDir: os.tmpdir() });
    profile = buildSeatbeltProfile(policy);
  });

  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    if (outside) fs.rmSync(outside, { recursive: true, force: true });
  });
  const run = (cmd: string): { code: number; stderr: string } => {
    try {
      execFileSync("/usr/bin/sandbox-exec", ["-p", profile, "/bin/sh", "-c", cmd], { cwd: session, stdio: ["ignore", "pipe", "pipe"] });
      return { code: 0, stderr: "" };
    } catch (err) {
      const e = err as { status?: number; stderr?: Buffer };
      return { code: e.status ?? 1, stderr: String(e.stderr || "") };
    }
  };

  it("reaches its own session by absolute path, and still cannot read the root or a sibling", () => {
    // Traversal rights on the parent are metadata only: getting to the session
    // must work, reading what else lives next to it must not.
    expect(run(`cd "${session}" && echo ok`).code).toBe(0);
    expect(run(`cat "${session}/inside.txt"`).code).toBe(0);
    expect(run(`ls "${root}"`).code).not.toBe(0);
    expect(run(`cat "${sibling}/secret.txt"`).code).not.toBe(0);
  });

  it("allows writes inside the session and denies them outside", () => {
    expect(run("echo hi > inside.txt").code).toBe(0);
    const denied = run(`echo hi > ${JSON.stringify(path.join(outside, "w.txt"))}`);
    expect(denied.code).not.toBe(0);
    expect(classifySeatbeltDenial(denied.stderr, denied.code)).toBe(true);
    expect(fs.existsSync(path.join(outside, "w.txt"))).toBe(false);
  });

  it("denies reading a sibling session", () => {
    const denied = run(`cat ${JSON.stringify(path.join(sibling, "secret.txt"))}`);
    expect(denied.code).not.toBe(0);
    expect(denied.stderr).toMatch(/Operation not permitted/);
    expect(run("cat inside.txt").code).toBe(0);
  });

});

describe("ancestor traversal", () => {
  it("lists the directories between a denied root and an allowed path", () => {
    expect(ancestorsWithin("/ws/sessions/a", ["/ws"])).toEqual(["/ws/sessions", "/ws"]);
    expect(ancestorsWithin("/ws/a", ["/ws"])).toEqual(["/ws"]);
  });

  it("ignores paths that are not under a denied root", () => {
    expect(ancestorsWithin("/other/a", ["/ws"])).toEqual([]);
    expect(ancestorsWithin("/ws", ["/ws"])).toEqual([]);
    expect(ancestorsWithin("/wsx/a", ["/ws"])).toEqual([]);
  });

  it("puts the traversal grant in the profile after the deny", () => {
    const profile = buildSeatbeltProfile({
      workspaceRoot: "/ws/sess",
      extraWritableRoots: [],
      unreadableRoots: ["/ws"],
      readableExceptions: ["/ws/sess"],
      mode: "workspace-write",
    } as Parameters<typeof buildSeatbeltProfile>[0]);
    expect(profile.indexOf("file-read-metadata")).toBeGreaterThan(profile.indexOf("deny file-read*"));
    expect(profile).toContain('(allow file-read-metadata (literal "/ws"))');
  });
});
