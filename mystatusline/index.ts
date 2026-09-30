/**
 * Custom Status Line Extension
 *
 * Layout (3+ lines when inside a git repo with changes):
 * 1. git repo + branch | [model] + thinking effort
 * 2. context usage progress bar | permission mode
 * 3. git diff stats: file_name (+20|-6), wrapped at entry boundaries, capped at 3 lines
 *    with `... (N files) +A|-D` overflow summary
 */

import type { ExtensionAPI, ExtensionContext, Theme, ReadonlyFooterDataProvider } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Shorten a path by replacing the home directory with `~`. */
function shortenPath(p: string): string {
	const home = homedir();
	const rel = relative(home, p);
	if (rel === "") return "~";
	if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)) {
		return join("~", rel);
	}
	return p;
}

/** Walk up from cwd to find the .git directory. */
function findGitRepoDir(cwd: string): string | null {
	let dir = cwd;
	while (true) {
		const gitPath = join(dir, ".git");
		if (existsSync(gitPath)) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

// ── Caches ──
// render() runs on the TUI hot path (potentially per message during
// streaming); spawning git and walking the dir tree on every render blocks
// the UI. Cache both with short TTLs so renders are cheap and stats still
// refresh promptly.

const REPO_DIR_TTL_MS = 5000;
const repoDirCache = new Map<string, { dir: string | null; ts: number }>();

function findGitRepoDirCached(cwd: string): string | null {
	const hit = repoDirCache.get(cwd);
	if (hit && Date.now() - hit.ts < REPO_DIR_TTL_MS) return hit.dir;
	const dir = findGitRepoDir(cwd);
	repoDirCache.set(cwd, { dir, ts: Date.now() });
	return dir;
}

const DIFF_STATS_TTL_MS = 2000;
let diffStatsCache: {
	repoDir: string;
	stats: Array<{ path: string; added: number; removed: number }> | null;
	ts: number;
} | null = null;

/** Drop cached diff stats (e.g. after a turn in which the agent edited files). */
function invalidateDiffStats(): void {
	diffStatsCache = null;
}

function getGitDiffStatsCached(
	repoDir: string,
): Array<{ path: string; added: number; removed: number }> | null {
	if (
		diffStatsCache &&
		diffStatsCache.repoDir === repoDir &&
		Date.now() - diffStatsCache.ts < DIFF_STATS_TTL_MS
	) {
		return diffStatsCache.stats;
	}
	const stats = getGitDiffStats(repoDir);
	diffStatsCache = { repoDir, stats, ts: Date.now() };
	return stats;
}

/** Get current thinking level from the API or fallback. */
function getCurrentThinkingLevel(pi: ExtensionAPI): string {
	try {
		return (pi as any).getThinkingLevel?.() ?? "off";
	} catch {
		return "off";
	}
}

/** Run git diff --numstat and return per-file stats. */
function runGitDiffNumstat(
	repoDir: string,
	extraArgs: string[],
): Array<{ path: string; added: number; removed: number }> | null {
	try {
		const result = spawnSync(
			"git",
			["-C", repoDir, "diff", "--numstat", ...extraArgs],
			{
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 5000,
			},
		);
		if (result.status !== 0) return null;
		return result.stdout
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => {
				const [added, removed, path] = line.split("\t");
				return {
					path,
					added: added === "-" ? 0 : parseInt(added, 10) || 0,
					removed: removed === "-" ? 0 : parseInt(removed, 10) || 0,
				};
			});
	} catch {
		return null;
	}
}

/** Collect all working-tree changes (unstaged + staged) per file. */
function getGitDiffStats(
	repoDir: string,
): Array<{ path: string; added: number; removed: number }> | null {
	const stats = new Map<string, { added: number; removed: number }>();

	const unstaged = runGitDiffNumstat(repoDir, []);
	if (!unstaged) return null;
	for (const { path, added, removed } of unstaged) {
		stats.set(path, { added, removed });
	}

	const staged = runGitDiffNumstat(repoDir, ["--cached"]);
	if (staged) {
		for (const { path, added, removed } of staged) {
			const existing = stats.get(path);
			if (existing) {
				existing.added += added;
				existing.removed += removed;
			} else {
				stats.set(path, { added, removed });
			}
		}
	}

	return Array.from(stats.entries())
		.map(([path, { added, removed }]) => ({ path, added, removed }))
		.filter(({ added, removed }) => added > 0 || removed > 0);
}

/** Render a small ASCII progress bar, tinted by the usage-threshold color. */
function renderProgressBar(
	percent: number,
	width: number,
	theme: Theme,
	color: string = "success",
): string {
	const w = Math.max(4, width);
	const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * w);
	const empty = w - filled;
	return theme.fg(color, "█".repeat(filled)) + theme.fg("dim", "░".repeat(empty));
}

