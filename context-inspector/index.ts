/**
 * Context Inspector Popup
 *
 * /context opens a scrollable overlay showing:
 * - System prompt source file + token count
 * - Loaded skills with per-skill token counts (flow-wrapped)
 * - Context usage with progress bar
 *
 * Height adapts to the terminal: content scrolls (with scrollbar) instead
 * of overflowing the screen.
 *
 * Controls:
 *   q / Esc      = quit popup
 *   j / ↓ k / ↑  = scroll
 *   PgDn / PgUp  = page
 *   g / G        = top / bottom
 */

import type { BuildSystemPromptOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	CONFIG_DIR_NAME,
	estimateContextTokens,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { matchesKey, type Theme, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

interface CapturedData {
	systemPromptOptions: BuildSystemPromptOptions;
	systemPrompt: string;
}

let captured: CapturedData | null = null;

/** Pi's internal heuristic: chars / 4 (conservative overestimate). */
function charsToTokens(chars: number): number {
	return Math.ceil(chars / 4);
}

function findSystemPromptFiles(cwd: string): { system?: string; append?: string } {
	const agentDir = getAgentDir();
	const candidates = [
		{ type: "system" as const, path: join(cwd, CONFIG_DIR_NAME, "SYSTEM.md") },
		{ type: "system" as const, path: join(agentDir, "SYSTEM.md") },
		{ type: "append" as const, path: join(cwd, CONFIG_DIR_NAME, "APPEND_SYSTEM.md") },
		{ type: "append" as const, path: join(agentDir, "APPEND_SYSTEM.md") },
	];
	const result: { system?: string; append?: string } = {};
	for (const c of candidates) {
		if (existsSync(c.path)) {
			if (c.type === "system" && !result.system) result.system = c.path;
			if (c.type === "append" && !result.append) result.append = c.path;
		}
	}
	return result;
}

function getSkillTokens(filePath: string): number {
	try {
		const content = readFileSync(filePath, "utf-8");
		return charsToTokens(content.length);
	} catch {
		return 0;
	}
}

/** Right-pad a string to exactly `target` visible columns. */
function pad(s: string, target: number): string {
	const v = visibleWidth(s);
	if (v >= target) return s;
	return s + " ".repeat(target - v);
}

/** Format a token count compactly: 834 → "834", 12345 → "12.3k". */
function fmtTok(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

interface PopupData {
	sysFile?: string;
	appendFile?: string;
	sysTokens: number;
	skills: Array<{ name: string; tokens: number; hidden: boolean }>;
	/** Sum of tokens over non-hidden skills. */
	skillsTokens: number;
	messagesTokens: number;
	totalTokens: number | null;
	contextWindow: number;
}

class ContextPopup {
	private scrollOffset = 0;
	/** Sticky bottom: when true, resize keeps the view pinned to the end. */
	private atBottom = false;
	private lines: string[] = [];
	private cachedWidth = -1;

	constructor(
		private tui: TUI,
		private theme: Theme,
		private done: () => void,
		private data: PopupData,
	) {}

	/** Rebuild content lines (width-dependent due to skill flow-wrapping). */
	private ensureLines(innerW: number): void {
		if (innerW === this.cachedWidth) return;
		this.cachedWidth = innerW;
		this.lines = this.buildLines(innerW);
	}

	private buildLines(innerW: number): string[] {
		const th = this.theme;
		const d = this.data;
		const lines: string[] = [];
		const label = (s: string) => th.fg("dim", s);
		const value = (s: string) => th.fg("syntaxNumber", s);

		// — System prompt —
		lines.push(th.fg("accent", " System Prompt"));
		lines.push(
			`   ${label("source")}  ${th.fg("muted", d.sysFile ?? "Pi default prompt")}`,
		);
		if (d.appendFile) {
			lines.push(`   ${label("append")}  ${th.fg("muted", d.appendFile)}`);
		}
		lines.push(`   ${label("tokens")}  ${value(`~${fmtTok(d.sysTokens)}`)}`);
		lines.push("");

		// — Skills, flow-wrapped at entry boundaries instead of one tall column —
		lines.push(
			d.skills.length > 0
				? th.fg("accent", ` Skills (${d.skills.length})`) + label(`  ~${fmtTok(d.skillsTokens)} loaded`)
				: th.fg("accent", " Skills (0)"),
		);
		if (d.skills.length === 0) {
			lines.push(label("   (none)"));
		} else {
			let cur = "";
			for (const s of d.skills) {
				const entry = s.hidden
					? th.fg("dim", `${s.name} (hidden)`)
					: `${s.name} ${th.fg("dim", `~${fmtTok(s.tokens)}`)}`;
				const candidate = cur ? `${cur}  ${entry}` : `   ${entry}`;
				if (cur && visibleWidth(candidate) > innerW) {
					lines.push(cur);
					cur = `   ${entry}`;
				} else {
					cur = candidate;
				}
			}
			if (cur) lines.push(cur);
		}
		lines.push("");

		// — Context usage —
		lines.push(th.fg("accent", " Context Usage"));
		if (d.totalTokens != null && d.contextWindow > 0) {
			const pct = Math.min(100, Math.max(0, (d.totalTokens / d.contextWindow) * 100));
			const color = pct > 80 ? "error" : pct > 50 ? "warning" : "success";
			const barW = Math.max(6, Math.min(20, innerW - 32));
			const filled = Math.round((pct / 100) * barW);
			const bar = th.fg(color, "█".repeat(filled)) + th.fg("dim", "░".repeat(barW - filled));
			lines.push(
				`   ${bar} ${th.fg(color, `${pct.toFixed(0)}%`)} ${label(`of ${fmtTok(d.contextWindow)} window`)}`,
			);
			lines.push(`   ${label("total")}   ${value(`~${fmtTok(d.totalTokens)}`)}`);
		}
		lines.push(`   ${label("messages")}  ${value(`~${fmtTok(d.messagesTokens)}`)}`);

		return lines;
	}

	/** How many content rows fit inside the popup for the current terminal height. */
	private get contentHeight(): number {
		const termRows = this.tui.terminal.rows;
		// chrome: top border (1) + footer line (1) + bottom border (1) = 3,
		// plus a 2-row vertical margin against the terminal edge.
		const maxContent = Math.max(4, termRows - 2 - 3);
		return Math.min(this.lines.length, maxContent);
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q" || data === "Q") {
			this.done();
			return;
		}
		const h = this.contentHeight;
		const maxScroll = Math.max(0, this.lines.length - h);
		if (matchesKey(data, "down") || data === "j") {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
		} else if (matchesKey(data, "up") || data === "k") {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		} else if (matchesKey(data, "pageDown")) {
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + h);
		} else if (matchesKey(data, "pageUp")) {
			this.scrollOffset = Math.max(0, this.scrollOffset - h);
		} else if (data === "g") {
			this.scrollOffset = 0;
		} else if (data === "G") {
			this.scrollOffset = maxScroll;
		} else {
			return;
		}
		this.atBottom = this.scrollOffset === maxScroll;
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (width <= 1) return [truncateToWidth("Context", Math.max(0, width), "")];

		const th = this.theme;
		const innerW = Math.max(0, width - 2);
		this.ensureLines(innerW);
		const h = this.contentHeight;
		// Clamp (or stick to bottom) after height/width changes, e.g. terminal resize.
		const maxScroll = Math.max(0, this.lines.length - h);
		this.scrollOffset = this.atBottom
			? maxScroll
			: Math.max(0, Math.min(maxScroll, this.scrollOffset));
		const b = (s: string) => th.fg("border", s);

		const out: string[] = [];

		// Top border with embedded title
		const title = truncateToWidth(th.fg("accent", " Context Inspector "), innerW, "");
		const titleW = visibleWidth(title);
		out.push(b("╭") + title + b("─".repeat(Math.max(0, innerW - titleW))) + b("╮"));

		// Scrollbar geometry (only when content overflows and has room)
		const scrollable = this.lines.length > h && innerW >= 2;
		const thumbSize = scrollable ? Math.max(1, Math.round((h * h) / this.lines.length)) : 0;
		const thumbStart =
			scrollable && maxScroll > 0 ? Math.round((this.scrollOffset / maxScroll) * (h - thumbSize)) : 0;

		// Content rows
		for (let i = 0; i < h; i++) {
			const idx = this.scrollOffset + i;
			const raw = this.lines[idx] ?? "";
			if (scrollable) {
				const content = pad(truncateToWidth(raw, innerW - 2), innerW - 2);
				const isThumb = i >= thumbStart && i < thumbStart + thumbSize;
				const bar = isThumb ? th.fg("accent", "█") : th.fg("dim", "│");
				out.push(b("│") + content + " " + bar + b("│"));
			} else {
				out.push(b("│") + pad(truncateToWidth(raw, innerW), innerW) + b("│"));
			}
		}

		// Footer: key hints left, scroll position right
		const hint = th.fg("dim", " q quit · j/k scroll · PgUp/PgDn · g/G");
		const pos = scrollable ? th.fg("dim", `${this.scrollOffset + 1}/${this.lines.length}`) : "";
		let footer = pad(truncateToWidth(hint, innerW), innerW);
		if (pos) {
			const space = innerW - visibleWidth(hint) - visibleWidth(pos);
			footer =
				space >= 1
					? hint + " ".repeat(space) + pos
					: pad(truncateToWidth(hint, innerW), innerW);
		}
		out.push(b("│") + footer + b("│"));

		// Bottom border
		out.push(b(`╰${"─".repeat(innerW)}╯`));

		return out;
	}

	invalidate(): void {
		this.cachedWidth = -1;
	}
	dispose(): void {}
}

export default function contextInspector(pi: ExtensionAPI) {
	pi.on("before_agent_start", (event) => {
		captured = {
			systemPromptOptions: event.systemPromptOptions,
			systemPrompt: event.systemPrompt,
		};
	});

	pi.registerCommand("context", {
		description: "Open context inspector popup (q=quit, j/k=scroll, PgUp/PgDn=page)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				if (ctx.hasUI) ctx.ui.notify("Context inspector requires interactive mode", "error");
				return;
			}

			if (!captured) {
				ctx.ui.notify("No context captured yet. Send a message first.", "warning");
				return;
			}

			const opts = captured.systemPromptOptions;
			const sysFiles = findSystemPromptFiles(ctx.cwd);

			// Messages tokens: use Pi's official estimator
			let messagesTokens = 0;
			try {
				const sessionCtx = ctx.sessionManager.buildSessionContext();
				const estimate = estimateContextTokens(sessionCtx.messages);
				messagesTokens = estimate.tokens;
			} catch {
				// leave as 0
			}

			// Total context from Pi's built-in tracker
			const usage = ctx.getContextUsage?.();
			const totalTokens = usage?.tokens ?? null;
			const contextWindow = usage?.contextWindow ?? 0;

			// System prompt tokens = total - messages when possible,
			// otherwise fall back to chars/4 heuristic (same as Pi internals).
			let sysTokens = 0;
			if (totalTokens != null && messagesTokens > 0) {
				sysTokens = Math.max(0, totalTokens - messagesTokens);
			} else {
				sysTokens = charsToTokens(captured.systemPrompt.length);
			}

			const skills = (opts.skills || []).map((s) => ({
				name: s.name,
				tokens: getSkillTokens(s.filePath),
				hidden: s.disableModelInvocation,
			}));
			const skillsTokens = skills.reduce((sum, s) => (s.hidden ? sum : sum + s.tokens), 0);

			const data: PopupData = {
				sysFile: sysFiles.system,
				appendFile: sysFiles.append,
				sysTokens,
				skills,
				skillsTokens,
				messagesTokens,
				totalTokens,
				contextWindow,
			};

			await ctx.ui.custom<void>((tui, theme, _kb, done) => new ContextPopup(tui, theme, done, data), {
				overlay: true,
				overlayOptions: {
					width: "80%",
					anchor: "center",
				},
			});
		},
	});
}
