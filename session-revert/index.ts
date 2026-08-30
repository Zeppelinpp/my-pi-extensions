import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  matchesKey,
  Key,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type MarkdownTheme,
  type TUI,
  type Theme,
} from "@earendil-works/pi-tui";
import { relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  buildTreeNodes,
  computeFilesToRevert,
  type ChangeRecord,
  type FileSnapshot,
  type TreeNode,
} from "./core.js";
import {
  deleteFileAndCleanDirs,
  loadChanges,
  loadRedoStack,
  isPathWithin,
  popRedo,
  pushRedo,
  restoreSnapshotFile,
  saveChange,
  snapshotFile,
  snapshotForRedo,
  type RedoEntry,
} from "./storage.js";

/** Pseudo-entry id for the "Undo last revert" row injected at the top of the list. */
const REDO_ENTRY_ID = "__redo__";

// -- Width helpers --

/** Pad or truncate a string to exactly `targetWidth` display columns. */
function padToWidth(s: string, targetWidth: number): string {
  const vw = visibleWidth(s);
  if (vw < targetWidth) return s + " ".repeat(targetWidth - vw);
  if (vw > targetWidth) return truncateToWidth(s, targetWidth);
  return s;
}

// -- Utilities --

function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");
}

function sanitize(text: string): string {
  return text.replace(/\t/g, "    ");
}

function wrapLines(text: string, width: number): string[] {
  if (!text) return [];
  const lines: string[] = [];
  for (const para of text.split("\n")) {
    if (!para) {
      lines.push("");
      continue;
    }
    lines.push(...wrapTextWithAnsi(sanitize(para), width));
  }
  return lines;
}

// -- Preview builder --

