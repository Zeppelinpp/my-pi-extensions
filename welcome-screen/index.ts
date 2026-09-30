/**
 * welcome-screen — minimal geek startup header
 *
 * Replaces the built-in header with a compact Pi mascot + brand block and
 * re-renders Pi's loaded-resources panel as a 4-line list (ctx/skl/prm/ext).
 * All colors come from theme tokens, so it inherits the active custom theme.
 *
 * Falls back to Pi's native resource panel if the TUI layout is unrecognized.
 */

import {
  VERSION,
  keyHint,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from "@earendil-works/pi-tui";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

const BRIDGE_KEY = "__piWelcomeScreenBridge";
const POLL_MS = 50;
const MAX_POLLS = 20;
const PAD = 2;
const ICON_WIDTH = 12;
const ICON_GAP = 3;
const MIN_ICON_LAYOUT_WIDTH = 50;

/** Chunky pixel-π, after kaushik's pi-welcome-screen. */
const PI_ICON = [
  "█████████",
  "███   ███",
  "██████   ███",
  "███      ███",
];

/** Map thinking effort to the theme's thinking-level color token. */
function thinkingColorToken(level: string | undefined): string {
  const l = (level ?? "off").toLowerCase();
  return `thinking${l.charAt(0).toUpperCase()}${l.slice(1)}`;
}

type SectionKey = "ctx" | "skl" | "prm" | "ext";
const SECTION_HEADINGS: Record<string, SectionKey> = {
  Context: "ctx",
  Skills: "skl",
  Prompts: "prm",
  Extensions: "ext",
};
const SECTION_ORDER: SectionKey[] = ["ctx", "skl", "prm", "ext"];
const SECTION_LABELS: Record<SectionKey, string> = {
  ctx: "context",
  skl: "skills",
  prm: "prompts",
  ext: "extensions",
};
/** One hue per section, borrowed from monokai's syntax grammar. */
const SECTION_COLORS: Record<SectionKey, string> = {
  ctx: "mdHeading", // strings → files
  skl: "success", // functions → capabilities
  prm: "error", // keywords → commands (pink, not red-alert)
  ext: "border", // modules → purple
};
const LABEL_WIDTH = Math.max(
  ...Object.values(SECTION_LABELS).map((l) => l.length),
);
const IGNORED_HEADINGS = new Set(["Themes"]);

interface Sections {
  items: Partial<Record<SectionKey, string[]>>;
  /** Native sections we don't render (e.g. "[Theme conflicts]"). */
  warnings: string[];
}

interface PanelBridge {
  host: { children: Component[]; removeChild(c: Component): void };
  panel: { children: Component[]; invalidate(): void };
  index: number;
}

interface PanelBridge {
  host: { children: Component[]; removeChild(c: Component): void };
  panel: { children: Component[]; invalidate(): void };
  index: number;
}

/**
 * Pi's resource sections changed shape in 0.99: pi-tui's ExpandableText
 * (with getCollapsedText()) was replaced by internal ThemedText subclasses
 * whose text lives behind a `build()` thunk; expansion is only visible via
 * setExpanded(). Read either shape.
 */
interface SectionComponent extends Component {
  build?(): string;
  getCollapsedText?(): string;
  setExpanded?(expanded: boolean): void;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "");
}

function readSection(
  c: Component,
): { text: string; expandable: boolean } | undefined {
  const section = c as SectionComponent;
  if (typeof section.getCollapsedText === "function") {
    return { text: section.getCollapsedText(), expandable: true };
  }
  if (typeof section.build === "function") {
    return {
      text: section.build(),
      expandable: typeof section.setExpanded === "function",
    };
  }
  return undefined;
}

function hasChildren(c: unknown): c is { children: Component[] } {
  return Array.isArray((c as { children?: unknown })?.children);
}

/** Detach Pi's loaded-resources panel (documentContainer.children[1]). */
function takePanel(tui: TUI): PanelBridge | undefined {
  const keyed = tui as TUI & { [BRIDGE_KEY]?: PanelBridge };
  if (keyed[BRIDGE_KEY]) return keyed[BRIDGE_KEY];

  const doc = (tui as unknown as { children?: Component[] }).children?.[0];
  if (!hasChildren(doc) || typeof (doc as PanelBridge["host"]).removeChild !== "function")
    return undefined;
  const panel = doc.children[1];
  if (!hasChildren(panel)) return undefined;

  const bridge: PanelBridge = {
    host: doc as PanelBridge["host"],
    panel: panel as PanelBridge["panel"],
    index: 1,
  };
  bridge.host.removeChild(bridge.panel as unknown as Component);
  keyed[BRIDGE_KEY] = bridge;
  return bridge;
}

