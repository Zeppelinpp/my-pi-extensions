/**
 * session-revert — storage layer
 *
 * File-copy snapshots under SNAPSHOTS_DIR/<sessionId>/:
 *   changes.jsonl          — append-only ledger of ChangeRecord (pruned to MAX_CHANGES)
 *   redo.json              — redo stack (JSON array, top at end, capped at MAX_REDO)
 *   <snapshotId>/<relPath> — snapshot copies of tracked files
 *   redo-<ts>/<relPath>    — redo snapshots (pre-revert disk state)
 *
 * Zero pi dependency. Erasable TS syntax only (Node >= 23 runs this directly).
 */

import {
  appendFile,
  copyFile,
  mkdir,
  readFile,
  readdir,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { homedir } from "node:os";
import type { ChangeRecord } from "./core.js";

const DEFAULT_DIR = join(homedir(), ".pi", "agent", "snapshots");

/**
 * Resolved dynamically per call so tests can switch PI_SNAPSHOTS_DIR
 * between cases without re-importing the module.
 */
function baseDir(): string {
  return process.env.PI_SNAPSHOTS_DIR || DEFAULT_DIR;
}

/** Default snapshots location (resolved at module load; informational). */
export const SNAPSHOTS_DIR: string = baseDir();

/** Max change records kept per session; oldest are pruned beyond this. */
export const MAX_CHANGES = 100;

/** Max redo stack entries kept per session. */
export const MAX_REDO = 20;

export function getSidecarPath(sessionId: string): string {
  return join(baseDir(), sessionId, "changes.jsonl");
}

export function getSnapshotDir(sessionId: string, snapshotId: string): string {
  return join(baseDir(), sessionId, snapshotId);
}

function getRedoPath(sessionId: string): string {
  return join(baseDir(), sessionId, "redo.json");
}

// -- Snapshots --

/**
 * Copy a file's current content into the snapshot store (binary-safe).
 *
 * Critical semantics (data-loss fix):
 *   ENOENT (source missing) → { created: true }      — revert will delete the file
 *   success                 → { created: false }     — revert will restore the copy
 *   any other error         → { created: false, unrestorable: true }
 *                             NEVER report created here: a read failure on an
 *                             existing file must not cause revert to delete it.
 */
export async function snapshotFile(
  absPath: string,
  sessionId: string,
  snapshotId: string,
  relPath: string,
): Promise<{ created: boolean; unrestorable?: boolean }> {
  const snapPath = join(getSnapshotDir(sessionId, snapshotId), relPath);
  try {
    await mkdir(dirname(snapPath), { recursive: true });
    await copyFile(absPath, snapPath);
    return { created: false };
  } catch (err: any) {
    if (err?.code === "ENOENT") return { created: true };
    return { created: false, unrestorable: true };
  }
}

/** Write a snapshot back to absPath (creates parent dirs). */
export async function restoreSnapshotFile(
  sessionId: string,
  snapshotId: string,
  relPath: string,
  absPath: string,
): Promise<void> {
  const snapPath = join(getSnapshotDir(sessionId, snapshotId), relPath);
  await mkdir(dirname(absPath), { recursive: true });
  await copyFile(snapPath, absPath);
}

/** Delete a file, then remove now-empty parent directories up to (excluding) stopAt. */
export async function deleteFileAndCleanDirs(absPath: string, stopAt: string): Promise<void> {
  try {
    await unlink(absPath);
  } catch (err: any) {
    if (err?.code !== "ENOENT") throw err;
  }
  await cleanupEmptyDirs(dirname(absPath), stopAt);
}

async function cleanupEmptyDirs(dir: string, stopAt: string): Promise<void> {
  const rel = relative(stopAt, dir);
  if (rel === "" || rel.startsWith("..")) return;
  try {
    await rmdir(dir);
    await cleanupEmptyDirs(dirname(dir), stopAt);
  } catch {
    // Directory not empty or other error — stop cleaning
  }
}

// -- Change ledger --

/** Load change records. Missing file or corrupt lines are skipped, never thrown. */
export async function loadChanges(sessionId: string): Promise<ChangeRecord[]> {
  let content: string;
  try {
    content = await readFile(getSidecarPath(sessionId), "utf8");
  } catch {
    return [];
  }
  const out: ChangeRecord[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as ChangeRecord;
      // 兼容旧格式：旧记录没有 toolCallId/toolName/createdAt
      if (typeof record.toolCallId !== "string") {
        record.toolCallId = record.snapshotId;
      }
      if (typeof record.toolName !== "string") {
        record.toolName = "write/edit";
      }
      if (typeof record.createdAt !== "number") {
        record.createdAt = 0;
      }
      out.push(record);
    } catch {
      // Skip corrupt line
    }
  }
  return out;
}