function buildPreviewLines(node: TreeNode, width: number, theme: Theme, mdTheme: MarkdownTheme): string[] {
  const { entry } = node;
  const out: string[] = [];
  const push = (s: string, color?: ThemeColor) => {
    const styled = color ? theme.fg(color, s) : s;
    out.push(...wrapLines(styled, width));
  };

  if (entry.type === "message") {
    const msg = entry.message;

    if (msg.role === "user") {
      push("User", "accent");
      push("-".repeat(Math.min(24, width)), "dim");
      const text = extractText(msg.content);
      for (const line of wrapLines(sanitize(text), width)) out.push(line);
    }
    else if (msg.role === "assistant") {
      push("Assistant", "accent");
      push("-".repeat(Math.min(24, width)), "dim");

      const text = extractText(msg.content);
      if (text) {
        const md = new Markdown(sanitize(text), 0, 0, mdTheme);
        out.push(...md.render(width));
      }
    }
    else if (msg.role === "toolResult") {
      push(`Tool Result: ${msg.toolName}`, msg.isError ? "error" : "success");
      push("-".repeat(Math.min(24, width)), "dim");
      const text = extractText(msg.content);
      for (const line of wrapLines(sanitize(text), width)) out.push(line);
      if (msg.isError) {
        out.push("");
        out.push(theme.fg("error", theme.bold("Error")));
      }
    }
    else if (msg.role === "bashExecution") {
      push("Bash Execution", "bashMode");
      push("-".repeat(Math.min(24, width)), "dim");
      if (msg.command) {
        for (const line of wrapLines(sanitize(msg.command), width)) out.push(line);
      }
      if (msg.output) {
        out.push("");
        const outLines = wrapLines(sanitize(msg.output), width);
        for (const line of outLines.slice(-10)) out.push(theme.fg("muted", line));
      }
    }
    else {
      push(msg.role, "text");
    }
  }
  else if (entry.type === "tool_call") {
    push(`${entry.toolName}`, "toolTitle");
    push("-".repeat(Math.min(24, width)), "dim");
    if (entry.path) {
      out.push(theme.fg("text", `Path: ${entry.path}`));
    }
    out.push("");
    out.push(theme.fg("muted", "Revert to the state before this tool call."));
  }
  else if (entry.type === "redo") {
    const redo: RedoEntry = entry.redo;
    push("Undo last revert", "warning");
    push("-".repeat(Math.min(24, width)), "dim");
    const time = new Date(redo.createdAt).toLocaleTimeString();
    out.push(theme.fg("muted", `Reverted to [${redo.targetId}] at ${time}`));
    out.push("");
    if (redo.files.length === 0) {
      out.push(theme.fg("muted", "Conversation only — no file changes."));
    } else {
      out.push(theme.fg("toolTitle", theme.bold("Files to restore:")));
      for (const f of redo.files) {
        if (f.unrestorable) {
          out.push(theme.fg("warning", `  ⚠ skip      ${f.path} (no pre-revert snapshot)`));
        } else if (f.existed) {
          out.push(theme.fg("accent", `  ~ restore   ${f.path}`));
        } else {
          out.push(theme.fg("error", `  - delete    ${f.path}`));
        }
      }
    }
    if (redo.previousLeafId) {
      out.push("");
      out.push(theme.fg("muted", `Conversation returns to [${redo.previousLeafId}]`));
    }
  }
  else if (entry.type === "session") {
    push("Session Start", "accent");
    if (entry.cwd) out.push(theme.fg("muted", `CWD: ${entry.cwd}`));
  }
  else if (entry.type === "model_change") {
    push("Model Change", "accent");
    out.push(theme.fg("text", `${entry.provider} / ${entry.modelId}`));
  }
  else if (entry.type === "thinking_level_change") {
    push("Thinking Level", "warning");
    out.push(entry.thinkingLevel);
  }
  else if (entry.type === "custom") {
    push(`Custom: ${entry.customType}`, "text");
    try {
      for (const line of wrapLines(sanitize(JSON.stringify(entry.data, null, 2)), width)) {
        out.push(line);
      }
    } catch {
      out.push(theme.fg("muted", "(data)"));
    }
  }
  else if (entry.type === "compaction") {
    push("Compaction", "warning");
    if (entry.summary) {
      for (const line of wrapLines(sanitize(entry.summary), width)) out.push(line);
    }
  }
  else if (entry.type === "branch_summary") {
    push("Branch Summary", "warning");
    if (entry.summary) {
      for (const line of wrapLines(sanitize(entry.summary), width)) out.push(line);
    }
  }
  else {
    push(entry.type, "text");
  }

  if (node.filesAfter.size > 0) {
    out.push("");
    out.push(theme.fg("toolTitle", theme.bold("Tracked file changes:")));
    for (const [path, info] of node.filesAfter) {
      if (info.unrestorable) {
        out.push(theme.fg("warning", `  ⚠ unreadable  ${path} (will be skipped)`));
        continue;
      }
      const act = info.created ? "+ created" : "~ modified";
      const color: ThemeColor = info.created ? "success" : "accent";
      out.push(theme.fg(color, `  ${act}  ${path}`));
    }
  }

  return out;
}

// -- Types --

type ThemeColor =
  | "accent"
  | "border"
  | "borderAccent"
  | "borderMuted"
  | "success"
  | "error"
  | "warning"
  | "muted"
  | "dim"
  | "text"
  | "userMessageText"
  | "customMessageText"
  | "customMessageLabel"
  | "toolTitle"
  | "toolOutput"
  | "bashMode"
  | "syntaxComment"
  | "syntaxKeyword"
  | "syntaxFunction"
  | "syntaxVariable"
  | "syntaxString"
  | "syntaxNumber"
  | "syntaxType"
  | "syntaxOperator"
  | "syntaxPunctuation";

interface PendingSnapshot {
  snapshotId: string;
  cwd: string;
  files: FileSnapshot[];
}

type RevertMode = "all" | "conversation" | "files";

// -- Entry helpers --