function restorePanel(tui: TUI): void {
  const keyed = tui as TUI & { [BRIDGE_KEY]?: PanelBridge };
  const bridge = keyed[BRIDGE_KEY];
  if (!bridge) return;
  if (!bridge.host.children.includes(bridge.panel as unknown as Component)) {
    const i = Math.min(bridge.index, bridge.host.children.length);
    bridge.host.children.splice(i, 0, bridge.panel as unknown as Component);
  }
  delete keyed[BRIDGE_KEY];
}

function pathLeaf(label: string): string {
  const normalized = label.replace(/\\/g, "/");
  return normalized.split("/").pop() ?? label;
}

function shortenHome(path: string): string {
  const home = homedir();
  const rel = relative(home, path);
  if (rel === "") return "~";
  if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)) {
    return join("~", rel);
  }
  return path;
}

function extName(label: string): string {
  let s = label.trim().replace(/^npm:/, "").replace(/\\/g, "/");
  const colon = s.lastIndexOf(":");
  if (colon > 1) s = s.slice(0, colon); // strip ":src" entry-point suffix
  s = s.replace(/\.[cm]?[jt]s$/, "");
  if (s.endsWith("/index")) s = s.slice(0, -"/index".length); // dir-style entry
  if (s.includes("/") && !s.startsWith("@")) s = s.split("/").pop() ?? s;
  return s;
}

function parsePanel(panel: PanelBridge["panel"]): Sections {
  const items: Sections["items"] = {};
  const warnings: string[] = [];

  for (const child of panel.children) {
    const section = readSection(child);
    if (!section) continue;
    const text = stripAnsi(section.text);
    const [head = "", ...rest] = text.split("\n");
    const heading = head.trim().match(/^\[([^\]]+)\]$/)?.[1];
    if (!heading) continue;
    if (IGNORED_HEADINGS.has(heading)) continue;

    const key = SECTION_HEADINGS[heading];
    if (!key) {
      // Non-expandable notices, e.g. [Skill conflicts], surface as warnings.
      warnings.push(heading);
      continue;
    }
    // Collapsed lists are comma-separated; expanded lists are one per line.
    const body = rest
      .join("\n")
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    items[key] = [
      ...new Set(
        key === "ctx"
          ? body.map(pathLeaf)
          : key === "ext"
            ? body.map(extName)
            : body,
      ),
    ];
  }
  return { items, warnings };
}

/** Greedy-fit items into width; remainder becomes a "+N" suffix. */
function fitItems(
  items: string[],
  width: number,
): { shown: string[]; hidden: number } {
  const shown: string[] = [];
  let used = 0;
  for (let i = 0; i < items.length; i++) {
    const w = visibleWidth(items[i]);
    const sep = shown.length > 0 ? 2 : 0;
    const remaining = items.length - i - 1;
    const reserve = remaining > 0 ? 3 + String(remaining).length : 0; // " +NN"
    if (used + sep + w + reserve <= width) {
      shown.push(items[i]);
      used += sep + w;
    } else {
      return { shown, hidden: items.length - i };
    }
  }
  return { shown, hidden: 0 };
}

