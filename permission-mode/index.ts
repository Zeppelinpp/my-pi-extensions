import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isAbsolute, relative, resolve, sep } from "node:path";

type Mode = "accept" | "ask" | "bypass";

const MODES: Mode[] = ["ask", "accept", "bypass"];

const MODE_META: Record<
  Mode,
  { label: string; color: string; desc: string }
> = {
  accept: {
    label: "Accept",
    color: "success",
    desc: "Allow edits in cwd, writes anywhere",
  },
  ask: {
    label: "Ask",
    color: "warning",
    desc: "Confirm write/edit/shell",
  },
  bypass: {
    label: "Bypass",
    color: "error",
    desc: "Allow everything",
  },
};

// Bash commands considered read-only — allowed without confirmation in "ask" mode
const READONLY_BASH_PREFIXES = [
  "ls", "ll", "la", "lt", "l",
  "grep", "rg", "find", "cat", "head", "tail", "less", "more", "wc",
  "pwd", "echo", "printf", "ps", "whoami", "uname", "date",
  "env", "printenv", "which", "whereis", "history",
  "du", "df", "free", "uptime", "hostname", "id", "groups",
  "stat", "file", "type", "man", "help", "tldr",
  "tree", "fd", "fdfind", "cheat",
  "zoxide query", "fzf", "selecta", "peco", "sk", "broot",
];

// Dangerous substrings that always trigger confirmation in "ask" mode
const DANGEROUS_PATTERNS = [
  ">", "| tee", "sed -i", "perl -i",
  "rm ", "mv ", "cp ", "chmod ", "chown ", "mkfs", "dd ",
  "npm install", "npm uninstall", "npm ci",
  "pip install", "pip uninstall",
  "yarn ", "pnpm install", "pnpm remove",
  "cargo build", "make", "cmake",
  "docker run", "docker rm", "docker rmi", "docker-compose up",
  "kubectl apply", "kubectl delete", "kubectl create",
  "terraform apply", "terraform destroy",
  "aws ", "gh pr create",
  "git push", "git commit", "git merge", "git rebase",
  "git checkout", "git reset", "git clean", "git add ",
];