function getEntryLabel(entry: any): string {
  if (entry.type === "redo") return "↩ Undo last revert";
  if (entry.type === "tool_call") {
    const path = entry.path || "?";
    return `${entry.toolName || "tool"} → ${path}`;
  }
  if (entry.type === "session") return "Session start";
  if (entry.type === "message") {
    const msg = entry.message;
    if (msg.role === "user") {
      const text = extractText(msg.content);
      return text.slice(0, 55) + (text.length > 55 ? "…" : "");
    }
    if (msg.role === "assistant") return "Assistant";
    if (msg.role === "toolResult") return `Tool: ${msg.toolName}`;
    if (msg.role === "bashExecution") return `Bash: ${msg.command?.slice(0, 35) || ""}`;
    return msg.role;
  }
  if (entry.type === "compaction") return "Compaction";
  if (entry.type === "branch_summary") return "Branch summary";
  if (entry.type === "custom") return `Custom: ${entry.customType}`;
  if (entry.type === "model_change") return "Model change";
  if (entry.type === "thinking_level_change") return "Thinking change";
  return entry.type;
}

function getEntryIcon(entry: any): string {
  if (entry.type === "redo") return "↩";
  if (entry.type === "tool_call") return entry.toolName === "edit" ? "✎" : "✍";
  if (entry.type === "message") {
    const msg = entry.message;
    if (msg.role === "user") return ">";
    if (msg.role === "assistant") return "<";
    if (msg.role === "toolResult") return "+";
    if (msg.role === "bashExecution") return "$";
    return "-";
  }
  if (entry.type === "compaction") return "#";
  if (entry.type === "branch_summary") return "@";
  return "o";
}

function getEntryIconColor(entry: any): ThemeColor {
  if (entry.type === "redo") return "warning";
  if (entry.type === "tool_call") return "toolTitle";
  if (entry.type === "message") {
    const msg = entry.message;
    if (msg.role === "user") return "userMessageText";
    if (msg.role === "assistant") return "accent";
    if (msg.role === "toolResult") return "warning";
    if (msg.role === "bashExecution") return "success";
  }
  if (entry.type === "compaction") return "warning";
  return "muted";
}

function buildInlineHint(
  files: Map<string, { snapshotId: string; created: boolean }>,
  maxWidth: number,
  theme: Theme
): string {
  const entries = Array.from(files.entries());
  if (entries.length === 0) return "";

  const count = entries.length;
  const first = entries[0];
  const action = first[1].created ? "+" : "~";
  const actionColor: ThemeColor = first[1].created ? "success" : "accent";

  let hint = `${theme.fg(actionColor, action)} ${first[0]}`;
  if (count > 1) {
    hint += ` ${theme.fg("muted", `+${count - 1} more`)}`;
  }

  const vw = visibleWidth(hint);
  if (vw > maxWidth && maxWidth > 8) {
    hint = truncateToWidth(hint, maxWidth - 3) + "…";
  }
  return hint;
}

// -- Components --

class ListPane implements Component {
  private nodes: TreeNode[];
  private selected = 0;
  private scrollTop = 0;
  private theme: Theme;
  private visibleRows = 10;
  private cachedWidth?: number;
  private cachedLines?: string[];

  onSelect?: (node: TreeNode) => void;
  onCancel?: () => void;

  constructor(nodes: TreeNode[], theme: Theme) {
    this.nodes = nodes;
    this.theme = theme;
  }

  setVisibleRows(rows: number): void {
    if (this.visibleRows !== rows) {
      this.visibleRows = rows;
      this.invalidate();
    }
  }

  getSelectedNode(): TreeNode | undefined {
    return this.nodes[this.selected];
  }

  navUp(): boolean {
    if (this.selected <= 0) return false;
    this.selected--;
    this.invalidate();
    return true;
  }

  navDown(): boolean {
    if (this.selected >= this.nodes.length - 1) return false;
    this.selected++;
    this.invalidate();
    return true;
  }