class WelcomeHeader implements Component {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sections: Sections | undefined;
  private resolved = false;
  private lastSnapshot = "";
  private cache: { key: string; lines: string[] } | undefined;
  private disposed = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly ctx: ExtensionContext,
    private readonly bridge: PanelBridge | undefined,
    forceInitialRender: boolean,
  ) {
    if (bridge) {
      this.timer = setTimeout(() => this.poll(0, forceInitialRender), 0);
    } else {
      this.resolved = true; // banner-only; native panel left intact
    }
  }

  private poll(attempt: number, force: boolean): void {
    if (this.disposed || !this.bridge) return;
    const sections = parsePanel(this.bridge.panel);
    const snapshot = JSON.stringify(sections);
    const populated = Object.keys(sections.items).length > 0;
    const complete =
      Boolean(sections.items.ext) || // extensions load last
      (populated && snapshot === this.lastSnapshot); // content stabilized

    this.lastSnapshot = snapshot;
    if (complete || attempt >= MAX_POLLS) {
      this.sections = populated ? sections : undefined;
      this.resolved = true;
      this.timer = undefined;
      this.cache = undefined;
      this.tui.requestRender(force);
      return;
    }
    this.timer = setTimeout(() => this.poll(attempt + 1, false), POLL_MS);
  }

  private brandLines(): string[] {
    const theme = this.theme;
    const model = this.ctx.model;
    const cwd = shortenHome(this.ctx.cwd);

    // L1 wordmark — "pi" follows the thinking-level hue, version recedes
    const wordmark = `${theme.bold(theme.fg(thinkingColorToken(this.ctx.thinkingLevel), "pi"))} ${theme.fg("dim", `v${VERSION}`)}`;
    // L2 model — id in accent (matches the statusline), provider recedes
    const modelLine = model
      ? theme.fg("dim", `${model.provider} / `) + theme.fg("accent", model.id)
      : "";
    // L3 provenance — cwd recedes
    const provenance = theme.fg("dim", cwd);

    return [wordmark, modelLine, provenance].filter(
      (l) => visibleWidth(l) > 0,
    );
  }

  private iconBlock(width: number): string[] {
    const theme = this.theme;
    const info = this.brandLines();

    if (width < MIN_ICON_LAYOUT_WIDTH) {
      return info.filter((l) => visibleWidth(l) > 0);
    }

    const iconColor = thinkingColorToken(this.ctx.thinkingLevel);
    const icon = PI_ICON.map((line) =>
      theme.fg(iconColor, line) + " ".repeat(ICON_WIDTH - line.length),
    );
    const infoRows = ["", ...info];
    return icon.map((line, i) => {
      const infoLine = infoRows[i] ?? "";
      if (!infoLine) return line.trimEnd();
      return line + " ".repeat(ICON_GAP) + infoLine;
    });
  }

  private sectionLine(
    label: string,
    color: string,
    items: string[],
    width: number,
  ): string | undefined {
    if (items.length === 0) return undefined;
    const theme = this.theme;
    // right-aligned label column + hairline, content carries the section hue
    const prefixWidth = LABEL_WIDTH + 3;
    const prefix =
      theme.fg("dim", label.padStart(LABEL_WIDTH)) +
      " " +
      theme.fg("dim", "│") +
      " ";
    const avail = width - prefixWidth;
    if (avail < 10) return prefix + theme.fg("dim", `+${items.length}`);

    const { shown, hidden } = fitItems(items, avail);
    const body = theme.fg(
      color,
      truncateToWidth(shown.join("  "), avail, ""),
    );
    const suffix = hidden > 0 ? theme.fg("dim", ` +${hidden}`) : "";
    return prefix + body + suffix;
  }

  render(width: number): string[] {
    // cache keyed on width + thinking level (the icon color follows it)
    const cacheKey = `${width}:${this.ctx.thinkingLevel ?? ""}`;
    if (this.cache?.key === cacheKey) return this.cache.lines;

    const contentWidth = Math.max(1, width - PAD * 2);
    const lines: string[] = ["", ...this.iconBlock(contentWidth)];

    if (this.sections) {
      lines.push("");
      for (const key of SECTION_ORDER) {
        const line = this.sectionLine(
          SECTION_LABELS[key],
          SECTION_COLORS[key],
          this.sections.items[key] ?? [],
          contentWidth,
        );
        if (line) lines.push(line);
      }
      if (this.sections.warnings.length > 0) {
        lines.push(
          `${this.theme.fg("warning", "!".padStart(LABEL_WIDTH))} ${this.theme.fg("dim", "│")} ${this.theme.fg("dim", this.sections.warnings.join("  "))}`,
        );
      }
      lines.push(
        "",
        this.theme.fg("dim", `/ commands · ! bash · ${keyHint("app.tools.expand", "more")}`),
      );
    }
    lines.push("");

    const padded = lines.map((l) =>
      l ? " ".repeat(PAD) + truncateToWidth(l, contentWidth, "") : "",
    );
    if (this.resolved) this.cache = { key: cacheKey, lines: padded };
    return padded;
  }

  invalidate(): void {
    this.cache = undefined;
    this.bridge?.panel.invalidate();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
  }
}

export default function (pi: ExtensionAPI) {
  let currentTui: TUI | undefined;

  pi.on("session_start", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    ctx.ui.setHeader((tui, theme) => {
      currentTui = tui;
      return new WelcomeHeader(
        tui,
        theme,
        ctx,
        takePanel(tui),
        event.reason === "startup",
      );
    });
  });

  pi.registerCommand("welcome-native", {
    description: "Restore Pi's built-in header and resource panel",
    handler: async (_args, ctx) => {
      if (currentTui) restorePanel(currentTui);
      ctx.ui.setHeader(undefined);
      ctx.ui.notify("Built-in header restored", "info");
    },
  });
}
