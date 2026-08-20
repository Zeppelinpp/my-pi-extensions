import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { resolve, relative } from "node:path";

type Mode = "accept" | "ask" | "bypass";

const MODES: Mode[] = ["ask", "accept", "bypass"];

const MODE_META: Record<
  Mode,
  { label: string; color: string; desc: string }
> = {
  accept: {
    label: "Accept",
    color: "success",
    desc: "Allow all edits in cwd",
  },
  ask: {
    label: "Ask",
    color: "warning",
    desc: "Confirm write/edit/bash",
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
  const trimmed = command.trim();
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
  const seg = command.match(/\brm\b[^;|&]*/);
  if (!seg) return false;
  const s = seg[0];
  const hasRecursive = /\s-[^\s]*r/.test(s);
  const hasForce = /\s-[^\s]*f/.test(s);
  return hasRecursive && hasForce;
}

function isInCwd(absPath: string, cwd: string): boolean {
  const rel = relative(cwd, absPath);
  return !rel.startsWith("..") && !rel.startsWith("/");
}

function getFilePath(input: any, cwd: string): string | null {
  const p = input?.path;
  if (!p || typeof p !== "string") return null;
  return resolve(cwd, p);
}

export default function (pi: ExtensionAPI) {
  let mode: Mode = "accept";
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

    // ── Bypass mode: allow everything, including outside cwd ──
    if (mode === "bypass") {
      return;
    }

    // ── Accept edits mode ──
    if (mode === "accept") {
      if (event.toolName === "edit" || event.toolName === "write") {
        const absPath = getFilePath(event.input, cwd);
        if (absPath && !isInCwd(absPath, cwd)) {
          const ok = await ctx.ui.confirm(
            "Accept edits: outside cwd",
            `Allow ${event.toolName} on file outside working dir?\n${absPath}`
          );
          if (!ok)
            return {
              block: true,
              reason: "Blocked by permission mode (outside cwd)",
            };
        }
        return;
      }

      if (event.toolName === "bash") {
        const cmd = event.input.command;
        if (typeof cmd === "string" && isRmRf(cmd)) {
          const ok = await ctx.ui.confirm(
            "Accept: recursive delete",
            `Allow recursive delete?\n${cmd}`
          );
          if (!ok)
            return { block: true, reason: "Blocked by user (rm -rf)" };
        }
        return;
      }
      return;
    }

    // ── Ask mode ──
    if (mode === "ask") {
      if (event.toolName === "write" || event.toolName === "edit") {
        const absPath = getFilePath(event.input, cwd);
        const location = absPath
          ? isInCwd(absPath, cwd)
            ? "in cwd"
            : "outside cwd"
          : "unknown location";
        const ok = await ctx.ui.confirm(
          `Ask: ${event.toolName}`,
          `Allow ${event.toolName}?\n${absPath || ""}\n(${location})`
        );
        if (!ok)
          return { block: true, reason: "Blocked by user (ask mode)" };
        return;
      }

      if (event.toolName === "bash") {
        const cmd = event.input.command as string;
        if (isReadOnlyBash(cmd)) return;

        const ok = await ctx.ui.confirm("Ask: bash", `Allow bash command?\n${cmd}`);
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
