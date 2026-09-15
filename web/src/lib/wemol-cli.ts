import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import type { WemolAccountStatus } from "./settings";

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

const IS_WIN = process.platform === "win32";
const WEMOL_CLI_NAME = IS_WIN ? "wemol-cli.exe" : "wemol-cli";

export function resolveWemolCli(): string {
  const candidates = [
    process.env.CHATMOL_WEMOL_CLI,
    IS_WIN ? undefined : "/root/.wemol/bin/wemol-cli",
    WEMOL_CLI_NAME,
  ].filter(Boolean) as string[];

  return candidates.find((candidate) => {
    return !path.isAbsolute(candidate) || fs.existsSync(candidate);
  }) || WEMOL_CLI_NAME;
}

export function getWemolCliEnv(wemolBin = resolveWemolCli()): NodeJS.ProcessEnv {
  const wemolBinDir = path.isAbsolute(wemolBin) ? path.dirname(wemolBin) : "";
  const extraDirs = IS_WIN ? [] : ["/root/.wemol/bin"];
  return {
    ...process.env,
    PATH: [wemolBinDir, ...extraDirs, process.env.PATH || ""].filter(Boolean).join(path.delimiter),
    HOME: process.env.HOME || process.env.USERPROFILE || (IS_WIN ? "C:\\" : "/root"),
    LANG: process.env.LANG || "en_US.UTF-8",
    TMPDIR: process.env.TMPDIR || process.env.TEMP || (IS_WIN ? "C:\\Windows\\Temp" : "/tmp"),
  };
}

export function runWemolCli(
  args: string[],
  options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<CommandResult> {
  const wemolBin = resolveWemolCli();
  const env = options.env || getWemolCliEnv(wemolBin);
  return new Promise((resolve) => {
    const proc = spawn(wemolBin, args, {
      cwd: options.cwd || process.cwd(),
      env,
    });
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
    }, options.timeoutMs || 15000);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    proc.on("close", (code: number | null) => {
      clearTimeout(timer);
      resolve({ code: code ?? 0, stdout, stderr });
    });
    proc.on("error", (e: Error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout: "", stderr: e.message });
    });
  });
}

function cleanOutput(text: string, maxLength = 2000): string {
  return text.replace(/\r/g, "").trim().slice(0, maxLength);
}

function summarizeFailure(result: CommandResult): string {
  return cleanOutput(result.stderr || result.stdout || "wemol-cli command failed", 800);
}

export async function loginAndVerifyWemolAccount(
  username: string,
  password: string,
  cwd = process.cwd()
): Promise<WemolAccountStatus> {
  const checkedAt = new Date().toISOString();
  const version = await runWemolCli(["--version"], { cwd, timeoutMs: 5000 });
  const cliVersion = version.code === 0 ? cleanOutput(version.stdout || version.stderr, 200) : undefined;

  const login = await runWemolCli(
    ["login", "--username", username, "--password", password],
    { cwd, timeoutMs: 20000 }
  );
  const loginText = `${login.stdout}\n${login.stderr}`;
  if (login.code !== 0 && !/already/i.test(loginText)) {
    return {
      state: "error",
      checkedAt,
      username,
      cliVersion,
      message: `Login failed: ${summarizeFailure(login)}`,
    };
  }

  const account = await runWemolCli(["account"], { cwd, timeoutMs: 15000 });
  const accountOutput = cleanOutput(account.stdout || account.stderr);
  if (account.code !== 0) {
    return {
      state: "error",
      checkedAt,
      username,
      cliVersion,
      message: `Login completed, but account verification failed: ${summarizeFailure(account)}`,
      accountOutput,
    };
  }

  return {
    state: "connected",
    checkedAt,
    username,
    cliVersion,
    message: "WeMol account verified.",
    accountOutput,
  };
}
