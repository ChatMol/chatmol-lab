/**
 * Bash command policy for "auto" tool review (Codex / Claude Code style).
 *
 * Every bash command is classified before it runs:
 *   safe    — read-only / informational; runs immediately.
 *   review  — anything else (python scripts, package installs, downloads,
 *             writes inside the workspace); a fast model reviews it against
 *             the task and the workspace boundary, and only pauses for the
 *             user when it denies or is unsure.
 *   confirm — destructive or out-of-scope operations; always asks the user.
 *
 * Design rule: a `confirm` verdict interrupts the user and bypasses the model
 * reviewer, so it must rest on STRUCTURAL evidence — the command word of a
 * parsed pipeline segment, or the target of a redirect / copy — never on a
 * substring found somewhere in the string. Words inside quotes, heredoc
 * bodies, comments or script source are data, not commands. Anything the
 * static parser cannot vouch for goes to the reviewer instead.
 *
 * The hard sandbox (validateBashCommand in tools.ts) still runs first over the
 * raw string and is never bypassed by this policy.
 */

export type BashPolicyLevel = "safe" | "review" | "confirm";

export interface BashPolicyDecision {
  level: BashPolicyLevel;
  reason: string;
  /** Top-level commands seen in the pipeline (for logging / UI). */
  commands: string[];
  /** The pipeline segment that produced a `confirm` verdict, for the UI. */
  evidence?: string;
}

export interface BashPolicyOptions {
  /**
   * True when an OS file sandbox confines the command to the workspace. Then
   * the static rules about file effects outside the workspace step aside: the
   * sandbox denies such writes mechanically and the model can ask for wider
   * access with a justification (dsh / Codex style), which is a better prompt
   * than a guess made from the command text. Rules about things a file
   * sandbox cannot see (privileges, processes, network, services) still ask.
   */
  fileEffectsSandboxed?: boolean;
}

/** Confirm reasons that an enforcing file sandbox makes redundant. */
const FILE_EFFECT_REASONS = new Set([
  "delete outside the workspace",
  "writes outside the workspace",
  "moves or copies into user/system directories",
]);

/** Commands that cannot change state (arguments still checked below). */
const SAFE_COMMANDS = new Set([
  "ls", "ll", "cat", "head", "tail", "less", "more", "wc", "grep", "egrep", "fgrep", "rg", "ag",
  "echo", "printf", "pwd", "which", "whereis", "type", "file", "stat", "du", "df", "date", "uname",
  "basename", "dirname", "realpath", "readlink", "sort", "uniq", "cut", "tr", "diff", "cmp", "comm",
  "md5sum", "sha1sum", "sha256sum", "shasum", "tree", "column", "nl", "tac", "rev", "paste", "join",
  "true", "false", "test", "[", "expr", "seq", "yes", "hostname", "whoami", "id", "nproc", "arch",
  "jq", "yq", "xxd", "hexdump", "strings", "od", "bc", "cd", "export",
]);

/** Commands that are safe only with read-only subcommands / flags. */
const SAFE_SUBCOMMANDS: Record<string, Set<string>> = {
  git: new Set(["status", "log", "diff", "show", "branch", "remote", "rev-parse", "ls-files", "blame", "describe", "tag"]),
  pip: new Set(["list", "show", "freeze", "check", "--version", "-V"]),
  pip3: new Set(["list", "show", "freeze", "check", "--version", "-V"]),
  conda: new Set(["list", "info", "env", "search", "--version", "-V"]),
  mamba: new Set(["list", "info", "env", "search", "--version", "-V"]),
  micromamba: new Set(["list", "info", "env", "search", "--version", "-V"]),
  npm: new Set(["ls", "list", "view", "--version", "-v"]),
  docker: new Set(["ps", "images", "--version", "version"]),
  python: new Set(["--version", "-V"]),
  python3: new Set(["--version", "-V"]),
  node: new Set(["--version", "-v"]),
  "wemol-cli": new Set(["--version", "docs", "module", "flow", "job", "account"]),
};

/** Shells: their heredoc bodies and -c payloads really are commands. */
const SHELL_NAMES = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);

/**
 * Interpreters whose `-c` / `-e` argument is SOURCE CODE in another language.
 * Their payload is lifted out of the shell text so the reviewer still sees it
 * while the shell parser does not mistake identifiers for commands.
 */