/** Join `left` and `right` with `sep`, keeping the right side immediately after the separator (not pushed to the terminal edge). Truncates left on overflow. */
function joinWithSeparator(
	left: string,
	right: string,
	sep: string,
	width: number,
): string {
	const sepW = visibleWidth(sep);
	const available = width - sepW;

	// Reserve space for the right side; truncate it only if it barely fits
	let rightW = visibleWidth(right);
	if (rightW > available - 3) {
		right = truncateToWidth(right, Math.max(3, available - 3));
		rightW = visibleWidth(right);
	}

	// Truncate left side if needed, then join
	const leftMax = available - rightW;
	let leftW = visibleWidth(left);
	if (leftW > leftMax) {
		left = truncateToWidth(left, Math.max(3, leftMax));
		leftW = visibleWidth(left);
	}

	return left + sep + right;
}

/** Pick the thinking-level color from the active theme. */
function thinkingColor(level: string): string {
	switch (level) {
		case "off":
			return "thinkingOff";
		case "minimal":
			return "thinkingMinimal";
		case "low":
			return "thinkingLow";
		case "medium":
			return "thinkingMedium";
		case "high":
			return "thinkingHigh";
		case "xhigh":
			return "thinkingXhigh";
		case "max":
			return "thinkingMax";
		default:
			return "thinkingOff";
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Line renderers
// ─────────────────────────────────────────────────────────────────────────────

function renderLine1(
	width: number,
	theme: Theme,
	ctx: ExtensionContext,
	footerData: ReadonlyFooterDataProvider,
	thinkingLevel: string,
): string {
	const repoDir = findGitRepoDirCached(ctx.cwd);
	let left: string;

	if (repoDir) {
		const repoName = basename(repoDir);
		const branch = footerData.getGitBranch() || "none";
		// Repo is the subject of the line: cool cyan + bold. The model keeps
		// accent purple as the single warm focal hue.
		left = `${theme.bold(theme.fg("mdLink", repoName))} ${theme.fg("muted", `git:(${branch})`)}`;
	} else {
		left = theme.bold(theme.fg("mdLink", shortenPath(ctx.cwd)));
	}

	const modelId = ctx.model?.id ?? "unknown";
	const right = `${theme.fg("accent", `[${modelId}]`)} ${theme.fg(thinkingColor(thinkingLevel), thinkingLevel)}`;
	const sep = theme.fg("dim", " | ");

	return joinWithSeparator(left, right, sep, width);
}

function renderLine2(
	width: number,
	theme: Theme,
	ctx: ExtensionContext,
	footerData: ReadonlyFooterDataProvider,
): string {
	const usage = ctx.getContextUsage();
	let left: string;

	if (usage && usage.percent !== null) {
		const pct = usage.percent;
		const color = pct > 80 ? "error" : pct > 50 ? "warning" : "success";
		const pctText = `${pct.toFixed(0)}%`;
		const tokensText =
			usage.tokens !== null ? `${(usage.tokens / 1000).toFixed(1)}k` : "—";
		const barWidth = Math.max(4, Math.min(14, Math.floor(width * 0.15)));
		const bar = renderProgressBar(pct, barWidth, theme, color);
		left = `${bar} ${theme.fg(color, pctText)} ${theme.fg("dim", `(${tokensText})`)}`;
	} else {
		left = theme.fg("dim", "—");
	}

	const statuses = footerData.getExtensionStatuses();
	const right = statuses.get("permission-mode") ?? theme.fg("dim", "—");
	const sep = theme.fg("dim", " | ");

	return joinWithSeparator(left, right, sep, width);
}

function renderLine3(
	width: number,
	theme: Theme,
	ctx: ExtensionContext,
): string[] {
	const repoDir = findGitRepoDirCached(ctx.cwd);
	if (!repoDir) return [];

	const stats = getGitDiffStatsCached(repoDir);
	if (!stats || stats.length === 0) return [];

	const entries = stats.map(({ path, added, removed }) => {
		const addedStr = added > 0 ? theme.fg("success", `+${added}`) : "";
		const removedStr = removed > 0 ? theme.fg("error", `-${removed}`) : "";
		const sep = addedStr && removedStr ? theme.fg("dim", "|") : "";
		const changes = `${addedStr}${sep}${removedStr}` || theme.fg("dim", "0");
		// Paths are structure, not focus — muted lets the +/- counts pop.
		return `${theme.fg("muted", path)} ${changes}`;
	});

	// Wrap entries across lines at entry boundaries instead of truncating.
	// A single entry wider than the terminal is truncated as a last resort.
	const sep = theme.fg("dim", "  ");
	const sepW = visibleWidth("  ");
	const lines: string[] = [];
	let current = "";
	let currentW = 0;

	for (const entry of entries) {
		const entryW = visibleWidth(entry);
		const fits = currentW + (current ? sepW : 0) + entryW <= width;
		if (current && !fits) {
			lines.push(current);
			current = "";
			currentW = 0;
		}
		if (!current) {
			current = entryW > width ? truncateToWidth(entry, width) : entry;
			currentW = Math.min(entryW, width);
		} else {
			current += sep + entry;
			currentW += sepW + entryW;
		}
	}
	if (current) lines.push(current);

	// Cap at 3 lines; if entries overflow, append an ellipsis plus an overall
	// summary (total changed files and summed +/-) to the last line.
	const MAX_DIFF_LINES = 3;
	if (lines.length > MAX_DIFF_LINES) {
		const totalAdded = stats.reduce((sum, s) => sum + s.added, 0);
		const totalRemoved = stats.reduce((sum, s) => sum + s.removed, 0);
		const summary =
			theme.fg("dim", ` ... (${stats.length} files) `) +
			theme.fg("success", `+${totalAdded}`) +
			theme.fg("dim", "|") +
			theme.fg("error", `-${totalRemoved}`);
		const summaryW = visibleWidth(` ... (${stats.length} files) +${totalAdded}|-${totalRemoved}`);
		const kept = lines.slice(0, MAX_DIFF_LINES);
		const lastIndex = MAX_DIFF_LINES - 1;
		if (visibleWidth(kept[lastIndex]) + summaryW > width) {
			kept[lastIndex] = truncateToWidth(kept[lastIndex], Math.max(3, width - summaryW));
		}
		kept[lastIndex] += summary;
		return kept;
	}

	return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension entry
// ─────────────────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let requestRender: (() => void) | undefined;
	let currentThinkingLevel = getCurrentThinkingLevel(pi);

	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;

		currentThinkingLevel = getCurrentThinkingLevel(pi);

		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();

			const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: () => {
					unsubBranch();
					requestRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const lines: string[] = [];
					const line1 = renderLine1(
						width,
						theme,
						ctx,
						footerData,
						currentThinkingLevel,
					);
					const line2 = renderLine2(width, theme, ctx, footerData);
					lines.push(line1);
					lines.push(line2);
					lines.push(...renderLine3(width, theme, ctx));
					return lines;
				},
			};
		});
	});

	// Re-render triggers
	pi.on("thinking_level_select", (event) => {
		currentThinkingLevel = (event as any).level ?? "off";
		requestRender?.();
	});

	pi.on("turn_end", () => {
		// The agent likely edited files this turn — refresh stats on next render.
		invalidateDiffStats();
		requestRender?.();
	});
	pi.on("message_end", () => requestRender?.());
	pi.on("model_select", () => requestRender?.());
	pi.on("session_tree", () => requestRender?.());
	pi.on("session_compact", () => requestRender?.());

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		ctx.ui.setFooter(undefined);
	});
}
