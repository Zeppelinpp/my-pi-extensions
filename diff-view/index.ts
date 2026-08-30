/**
 * Diff View Extension
 *
 * Usage: /diff
 *
 * Shows unstaged changes in a side-by-side diff view popup:
 * - Left pane: file list (j/k to navigate)
 * - Right pane: diff content for selected file
 * - Ctrl+h/l to switch focus between panes
 * - j/k to scroll the focused pane
 * - q to quit
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFileSync } from "node:child_process";

type FocusPane = "list" | "diff";

export function runGit(cwd: string, args: string[], timeout: number): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout,
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024,
  });
}

class DiffViewComponent {
  private files: string[] = [];
  private diffs: Map<string, string> = new Map();
  private selectedIndex = 0;
  private focus: FocusPane = "list";
  private diffScrollOffset = 0;
  private listScrollOffset = 0;
  private cachedWidth = 0;
  private cachedLines: string[] | undefined;
  private version = 0;
  private cachedVersion = -1;
  private contentHeight = 0;
  private leftWidth = 0;
  private rightWidth = 0;

  constructor(
    private tui: { requestRender: () => void },
    private theme: Theme,
    private cwd: string,
    private onClose: () => void,
  ) {
    this.refreshFiles();
  }

  private refreshFiles(): void {
    try {
      const output = runGit(this.cwd, ["diff", "--name-only", "-z"], 5000);
      this.files = output.split("\0").filter(Boolean);
    } catch {
      this.files = [];
    }
    this.selectedIndex = 0;
    this.listScrollOffset = 0;
    this.diffScrollOffset = 0;
    this.diffs.clear();
    this.loadSelectedDiff();
  }

  private loadSelectedDiff(): void {
    if (this.files.length === 0) return;
    const file = this.files[this.selectedIndex];
    if (!file || this.diffs.has(file)) return;
    try {
      const diff = runGit(this.cwd, ["diff", "--", file], 10000);
      this.diffs.set(file, diff);
    } catch {
      this.diffs.set(file, "");
    }
  }

  handleInput(data: string): void {
    if (data === "q" || data === "Q") {
      this.onClose();
      return;
    }

    if (matchesKey(data, "ctrl+h")) {
      this.focus = "list";
      this.version++;
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "ctrl+l")) {
      this.focus = "diff";
      this.version++;
      this.tui.requestRender();
      return;
    }

    if (this.focus === "list") {
      if (matchesKey(data, "j") || matchesKey(data, "down")) {
        if (this.selectedIndex < this.files.length - 1) {
          this.selectedIndex++;
          this.loadSelectedDiff();
          this.adjustListScroll();
          this.diffScrollOffset = 0;
          this.version++;
          this.tui.requestRender();
        }
      } else if (matchesKey(data, "k") || matchesKey(data, "up")) {
        if (this.selectedIndex > 0) {
          this.selectedIndex--;
          this.loadSelectedDiff();
          this.adjustListScroll();
          this.diffScrollOffset = 0;
          this.version++;
          this.tui.requestRender();
        }
      }
    } else {
      const diffLines = this.getCurrentDiffLines();
      const maxScroll = Math.max(0, diffLines.length - this.contentHeight);

      if (matchesKey(data, "j") || matchesKey(data, "down")) {
        if (this.diffScrollOffset < maxScroll) {
          this.diffScrollOffset++;
          this.version++;
          this.tui.requestRender();
        }
      } else if (matchesKey(data, "k") || matchesKey(data, "up")) {
        if (this.diffScrollOffset > 0) {
          this.diffScrollOffset--;
          this.version++;
          this.tui.requestRender();
        }
      } else if (matchesKey(data, "pageDown")) {
        this.diffScrollOffset = Math.min(maxScroll, this.diffScrollOffset + this.contentHeight);
        this.version++;
        this.tui.requestRender();
      } else if (matchesKey(data, "pageUp")) {
        this.diffScrollOffset = Math.max(0, this.diffScrollOffset - this.contentHeight);
        this.version++;
        this.tui.requestRender();
      }
    }
  }

  private getCurrentDiffLines(): string[] {
    if (this.files.length === 0) return ["No unstaged changes"];
    const file = this.files[this.selectedIndex];
    const diff = this.diffs.get(file);
    if (diff === undefined) return ["Loading..."];
    if (diff === "") return ["No diff available"];
    return diff.split("\n");
  }

  private adjustListScroll(): void {
    if (this.selectedIndex < this.listScrollOffset) {
      this.listScrollOffset = this.selectedIndex;
    } else if (this.selectedIndex >= this.listScrollOffset + this.contentHeight) {
      this.listScrollOffset = this.selectedIndex - this.contentHeight + 1;
    }
  }

  render(width: number): string[] {
    const targetHeight = Math.max(8, Math.floor(process.stdout.rows * 0.75));
    this.contentHeight = Math.max(1, targetHeight - 6);
    this.leftWidth = Math.max(16, Math.floor((width - 3) * 0.3));
    this.rightWidth = Math.max(20, width - 3 - this.leftWidth);

    if (this.cachedWidth === width && this.cachedVersion === this.version && this.cachedLines) {
      return this.cachedLines;
    }

    const th = this.theme;
    const lw = this.leftWidth;
    const rw = this.rightWidth;
    const ch = this.contentHeight;
    const lines: string[] = [];

    const border = (s: string) => th.fg("border", s);

    // Top border with pane titles
    const leftTitle = " Files ";
    const rightTitle = " Diff ";
    const topLeft = this.embedTitle("─", leftTitle, lw);
    const topRight = this.embedTitle("─", rightTitle, rw);
    lines.push(border("╭" + topLeft + "┬" + topRight + "╮"));

    // Header row
    const leftHeader = this.padToWidth(this.focus === "list" ? th.fg("accent", " ◄ list ") : "  list  ", lw);
    const rightHeader = this.padToWidth(this.focus === "diff" ? th.fg("accent", " ◄ diff ") : "  diff  ", rw);
    lines.push(border("│") + leftHeader + border("│") + rightHeader + border("│"));

    // Separator
    lines.push(border("├" + "─".repeat(lw) + "┼" + "─".repeat(rw) + "┤"));

    // Content rows
    const diffLines = this.getCurrentDiffLines();
    const visibleFiles = this.files.slice(this.listScrollOffset, this.listScrollOffset + ch);
    const visibleDiffs = diffLines.slice(this.diffScrollOffset, this.diffScrollOffset + ch);

    for (let i = 0; i < ch; i++) {
      let left = "";
      let right = "";

      // Left pane: file list
      if (i < visibleFiles.length) {
        const fileIndex = this.listScrollOffset + i;
        const file = visibleFiles[i]!;
        const isSelected = fileIndex === this.selectedIndex;
        const prefix = isSelected ? (this.focus === "list" ? "▶ " : "● ") : "  ";
        const maxFileLen = lw - visibleWidth(prefix) - 1;
        const truncated = truncateToWidth(file, maxFileLen);
        const raw = prefix + truncated;
        const padded = raw + " ".repeat(Math.max(0, lw - 1 - visibleWidth(raw)));
        const full = " " + padded;

        if (isSelected && this.focus === "list") {
          left = th.bg("selectedBg", th.fg("accent", full));
        } else if (isSelected) {
          left = th.fg("muted", full);
        } else {
          left = full;
        }
      } else {
        left = " ".repeat(lw);
      }

      // Right pane: diff content
      if (i < visibleDiffs.length) {
        const line = visibleDiffs[i]!;
        let styled: string;

        if (line.startsWith("+")) {
          styled = th.fg("toolDiffAdded", truncateToWidth(line, rw - 1));
        } else if (line.startsWith("-")) {
          styled = th.fg("toolDiffRemoved", truncateToWidth(line, rw - 1));
        } else if (line.startsWith("@@")) {
          styled = th.fg("accent", truncateToWidth(line, rw - 1));
        } else if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ") || line.startsWith("Binary files ")) {
          styled = th.fg("dim", truncateToWidth(line, rw - 1));
        } else if (line.startsWith("\\")) {
          // "\ No newline at end of file"
          styled = th.fg("dim", truncateToWidth(line, rw - 1));
        } else {
          styled = th.fg("toolDiffContext", truncateToWidth(line, rw - 1));
        }

        const padded = styled + " ".repeat(Math.max(0, rw - 1 - visibleWidth(styled)));
        right = " " + padded;
      } else {
        right = " ".repeat(rw);
      }

      lines.push(border("│") + left + border("│") + right + border("│"));
    }

    // Bottom separator + hint + border
    lines.push(border("├" + "─".repeat(lw) + "┼" + "─".repeat(rw) + "┤"));

    const hint = " q:quit j/k:scroll ctrl+h/l:focus ";
    const bottomInner = lw + 1 + rw;
    const hintText = truncateToWidth(th.fg("dim", hint), bottomInner);
    const hintPadded = hintText + " ".repeat(Math.max(0, bottomInner - visibleWidth(hintText)));
    lines.push(border("│") + hintPadded + border("│"));
    lines.push(border("╰" + "─".repeat(lw) + "┴" + "─".repeat(rw) + "╯"));

    this.cachedLines = lines;
    this.cachedWidth = width;
    this.cachedVersion = this.version;
    return lines;
  }

  private embedTitle(borderChar: string, title: string, width: number): string {
    const titleVis = visibleWidth(title);
    if (titleVis >= width - 2) {
      return truncateToWidth(title, width);
    }
    const side = width - titleVis;
    const left = Math.floor(side / 2);
    const right = side - left;
    return borderChar.repeat(left) + title + borderChar.repeat(right);
  }

  private padToWidth(text: string, width: number): string {
    const vw = visibleWidth(text);
    if (vw >= width) return truncateToWidth(text, width);
    return text + " ".repeat(width - vw);
  }

  invalidate(): void {
    this.cachedWidth = 0;
    this.cachedVersion = -1;
    this.cachedLines = undefined;
  }
}

export default function(pi: ExtensionAPI) {
  pi.registerCommand("diff", {
    description: "Show unstaged changes in a diff view",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) ctx.ui.notify("Diff view requires interactive mode", "error");
        return;
      }

      // Verify git repo
      try {
        runGit(ctx.cwd, ["rev-parse", "--git-dir"], 3000);
      } catch (error: any) {
        ctx.ui.notify(
          error?.code === "ENOENT" ? "Git executable not found on PATH" : "Not a git repository",
          "error",
        );
        return;
      }

      await ctx.ui.custom<void>((tui, theme, _kb, done) => {
        return new DiffViewComponent(tui, theme, ctx.cwd, done);
      }, {
        overlay: true,
        overlayOptions: {
          anchor: "center",
          width: "80%",
          maxHeight: "75%",
        },
      });
    },
  });
}