  handleInput(data: string): boolean {
    if (matchesKey(data, Key.up)) {
      return this.navUp();
    }
    if (matchesKey(data, Key.down)) {
      return this.navDown();
    }
    if (matchesKey(data, Key.enter)) {
      const node = this.nodes[this.selected];
      if (node) this.onSelect?.(node);
      return true;
    }
    if (matchesKey(data, Key.escape) || data === "q") {
      this.onCancel?.();
      return true;
    }
    return false;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    if (this.selected < this.scrollTop) this.scrollTop = this.selected;
    if (this.selected >= this.scrollTop + this.visibleRows) {
      this.scrollTop = this.selected - this.visibleRows + 1;
    }

    const visible = this.nodes.slice(this.scrollTop, this.scrollTop + this.visibleRows);
    const lines: string[] = [];

    for (let i = 0; i < this.visibleRows; i++) {
      const node = visible[i];
      const idx = this.scrollTop + i;
      lines.push(this.renderRow(node, idx, width));
    }

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  private renderRow(node: TreeNode | undefined, idx: number, width: number): string {
    const th = this.theme;
    const isSel = idx === this.selected;
    if (!node) {
      const bg = isSel ? th.getBgAnsi("selectedBg") : "";
      return bg + " ".repeat(width) + "\x1b[0m";
    }

    const icon = getEntryIcon(node.entry);
    const iconColor = getEntryIconColor(node.entry);
    const label = getEntryLabel(node.entry);
    const prefix = "  ";

    const leftRaw = `${prefix}${th.fg(iconColor, icon)} ${th.fg("text", label)}`;
    const leftVw = visibleWidth(leftRaw);

    const idStr = th.fg("muted", node.entry.id);
    const idVw = visibleWidth(idStr);

    const hintMaxWidth = Math.max(0, width - leftVw - idVw - 2);
    const hint = buildInlineHint(node.filesAfter, hintMaxWidth, th);
    const hintVw = visibleWidth(hint);

    let row: string;
    if (hintVw > 0) {
      // Reserve 1 column for the space between hint and id
      const gap = Math.max(1, width - leftVw - hintVw - idVw - 1);
      row = leftRaw + " ".repeat(gap) + hint + " " + idStr;
    } else {
      const gap = Math.max(1, width - leftVw - idVw);
      row = leftRaw + " ".repeat(gap) + idStr;
    }

    let rawRow = padToWidth(row, width);
    if (isSel) {
      const bgAnsi = th.getBgAnsi("selectedBg");
      rawRow = bgAnsi + rawRow + "\x1b[0m";
    }
    return rawRow;
  }
}

class PreviewPane implements Component {
  private node: TreeNode | undefined;
  private scroll = 0;
  private theme: Theme;
  private mdTheme: MarkdownTheme;
  private visibleRows = 10;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(theme: Theme, mdTheme: MarkdownTheme) {
    this.theme = theme;
    this.mdTheme = mdTheme;
  }

  setVisibleRows(rows: number): void {
    if (this.visibleRows !== rows) {
      this.visibleRows = rows;
      this.invalidate();
    }
  }

  setNode(node: TreeNode | undefined): void {
    if (this.node?.entry.id !== node?.entry.id) {
      this.node = node;
      this.scroll = 0;
      this.invalidate();
    }
  }

  private cachedContentLen = 0;

  private getMaxScroll(): number {
    return Math.max(0, this.cachedContentLen - this.visibleRows);
  }

  scrollBy(delta: number): boolean {
    const maxScroll = this.getMaxScroll();
    const next = Math.max(0, Math.min(maxScroll, this.scroll + delta));
    if (next === this.scroll) return false;
    this.scroll = next;
    this.invalidate();
    return true;
  }

  scrollToTop(): void {
    this.scroll = 0;
    this.invalidate();
  }

  scrollToBottom(): void {
    this.scroll = this.getMaxScroll();
    this.invalidate();
  }