/**
 * Append a change record, then prune to MAX_CHANGES:
 *  - rewrite the jsonl keeping the newest MAX_CHANGES records
 *  - delete snapshot directories no longer referenced by any remaining
 *    record or by the redo stack
 *
 * Side effect: a new tracked change invalidates the redo future, so the
 * redo stack is cleared BEFORE appending.
 */
export async function saveChange(
  sessionId: string,
  record: ChangeRecord,
  protectedSnapshotIds?: Set<string>,
): Promise<void> {
  await clearRedo(sessionId);

  const sidecar = getSidecarPath(sessionId);
  await mkdir(dirname(sidecar), { recursive: true });
  await appendFile(sidecar, JSON.stringify(record) + "\n", "utf8");

  const changes = await loadChanges(sessionId);
  if (changes.length <= MAX_CHANGES) return;

  const kept = changes.slice(changes.length - MAX_CHANGES);
  await writeFile(sidecar, kept.map((c) => JSON.stringify(c)).join("\n") + "\n", "utf8");

  const referenced = new Set<string>();
  for (const c of kept) referenced.add(c.snapshotId);
  for (const r of await loadRedoStack(sessionId)) referenced.add(r.snapshotId);

  const sessionDir = dirname(sidecar);
  let entries;
  try {
    entries = await readdir(sessionDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue; // changes.jsonl / redo.json stay
    if (referenced.has(e.name)) continue;
    if (protectedSnapshotIds?.has(e.name)) continue;
    await rm(join(sessionDir, e.name), { recursive: true, force: true }).catch(() => {});
  }
}

// -- Redo stack --

export interface RedoEntry {
  /** Leaf before the revert — undo navigates back here. */
  previousLeafId: string;
  /** Entry the revert targeted. */
  targetId: string;
  cwd: string;
  /** Redo snapshot dir name (e.g. "redo-<ts>"). */
  snapshotId: string;
  /**
   * Pre-revert disk state per file.
   * existed=false → the file did not exist before revert → undo deletes it.
   * unrestorable=true → capture failed → undo skips it with a warning.
   */
  files: { path: string; absPath: string; existed: boolean; unrestorable?: boolean }[];
  createdAt: number;
}

export async function loadRedoStack(sessionId: string): Promise<RedoEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(getRedoPath(sessionId), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeRedoStack(sessionId: string, stack: RedoEntry[]): Promise<void> {
  const p = getRedoPath(sessionId);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(stack), "utf8");
}

/** Push an entry; evict the oldest (and its snapshot dir) beyond MAX_REDO. */
export async function pushRedo(sessionId: string, entry: RedoEntry): Promise<void> {
  const stack = await loadRedoStack(sessionId);
  stack.push(entry);
  while (stack.length > MAX_REDO) {
    const oldest = stack.shift()!;
    await rm(getSnapshotDir(sessionId, oldest.snapshotId), { recursive: true, force: true }).catch(
      () => {},
    );
  }
  await writeRedoStack(sessionId, stack);
}

/**
 * Pop the top entry and delete its redo snapshot dir.
 *
 * Consumer flow: peek via loadRedoStack → restore files from the top entry's
 * snapshot → popRedo to commit. (Pop deletes the snapshot, so restoring
 * after pop is not possible.)
 */
export async function popRedo(sessionId: string): Promise<RedoEntry | null> {
  const stack = await loadRedoStack(sessionId);
  const entry = stack.pop();
  if (!entry) return null;
  await writeRedoStack(sessionId, stack);
  await rm(getSnapshotDir(sessionId, entry.snapshotId), { recursive: true, force: true }).catch(
    () => {},
  );
  return entry;
}

/** Delete redo.json and all redo-* snapshot directories. */
export async function clearRedo(sessionId: string): Promise<void> {
  const sessionDir = join(baseDir(), sessionId);
  await rm(getRedoPath(sessionId), { force: true }).catch(() => {});
  let entries;
  try {
    entries = await readdir(sessionDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory() && e.name.startsWith("redo-")) {
      await rm(join(sessionDir, e.name), { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * Capture the current disk state of files for a later undo.
 *   copy success → { path, absPath, existed: true }
 *   ENOENT       → { path, absPath, existed: false }  (undo deletes the file)
 *   other error  → { path, absPath, existed: true, unrestorable: true }
 */
export async function snapshotForRedo(
  sessionId: string,
  snapshotId: string,
  files: { path: string; absPath: string }[],
): Promise<RedoEntry["files"]> {
  const out: RedoEntry["files"] = [];
  for (const f of files) {
    const snapPath = join(getSnapshotDir(sessionId, snapshotId), f.path);
    try {
      await mkdir(dirname(snapPath), { recursive: true });
      await copyFile(f.absPath, snapPath);
      out.push({ path: f.path, absPath: f.absPath, existed: true });
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        out.push({ path: f.path, absPath: f.absPath, existed: false });
      } else {
        out.push({ path: f.path, absPath: f.absPath, existed: true, unrestorable: true });
      }
    }
  }
  return out;
}
