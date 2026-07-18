/**
 * Context Inspector Popup
 *
 * /context opens a scrollable overlay showing:
 * - System prompt source file + token count
 * - Loaded skills with per-skill token counts
 * - Messages context usage
 *
 * Controls:
 *   q / Esc = quit popup
 *   j / ↓   = scroll down
 *   k / ↑   = scroll up
 */

import type { BuildSystemPromptOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { estimateContextTokens } from "@earendil-works/pi-coding-agent";
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
	const home = process.env.HOME || "~";
	const candidates = [
		{ type: "system" as const, path: join(cwd, ".pi", "SYSTEM.md") },
		{ type: "system" as const, path: join(home, ".pi", "agent", "SYSTEM.md") },
		{ type: "append" as const, path: join(cwd, ".pi", "APPEND_SYSTEM.md") },
		{ type: "append" as const, path: join(home, ".pi", "agent", "APPEND_SYSTEM.md") },
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

interface PopupData {
	sysFile?: string;
	appendFile?: string;
	sysTokens: number;
	skills: Array<{ name: string; tokens: number; hidden: boolean }>;
	messagesTokens: number;
	totalTokens: number | null;
	contextWindow: number;
}

class ContextPopup {
	private scrollOffset = 0;
	private lines: string[] = [];

	constructor(
		private tui: TUI,
		private theme: Theme,
		private done: () => void,
		private data: PopupData,
	) {
		this.rebuildLines();
	}

	private rebuildLines() {
		const d = this.data;
		const lines: string[] = [];

		lines.push("System Prompt");
		if (d.sysFile) {
			lines.push(`  File : ${d.sysFile}`);
		} else {
			lines.push(`  File : Pi default prompt`);
		}
		if (d.appendFile) {
			lines.push(`  Append: ${d.appendFile}`);
		}
		lines.push(`  Tokens: ~${d.sysTokens.toLocaleString()}`);
		lines.push("");

		lines.push(`Skills (${d.skills.length})`);
		for (const s of d.skills) {
			const label = s.hidden ? "(hidden)" : `~${s.tokens.toLocaleString()} tok`;
			lines.push(`  * ${s.name}  ${label}`);
		}
		if (d.skills.length === 0) lines.push("  (none)");
		lines.push("");

		lines.push("Messages");
		lines.push(`  Tokens: ~${d.messagesTokens.toLocaleString()}`);
		if (d.totalTokens != null) {
			lines.push(`  Total : ~${d.totalTokens.toLocaleString()} / ${d.contextWindow.toLocaleString()}`);
			const pct = ((d.totalTokens / d.contextWindow) * 100).toFixed(1);
			lines.push(`  Usage : ${pct}%`);
		}

		this.lines = lines;
	}

	/** How many content rows fit inside the popup without clipping the frame. */
	private get contentHeight(): number {
		const termRows = this.tui.terminal.rows;
		// Header (top + title + sep) = 3 rows, bottom border = 1 row, leave 2-row margin
		const maxTotal = Math.max(6, termRows - 2);
		const maxContent = maxTotal - 4;
		return Math.min(this.lines.length, Math.max(4, maxContent));
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || data === "q" || data === "Q") {
			this.done();
			return;
		}
		if (matchesKey(data, "down") || data === "j") {
			const maxScroll = Math.max(0, this.lines.length - this.contentHeight);
			this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
		} else if (matchesKey(data, "up") || data === "k") {
			this.scrollOffset = Math.max(0, this.scrollOffset - 1);
		}
	}

	render(width: number): string[] {
		const th = this.theme;
		const innerW = Math.max(40, width - 2);
		const h = this.contentHeight;
		const b = (s: string) => th.fg("border", s);

		const out: string[] = [];

		// Frame top
		out.push(b(`╭${"─".repeat(innerW)}╮`));

		// Title
		out.push(b("│") + pad(th.fg("accent", " Context Inspector"), innerW) + b("│"));

		// Separator
		out.push(b(`├${"─".repeat(innerW)}┤`));

		// Content
		const start = this.scrollOffset;
		for (let i = 0; i < h; i++) {
			const idx = start + i;
			if (idx < this.lines.length) {
				const raw = this.lines[idx] ?? "";
				out.push(b("│") + pad(truncateToWidth(raw, innerW), innerW) + b("│"));
			} else {
				out.push(b(`│${" ".repeat(innerW)}│`));
			}
		}

		// Frame bottom — plain line, no footer text
		out.push(b(`╰${"─".repeat(innerW)}╯`));

		return out;
	}

	invalidate(): void {}
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
		description: "Open context inspector popup (q=quit, j/k=scroll)",
		handler: async (_args, ctx) => {
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

			const data: PopupData = {
				sysFile: sysFiles.system,
				appendFile: sysFiles.append,
				sysTokens,
				skills,
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