  handleInput(data: string): boolean {
    if (matchesKey(data, "j") || data === "j") {
      return this.scrollBy(1);
    }
    if (matchesKey(data, "k") || data === "k") {
      return this.scrollBy(-1);
    }
    if (data === "g" || matchesKey(data, "g")) {
      // gg handled by dialog-level double-g detection
      return false;
    }
    if (matchesKey(data, Key.shift("g"))) {
      this.scrollToBottom();
      return true;
    }
    return false;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const th = this.theme;
    const innerW = width - 2;

    const contentLines = this.node
      ? buildPreviewLines(this.node, innerW, th, this.mdTheme)
      : [th.fg("dim", "No selection")];
    this.cachedContentLen = contentLines.length;

    const lines: string[] = [];
    for (let i = 0; i < this.visibleRows; i++) {
      const pIdx = i + this.scroll;
      if (pIdx < contentLines.length) {
        const line = contentLines[pIdx]!;
        // Pad/truncate to innerW, then wrap with background + padding spaces
        const padded = padToWidth(line, innerW);
        lines.push(th.bg("userMessageBg", " " + padded + " "));
      } else {
        lines.push(th.bg("userMessageBg", " ".repeat(width)));
      }
    }

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }
}

class RevertDialog implements Component {
  private listPane: ListPane;
  private previewPane: PreviewPane;
  private mode: RevertMode = "all";
  private focus: "list" | "preview" = "list";
  private theme: Theme;
  private tui: TUI;
  private done: (result: { targetId: string; mode: RevertMode } | null) => void;
  private lastKey = ""; // for detecting "gg"

  constructor(
    nodes: TreeNode[],
    theme: Theme,
    tui: TUI,
    done: (result: { targetId: string; mode: RevertMode } | null) => void
  ) {
    this.theme = theme;
    this.tui = tui;
    this.done = done;
    this.listPane = new ListPane(nodes, theme);
    this.previewPane = new PreviewPane(theme, getMarkdownTheme());
    this.updatePreview();

    this.listPane.onSelect = (node) => this.done({ targetId: node.entry.id, mode: this.mode });
    this.listPane.onCancel = () => this.done(null);
  }

  private updatePreview(): void {
    this.previewPane.setNode(this.listPane.getSelectedNode());
  }

  private frameHeight(): number {
    return Math.max(8, Math.floor(this.tui.terminal.rows * 0.70));
  }

  private contentHeight(): number {
    return Math.max(1, this.frameHeight() - 6);
  }

  handleInput(data: string): void {
    // Detect "gg" for scroll-to-top (works in both focuses)
    if ((data === "g" || matchesKey(data, "g")) && this.lastKey === "g") {
      this.previewPane.scrollToTop();
      this.lastKey = "";
      this.invalidate();
      return;
    }
    // "G" scroll-to-bottom (works in both focuses)
    if (data === "G" || matchesKey(data, Key.shift("g"))) {
      this.previewPane.scrollToBottom();
      this.lastKey = "";
      this.invalidate();
      return;
    }
    this.lastKey = data;

    // Focus switching
    if (matchesKey(data, Key.ctrl("h"))) {
      this.focus = "list";
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.ctrl("l"))) {
      this.focus = "preview";
      this.invalidate();
      return;
    }

    if (matchesKey(data, Key.tab)) {
      this.mode =
        this.mode === "all" ? "conversation" : this.mode === "conversation" ? "files" : "all";
      this.invalidate();
      return;
    }
    if (data === "q" || matchesKey(data, Key.escape)) {
      this.done(null);
      return;
    }

    // Route j/k by focus; ↑/↓ always navigates list
    if (this.focus === "preview") {
      if (this.previewPane.handleInput(data)) {
        this.invalidate();
        return;
      }
    } else {
      if (matchesKey(data, "j") || data === "j") {
        if (this.listPane.navDown()) {
          this.updatePreview();
          this.invalidate();
        }
        return;
      }
      if (matchesKey(data, "k") || data === "k") {
        if (this.listPane.navUp()) {
          this.updatePreview();
          this.invalidate();
        }
        return;
      }
    }

    if (this.listPane.handleInput(data)) {
      this.updatePreview();
      this.invalidate();
      return;
    }
  }

  invalidate(): void {
    this.listPane.invalidate();
    this.previewPane.invalidate();
  }