const SCRIPT_INTERPRETER = /\b(python(?:2|3)?(?:\.\d+)?|ipython|perl|ruby|node|Rscript|julia|lua)((?:\s+-[A-Za-z]+)*)\s+(-c|-e)\s+('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;
const SHELL_PAYLOAD = /\b(bash|sh|zsh|dash|ksh)((?:\s+-[A-Za-z]+)*)\s+-c\s+('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;

const HEREDOC_START = /<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\1/;

/** Wrappers that run the command that follows them. */
const COMMAND_WRAPPERS = new Set(["time", "nohup", "command", "builtin", "exec", "xargs", "nice", "ionice", "env", "watch", "stdbuf", "caffeinate"]);

export interface ShellTextParts {
  /** The command with embedded non-shell script source removed. */
  shellText: string;
  /** The script bodies that were lifted out, in order. */
  scriptBodies: string[];
}

function unquotePayload(payload: string): string {
  const inner = payload.slice(1, -1);
  return payload.startsWith('"') ? inner.replace(/\\(["\\$`])/g, "$1") : inner;
}

/**
 * Separate shell text from embedded data.
 *
 * A heredoc body is the stdin of one command: for `python`, `cat > x.py`,
 * `tee`, `Rscript` it is data, and only for a shell (`bash <<EOF`) is it more
 * shell. Likewise `python -c '...'` carries Python, while `sh -c '...'`
 * carries shell that must be inspected in place.
 *
 * Lifted bodies are still passed to the model reviewer and to the hard
 * sandbox in full, so nothing is trusted just because it sits in a heredoc.
 */
export function extractShellText(command: string): ShellTextParts {
  const scriptBodies: string[] = [];
  const lines = command.split("\n");
  const kept: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const heredoc = HEREDOC_START.exec(line);
    if (heredoc) {
      const delimiter = heredoc[2];
      const before = line.slice(0, heredoc.index);
      const after = line.slice(heredoc.index + heredoc[0].length);
      const consumer = lastSegmentCommand(before);
      const body: string[] = [];
      i += 1;
      while (i < lines.length && lines[i].trim() !== delimiter) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1; // consume the closing delimiter
      if (SHELL_NAMES.has(consumer)) {
        kept.push(`${before} ${after}`);
        kept.push(...body);
      } else {
        kept.push(`${before} ${after}`);
        scriptBodies.push(body.join("\n"));
      }
      continue;
    }
    kept.push(line);
    i += 1;
  }

  const shellText = kept
    .join("\n")
    .replace(SCRIPT_INTERPRETER, (_match, interpreter: string, flags: string, cFlag: string, payload: string) => {
      scriptBodies.push(payload.slice(1, -1));
      return `${interpreter}${flags || ""} ${cFlag} ''`;
    })
    .replace(SHELL_PAYLOAD, (_match, _shell: string, _flags: string, payload: string) => `\n${unquotePayload(payload)}\n`);

  return { shellText, scriptBodies };
}

function lastSegmentCommand(shellPrefix: string): string {
  const segments = splitBashPipeline(shellPrefix);
  const last = segments[segments.length - 1] || "";
  return unwrapCommand(last).cmd;
}

function stripQuotedStrings(command: string): string {
  return command
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/** Split a shell line into top-level simple commands (best-effort). */
export function splitBashPipeline(command: string): string[] {
  const stripped = stripQuotedStrings(command.replace(/\\\n/g, " "));
  return stripped
    .split(/\n|;|&&|\|\||\|(?!\|)|\(|\)|\{|\}/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

interface ParsedSegment {
  cmd: string;
  rest: string[];
}

/** First command word of a segment, skipping env assignments and wrappers. */
function firstWord(segment: string): ParsedSegment {
  const tokens = segment.split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i += 1;
  while (i < tokens.length && ["time", "nohup", "command", "builtin", "exec"].includes(tokens[i])) i += 1;
  const cmd = (tokens[i] || "").replace(/^.*\//, "");
  return { cmd, rest: tokens.slice(i + 1) };
}

/**
 * Like firstWord, but also sees through wrappers that execute the command
 * after them (`xargs rm -rf`, `nohup pkill`, `timeout 10 nc`, `env X=1 sudo`).
 */
function unwrapCommand(segment: string): ParsedSegment {
  let parsed = firstWord(segment);
  for (let depth = 0; depth < 4; depth += 1) {
    if (parsed.cmd === "timeout" || parsed.cmd === "xargs" || parsed.cmd === "nice" || parsed.cmd === "ionice" || parsed.cmd === "stdbuf" || parsed.cmd === "watch") {
      // Skip the wrapper's own options and numeric/duration arguments.
      let j = 0;
      while (j < parsed.rest.length && (parsed.rest[j].startsWith("-") || /^[0-9]+[smhd]?$/.test(parsed.rest[j]))) j += 1;
      if (j >= parsed.rest.length) return parsed;
      parsed = firstWord(parsed.rest.slice(j).join(" "));
      continue;
    }
    if (COMMAND_WRAPPERS.has(parsed.cmd)) {
      let j = 0;
      while (j < parsed.rest.length && parsed.rest[j].startsWith("-")) j += 1;
      if (j >= parsed.rest.length) return parsed;
      parsed = firstWord(parsed.rest.slice(j).join(" "));
      continue;
    }
    return parsed;
  }
  return parsed;
}

const OUTSIDE_WORKSPACE = /^(\.\.\/|\.\.$|~(\/|$)|\$HOME(\/|$)|\$\{HOME\}|\/etc\/|\/usr\/|\/Users\/|\/home\/|\/root(\/|$)|\/var\/|\/opt\/|\/private\/)/;

function isOutsideWorkspace(token: string): boolean {
  return OUTSIDE_WORKSPACE.test(token);
}

function flagsOf(rest: string[]): string[] {
  return rest.filter((t) => t.startsWith("-"));
}

function positionalsOf(rest: string[]): string[] {
  return rest.filter((t) => !t.startsWith("-"));
}

/** Redirect targets in a segment: `> file`, `>> file`, `>file`, `2>file`. */
function redirectTargets(segment: string): string[] {
  const targets: string[] = [];
  const re = /(?:^|\s)(?:[0-9]?&?>{1,2}|&>)\s*([^\s;|&]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(segment)) !== null) {
    if (match[1] === "/dev/null") continue;
    targets.push(match[1]);
  }
  return targets;
}

function credentialToken(token: string): boolean {
  return /(^|\/)\.(bash_history|zsh_history|ssh|aws|gnupg)(\/|$)|\.config\/gh(\/|$)|\bkeychain\b/.test(token);
}

/**
 * Structural rules that make a segment require explicit user confirmation.
 * Each rule looks at the parsed command word and its arguments only.
 */
function confirmReasonForSegment(segment: string): string | null {
  const { cmd, rest } = unwrapCommand(segment);
  if (!cmd) return null;
  const flags = flagsOf(rest);
  const positionals = positionalsOf(rest);

  switch (cmd) {
    case "sudo":
    case "doas":
    case "su":
      return "privilege escalation";
    case "rm":
      if (flags.some((f) => /^-[a-zA-Z]*[rR]/.test(f) || f === "--recursive")) return "recursive delete";
      if (positionals.some(isOutsideWorkspace)) return "delete outside the workspace";
      break;
    case "rmdir":
    case "shred":
    case "wipe":
      if (positionals.some(isOutsideWorkspace)) return "delete outside the workspace";
      if (cmd !== "rmdir") return "delete operation";
      break;
    case "git": {
      const sub = positionals[0] || "";
      if (sub === "push" && flags.some((f) => f === "--force" || f === "-f" || /^-[a-zA-Z]*f/.test(f))) return "irreversible git operation";
      if (sub === "reset" && flags.includes("--hard")) return "irreversible git operation";
      if (sub === "clean" && flags.some((f) => /^-[a-zA-Z]*f/.test(f))) return "irreversible git operation";
      if (sub === "checkout" && rest.includes("--")) return "irreversible git operation";
      if (sub === "branch" && flags.includes("-D")) return "irreversible git operation";
      break;
    }
    case "kill":
    case "pkill":
    case "killall":
      return "terminates processes";
    case "chmod":
      if (flags.includes("-R") || positionals.some((p) => /^[0-7]*7[0-7]*7$/.test(p))) return "broad permission change";
      break;
    case "chown":
      if (flags.includes("-R")) return "broad permission change";
      break;
    case "crontab":
    case "launchctl":
    case "systemctl":
    case "schtasks":
      return "changes system services or persistent settings";
    case "defaults":
      if (positionals[0] === "write") return "changes system services or persistent settings";
      break;
    case "reg":
      if (positionals[0] === "add") return "changes system services or persistent settings";
      break;
    case "ssh":
    case "scp":
    case "rsync":
      if (rest.some((t) => t.includes("@"))) return "remote host access";
      break;
    case "nc":
    case "ncat":
    case "netcat":
    case "telnet":
      return "raw network connection";
    case "osascript":
    case "xdg-open":
      return "controls other applications";
    case "open":
      if (flags.includes("-a")) return "controls other applications";
      break;
    case "pip":
    case "pip3":
    case "conda":
    case "mamba":
    case "micromamba": {
      const sub = positionals[0] || "";
      if (sub === "uninstall" || sub === "remove" || (sub === "env" && positionals[1] === "remove")) return "removes packages or environments";
      break;
    }
    case "curl":
    case "wget":
      if (flags.some((f) => /^(-d|--data|--data-\w+|-F|--form|-T|--upload-file)$/.test(f))) return "uploads data to a remote host";
      break;
    case "history":
      return "touches credentials or shell history";
    case "security":
      if (positionals.some((p) => p.startsWith("find-"))) return "touches credentials or shell history";
      break;
    case "mv":
    case "cp": {
      const destination = positionals[positionals.length - 1];
      if (destination && isOutsideWorkspace(destination)) return "moves or copies into user/system directories";
      break;
    }
    default:
      break;
  }

  if (rest.some(credentialToken)) return "touches credentials or shell history";
  if (redirectTargets(segment).some(isOutsideWorkspace)) return "writes outside the workspace";
  return null;
}

function segmentIsSafe(segment: string): boolean {
  const { cmd, rest } = firstWord(segment);
  if (!cmd) return true;
  // Output redirection writes a file: not read-only.
  if (redirectTargets(segment).length > 0) return false;
  if (cmd === "find") {
    return !rest.some((t) => t === "-delete" || t === "-exec" || t === "-execdir" || t === "-ok" || t === "-fprint");
  }
  if (cmd === "sed") return !rest.some((t) => t === "-i" || t.startsWith("-i") || /^-[a-zA-Z]*i/.test(t));
  if (cmd === "awk" || cmd === "gawk") return !/system\s*\(|>\s*"/.test(segment);
  if (cmd === "xargs") return false;
  if (SAFE_COMMANDS.has(cmd)) return true;
  const subs = SAFE_SUBCOMMANDS[cmd];
  if (subs) {
    const sub = rest.find((t) => !t.startsWith("-")) || rest[0] || "";
    return subs.has(sub) || subs.has(rest[0] || "");
  }
  return false;
}

/**
 * Absolute paths into the session workspace are workspace-local. The executor
 * rewrites them to relative paths anyway; the policy must see the same thing,
 * or `/Users/<you>/.../workspace/<session>/x` reads as "outside the workspace".
 */
function relativizeWorkspacePaths(command: string, sessionWorkspace?: string): string {
  if (!sessionWorkspace) return command;
  const root = sessionWorkspace.replace(/[\\/]+$/, "");
  if (!root) return command;
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return command
    .replace(new RegExp(`${escaped}[\\\\/]`, "g"), "./")
    .replace(new RegExp(`${escaped}(?=[\\s;|&"')\`]|$)`, "g"), ".");
}

export function classifyBashCommand(command: string, sessionWorkspace?: string, options: BashPolicyOptions = {}): BashPolicyDecision {
  const normalized = relativizeWorkspacePaths(command.replace(/\\\n/g, " ").trim(), sessionWorkspace);
  const { shellText, scriptBodies } = extractShellText(normalized);
  const segments = splitBashPipeline(shellText);
  const commands = segments.map((s) => firstWord(s).cmd).filter(Boolean);

  let sandboxedFileEffect = false;
  for (const segment of segments) {
    const reason = confirmReasonForSegment(segment);
    if (!reason) continue;
    if (options.fileEffectsSandboxed && FILE_EFFECT_REASONS.has(reason)) {
      sandboxedFileEffect = true;
      continue;
    }
    return { level: "confirm", reason, commands, evidence: segment };
  }

  // A download piped straight into a shell: the pipe itself is the evidence.
  const pipedIntoShell = /\b(curl|wget)\b[^|;&\n]*\|\s*(?:sudo\s+)?(bash|sh|zsh|dash|ksh)\b/.exec(shellText);
  if (pipedIntoShell) {
    return { level: "confirm", reason: "pipes a download into a shell", commands, evidence: pipedIntoShell[0].trim() };
  }

  // A file effect outside the workspace is left to the sandbox to deny.
  if (sandboxedFileEffect) {
    return { level: "review", reason: "touches paths outside the workspace; the file sandbox decides", commands };
  }

  // An inline script is never "read-only": the reviewer must see it.
  if (scriptBodies.length > 0) {
    return { level: "review", reason: "runs an inline script", commands };
  }

  if (segments.length > 0 && segments.every(segmentIsSafe)) {
    return { level: "safe", reason: "read-only command", commands };
  }

  return { level: "review", reason: "may change files, environment, or fetch data", commands };
}