function isReadOnlyBash(command: string): boolean {
  const trimmed = command.trim().toLowerCase();
  // Be conservative: prefix checks cannot safely classify chained commands,
  // substitutions, pipelines, or redirects as read-only on any shell.
  if (/[\r\n;&|<>`]/.test(trimmed) || /\$\s*\(/.test(trimmed)) return false;
  for (const p of DANGEROUS_PATTERNS) {
    if (trimmed.includes(p)) return false;
  }
  for (const prefix of READONLY_BASH_PREFIXES) {
    if (trimmed.startsWith(prefix + " ") || trimmed === prefix) {
      return true;
    }
  }
  return false;
}

/**
 * Heuristic: `rm` with both recursive and force flags in the same command
 * segment (covers `rm -rf`, `rm -fr`, `rm -r -f`, `rm --recursive --force`,
 * `sudo rm -rf`). Safe-side: quoted strings containing "rm -rf" also match.
 */
function isRmRf(command: string): boolean {
  for (const match of command.matchAll(/\brm\b[^;|&]*/gi)) {
    const segment = match[0];
    const hasRecursive = /(?:\s-[^\s]*r|\s--recursive\b)/i.test(segment);
    const hasForce = /(?:\s-[^\s]*f|\s--force\b)/i.test(segment);
    if (hasRecursive && hasForce) return true;
  }
  return false;
}

function isPowerShellRecursiveDelete(command: string): boolean {
  const segments = command.split(/[;\r\n|&]+/);
  for (const segment of segments) {
    if (!/(?:^|\s)(?:remove-item|rm|ri|del|erase|rmdir|rd)(?:\s|$)/i.test(segment)) continue;
    const hasRecursive = /(?:\s-(?:recurse|r)(?:\s|$)|\s\/(?:s)(?:\s|$))/i.test(segment);
    const hasForce = /(?:\s-(?:force|fo|f)(?:\s|$)|\s\/(?:q)(?:\s|$))/i.test(segment);
    if (hasRecursive && hasForce) return true;
  }
  return false;
}

function isInCwd(absPath: string, cwd: string): boolean {
  const rel = relative(cwd, absPath);
  return (
    rel === "" ||
    (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
  );
}

function getFilePath(input: any, cwd: string): string | null {
  const p = input?.path;
  if (!p || typeof p !== "string") return null;
  return resolve(cwd, p);
}

export default function (pi: ExtensionAPI) {
  let mode: Mode = "bypass";
  let footerEnabled = true;

  function persistMode() {
    pi.appendEntry("permission-mode", { mode });
  }

  function updateStatus(ctx: any) {
    if (!footerEnabled) {
      ctx.ui.setStatus("permission-mode", undefined);
      return;
    }
    const m = MODE_META[mode];
    ctx.ui.setStatus(
      "permission-mode",
      ctx.ui.theme.fg(m.color as any, ctx.ui.theme.bold(`[${m.label}]`))
    );
  }

  function cycleMode(ctx: any) {
    const idx = MODES.indexOf(mode);
    mode = MODES[(idx + 1) % MODES.length];
    persistMode();
    updateStatus(ctx);
  }

  // ── Shortcut ──
  pi.registerShortcut("shift+tab", {
    description: "Cycle permission mode (Accept / Ask / Bypass)",
    handler: async (ctx) => cycleMode(ctx),
  });

  // ── Commands ──
  pi.registerCommand("mode", {
    description: "Show or set permission mode",
    handler: async (args, ctx) => {
      const arg = args?.trim().toLowerCase();
      if (arg === "accept" || arg === "ask" || arg === "bypass") {
        mode = arg as Mode;
        persistMode();
        updateStatus(ctx);
        return;
      }
      if (arg === "off" || arg === "toggle-footer") {
        footerEnabled = !footerEnabled;
        updateStatus(ctx);
        return;
      }
    },
  });

  // ── Tool interception ──
  pi.on("tool_call", async (event, ctx) => {
    const cwd = ctx.cwd;
    const toolName = event.toolName.toLowerCase();

    // ── Bypass mode: allow everything, including outside cwd ──
    if (mode === "bypass") {
      return;
    }

    // ── Accept mode: write anywhere, edit outside cwd still asks ──
    if (mode === "accept") {
      if (toolName === "write") {
        // writes are accepted regardless of location (inside or outside cwd)
        return;
      }

      if (toolName === "edit") {
        const absPath = getFilePath(event.input, cwd);
        if (absPath && !isInCwd(absPath, cwd)) {
          const ok = await ctx.ui.confirm(
            "Accept: edit outside cwd",
            `Allow edit on file outside working dir?\n${absPath}`
          );
          if (!ok)
            return {
              block: true,
              reason: "Blocked by permission mode (outside cwd)",
            };
        }
        return;
      }

      if (toolName === "bash" || toolName === "powershell") {
        const cmd = event.input.command;
        const isRecursiveDelete =
          typeof cmd === "string" &&
          (toolName === "bash" ? isRmRf(cmd) : isPowerShellRecursiveDelete(cmd));
        if (isRecursiveDelete) {
          const ok = await ctx.ui.confirm(
            "Accept: recursive delete",
            `Allow recursive delete?\n${cmd}`
          );
          if (!ok) {
            return {
              block: true,
              reason:
                toolName === "bash"
                  ? "Blocked by user (rm -rf)"
                  : "Blocked by user (recursive delete)",
            };
          }
        }
        return;
      }
      return;
    }

    // ── Ask mode ──
    if (mode === "ask") {
      if (toolName === "write" || toolName === "edit") {
        const absPath = getFilePath(event.input, cwd);
        const location = absPath
          ? isInCwd(absPath, cwd)
            ? "in cwd"
            : "outside cwd"
          : "unknown location";
        const ok = await ctx.ui.confirm(
          `Ask: ${toolName}`,
          `Allow ${toolName}?\n${absPath || ""}\n(${location})`
        );
        if (!ok)
          return { block: true, reason: "Blocked by user (ask mode)" };
        return;
      }

      if (toolName === "bash" || toolName === "powershell") {
        const cmd = event.input.command as string;
        if (toolName === "bash" && isReadOnlyBash(cmd)) return;

        const ok = await ctx.ui.confirm(
          `Ask: ${toolName}`,
          `Allow ${toolName} command?\n${cmd}`,
        );
        if (!ok)
          return { block: true, reason: "Blocked by user (ask mode)" };
        return;
      }

      return;
    }
  });

  // ── Restore mode on session start ──
  pi.on("session_start", async (_event, ctx) => {
    const entries = ctx.sessionManager.getEntries();
    const lastModeEntry = entries
      .filter(
        (e: any) =>
          e.type === "custom" && e.customType === "permission-mode"
      )
      .pop() as { data?: { mode: Mode } } | undefined;

    if (lastModeEntry?.data?.mode) {
      mode = lastModeEntry.data.mode;
    }

    updateStatus(ctx);
  });
}