  render(width: number): string[] {
    const th = this.theme;
    const contentH = this.contentHeight();
    this.listPane.setVisibleRows(contentH);
    this.previewPane.setVisibleRows(contentH);

    const internalW = width - 2;
    // -- Split ratio: right pane gets 70% of internal width --
    // Change 0.7 to adjust proportion (e.g. 0.6 = wider list, 0.8 = wider preview)
    const rightWidth = Math.round(internalW * 0.7);
    const leftWidth = internalW - rightWidth - 1;

    const leftLines = this.listPane.render(leftWidth);
    const rightLines = this.previewPane.render(rightWidth);

    const lines: string[] = [];

    // Top border
    lines.push(th.fg("border", "┌" + "─".repeat(leftWidth) + "┬" + "─".repeat(rightWidth) + "┐"));

    // Title row
    const modeStr =
      this.mode === "all" ? "All" : this.mode === "conversation" ? "Conversation Only" : "Files Only";
    const titleLeft = th.fg("accent", th.bold(` [${modeStr}] `));
    const titleRightRaw = this.focus === "preview"
      ? th.bg("selectedBg", th.fg("accent", th.bold(" Preview ")))
      : th.fg("muted", " Preview ");

    const titleLine =
      th.fg("border", "│") +
      padToWidth(titleLeft, leftWidth) +
      th.fg("border", "│") +
      padToWidth(titleRightRaw, rightWidth) +
      th.fg("border", "│");
    lines.push(titleLine);

    // Title separator
    lines.push(th.fg("border", "├" + "─".repeat(leftWidth) + "┼" + "─".repeat(rightWidth) + "┤"));

    // Content rows
    for (let i = 0; i < contentH; i++) {
      const l = leftLines[i] ?? " ".repeat(leftWidth);
      const r = rightLines[i] ?? " ".repeat(rightWidth);
      lines.push(th.fg("border", "│") + l + th.fg("border", "│") + r + th.fg("border", "│"));
    }

    // Footer separator
    lines.push(th.fg("border", "├" + "─".repeat(leftWidth) + "┴" + "─".repeat(rightWidth) + "┤"));

    // Footer
    const footerRaw =
      th.fg("muted", "↑/↓ select") + th.fg("dim", " • ") +
      th.fg("muted", "ctrl+h/l focus") + th.fg("dim", " • ") +
      th.fg("muted", this.focus === "preview" ? "j/k scroll" : "j/k nav") + th.fg("dim", " • ") +
      th.fg("muted", "gg/G jump") + th.fg("dim", " • ") +
      th.fg("muted", "tab mode") + th.fg("dim", " • ") +
      th.fg("muted", "enter revert") + th.fg("dim", " • ") +
      th.fg("muted", "q quit");
    const footerLine =
      th.fg("border", "│") +
      padToWidth(footerRaw, internalW) +
      th.fg("border", "│");
    lines.push(footerLine);

    // Bottom border
    lines.push(th.fg("border", "└" + "─".repeat(leftWidth) + "┴" + "─".repeat(rightWidth) + "┘"));

    return lines;
  }
}

// -- Extension --

export default function(pi: ExtensionAPI) {
  const pending = new Map<string, PendingSnapshot>();

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;

    const filePath = event.input?.path;
    if (!filePath || typeof filePath !== "string") return;

    const absolutePath = resolve(ctx.cwd, filePath);
    const relPath = relative(ctx.cwd, absolutePath);

    if (!isPathWithin(ctx.cwd, absolutePath)) return;

    const snapshotId = randomUUID();
    const sessionId = ctx.sessionManager.getSessionId();
    const result = await snapshotFile(absolutePath, sessionId, snapshotId, relPath);

    pending.set(event.toolCallId, {
      snapshotId,
      cwd: ctx.cwd,
      files: [
        {
          path: relPath,
          absPath: absolutePath,
          created: result.created,
          ...(result.unrestorable ? { unrestorable: true } : {}),
        },
      ],
    });
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "write" && event.toolName !== "edit") return;
    if (event.isError) {
      pending.delete(event.toolCallId);
      return;
    }

    const snap = pending.get(event.toolCallId);
    if (!snap) return;

    const entryId = ctx.sessionManager.getLeafId();
    if (entryId) {
      const protectedSnapshotIds = new Set<string>(
        [...pending.values()].map((p) => p.snapshotId),
      );
      await saveChange(ctx.sessionManager.getSessionId(), {
        entryId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        snapshotId: snap.snapshotId,
        cwd: snap.cwd,
        files: snap.files,
        createdAt: Date.now(),
      }, protectedSnapshotIds);
    }

    pending.delete(event.toolCallId);
  });

  pi.on("session_shutdown", async () => {
    pending.clear();
  });

  pi.registerCommand("revert", {
    description: "Revert conversation and tracked file changes to a previous point",
    handler: async (_args, ctx) => {
      const sessionId = ctx.sessionManager.getSessionId();
      const changes = await loadChanges(sessionId);
      const redoStack = await loadRedoStack(sessionId);

      if (changes.length === 0 && redoStack.length === 0) {
        ctx.ui.notify("No file changes tracked in this session", "warning");
        return;
      }

      const branch = ctx.sessionManager.getBranch().slice().reverse();
      if (branch.length === 0) {
        ctx.ui.notify("No conversation branch found", "error");
        return;
      }

      const branchIds = new Set(branch.map((e) => e.id));
      const branchChanges = changes.filter((c) => branchIds.has(c.entryId));

      // Build nodes: newest first (leaf at top). Keep only user messages,
      // assistant messages with actual text (thinking-only/tool-only turns
      // would render blank), and individual write/edit tool calls.
      const nodes: TreeNode[] = buildTreeNodes(branch, branchChanges).filter((n) => {
        if (n.entry?.type === "tool_call") return true;
        if (n.entry?.type === "message") {
          const msg = n.entry.message;
          if (msg?.role === "user") return true;
          if (msg?.role === "assistant") {
            return extractText(msg.content).trim().length > 0;
          }
        }
        return false;
      });

      // Inject "Undo last revert" pseudo-entry at the top
      if (redoStack.length > 0) {
        nodes.unshift({
          entry: { type: "redo", id: REDO_ENTRY_ID, redo: redoStack[redoStack.length - 1] },
          filesAfter: new Map(),
        });
      }

      // -- Overlay sizing: adjust these values to change window size --
      // width:      overall overlay width (percentage of terminal or absolute cols)
      // minWidth:   minimum width in columns
      // maxHeight:  maximum height (percentage of terminal rows or absolute rows)
      // anchor:     position on screen ("center", "top-right", "bottom-left", etc.)
      const result = await ctx.ui.custom<{ targetId: string; mode: RevertMode } | null>(
        (tui, theme, _kb, done) => new RevertDialog(nodes, theme, tui, done),
        {
          overlay: true,
          overlayOptions: {
            width: "80%",     // ← change overlay width
            minWidth: 40,     // ← minimum columns
            maxHeight: "70%", // ← change overlay height
            anchor: "center", // ← change position
          },
        }
      );

      if (!result) return;
      const { targetId, mode } = result;

      // ---- Undo flow: restore pre-revert state, then navigate back ----
      if (targetId === REDO_ENTRY_ID) {
        // Re-read the stack (it may have changed while the dialog was open)
        const stack = await loadRedoStack(sessionId);
        const top = stack[stack.length - 1];
        if (!top) {
          ctx.ui.notify("Nothing to undo", "warning");
          return;
        }

        // Peek-then-pop: restore BEFORE popRedo, since pop deletes the snapshot dir
        let restored = 0;
        let skipped = 0;
        for (const f of top.files) {
          if (f.unrestorable) {
            skipped++;
            continue;
          }
          try {
            if (f.existed) {
              await restoreSnapshotFile(sessionId, top.snapshotId, f.path, f.absPath);
            } else {
              await deleteFileAndCleanDirs(f.absPath, top.cwd);
            }
            restored++;
          } catch (e: any) {
            skipped++;
            ctx.ui.notify(`Failed to restore ${f.path}: ${e.message}`, "warning");
          }
        }
        await popRedo(sessionId);

        let navNote = "";
        if (top.previousLeafId) {
          try {
            const navResult = await ctx.navigateTree(top.previousLeafId);
            if (navResult.cancelled) navNote = " (conversation navigation cancelled)";
          } catch {
            navNote = " (conversation target no longer exists)";
          }
        }

        const skipNote = skipped > 0 ? `, ${skipped} skipped` : "";
        ctx.ui.notify(
          `Undid last revert — ${restored} file(s) restored${skipNote}${navNote}`,
          skipped > 0 ? "warning" : "info",
        );
        return;
      }

      const filesToRevert = computeFilesToRevert(nodes, targetId);
      const selectedNode = nodes.find((n) => n.entry?.id === targetId);
      const conversationEntryId = selectedNode?.entry?.entryId ?? targetId;
      const hasFiles = filesToRevert.size > 0;

      if (mode === "files" && !hasFiles) {
        ctx.ui.notify("No tracked file changes after this point", "info");
        return;
      }

      // Conversation-only mode: navigate, then record a redo entry (files: [])
      // so the jump itself can be undone.
      if (mode === "conversation" || !hasFiles) {
        const prevLeaf = ctx.sessionManager.getLeafId() ?? "";
        const navResult = await ctx.navigateTree(conversationEntryId);
        if (navResult.cancelled) {
          ctx.ui.notify("Revert cancelled", "warning");
          return;
        }
        await pushRedo(sessionId, {
          previousLeafId: prevLeaf,
          targetId,
          cwd: ctx.cwd,
          snapshotId: `redo-${Date.now()}`,
          files: [],
          createdAt: Date.now(),
        }).catch(() => {});
        if (mode === "conversation" && hasFiles) {
          ctx.ui.notify("Conversation reverted (files unchanged)", "info");
        } else {
          ctx.ui.notify("Conversation reverted", "info");
        }
        return;
      }

      // All / files mode: capture pre-revert state for undo BEFORE mutating
      const plan = [...filesToRevert.entries()];
      let restorable = plan.filter(([, info]) => !info.unrestorable);
      let skippedCount = plan.length - restorable.length;

      try {
        const redoSnapshotId = `redo-${Date.now()}`;
        const redoFiles = await snapshotForRedo(
          sessionId,
          redoSnapshotId,
          restorable.map(([path, info]) => ({ path, absPath: info.absPath })),
        );
        // If we cannot capture the pre-revert state of a file, we must not
        // revert it either — undo would be unable to restore it.
        const restorableWithRedo = restorable.filter((_, i) => !redoFiles[i].unrestorable);
        const redoSnapshotFailures = restorable.length - restorableWithRedo.length;
        await pushRedo(sessionId, {
          previousLeafId: ctx.sessionManager.getLeafId() ?? "",
          targetId,
          cwd: ctx.cwd,
          snapshotId: redoSnapshotId,
          files: redoFiles,
          createdAt: Date.now(),
        });
        restorable = restorableWithRedo;
        skippedCount += redoSnapshotFailures;
      } catch {
        ctx.ui.notify("Failed to record undo snapshot — revert will be irreversible", "warning");
      }

      let restored = 0;
      for (const [relPath, info] of restorable) {
        try {
          if (info.created) {
            await deleteFileAndCleanDirs(info.absPath, info.cwd);
          } else {
            await restoreSnapshotFile(sessionId, info.snapshotId, relPath, info.absPath);
          }
          restored++;
        } catch (e: any) {
          ctx.ui.notify(`Failed to revert ${relPath}: ${e.message}`, "warning");
        }
      }

      if (mode === "all") {
        const navResult = await ctx.navigateTree(conversationEntryId);
        if (navResult.cancelled) {
          ctx.ui.notify("Files reverted; conversation navigation cancelled", "warning");
          return;
        }
      }

      const skipNote = skippedCount > 0 ? `, ${skippedCount} skipped (unreadable)` : "";
      ctx.ui.notify(
        mode === "all"
          ? `Reverted to [${targetId}] — ${restored} file(s) restored${skipNote}`
          : `Reverted ${restored} file(s) (conversation unchanged)${skipNote}`,
        "info",
      );
    },
  });
}
