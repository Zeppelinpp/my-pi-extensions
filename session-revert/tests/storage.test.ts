/**
 * tests/storage.test.ts — zero-framework tests for the storage layer.
 * Run: node tests/storage.test.ts   (Node >= 23, type stripping)
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_CHANGES,
  MAX_REDO,
  clearRedo,
  deleteFileAndCleanDirs,
  getSnapshotDir,
  isPathWithin,
  loadChanges,
  loadRedoStack,
  popRedo,
  pushRedo,
  restoreSnapshotFile,
  saveChange,
  snapshotFile,
  snapshotForRedo,
  type RedoEntry,
} from "../storage.ts";
import type { ChangeRecord } from "../core.ts";

// -- helpers --

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Fresh temp snapshots dir per case (internals resolve env per call). */
async function freshDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "session-revert-test-"));
  process.env.PI_SNAPSHOTS_DIR = dir;
  return dir;
}

type TestFn = () => Promise<void>;
const tests: [string, TestFn][] = [];
const test = (name: string, fn: TestFn) => tests.push([name, fn]);

const SID = "sess-1";

function makeRecord(n: number): ChangeRecord {
  return {
    entryId: `e${n}`,
    toolCallId: `tc${n}`,
    toolName: "write",
    snapshotId: `snap-${n}`,
    cwd: "/tmp/work",
    files: [{ path: `f${n}.txt`, absPath: `/tmp/work/f${n}.txt`, created: false }],
    createdAt: n,
  };
}

function makeRedo(n: number): RedoEntry {
  return {
    previousLeafId: `leaf-${n}`,
    targetId: `target-${n}`,
    cwd: "/tmp/work",
    snapshotId: `redo-${n}`,
    files: [{ path: "a.txt", absPath: "/tmp/work/a.txt", existed: true }],
    createdAt: n,
  };
}

// -- path containment --

test("isPathWithin: accepts real descendants, including names beginning with two dots", async () => {
  const dir = await freshDir();
  assert.equal(isPathWithin(dir, join(dir, "child", "file.txt")), true);
  assert.equal(isPathWithin(dir, join(dir, "..cache", "file.txt")), true);
  assert.equal(isPathWithin(dir, join(dir, "..", "sibling", "file.txt")), false);
});

if (process.platform === "win32") {
  test("isPathWithin: rejects a different Windows drive", async () => {
    assert.equal(isPathWithin("C:\\work", "D:\\other\\file.txt"), false);
  });
}

// -- snapshotFile / restoreSnapshotFile --

test("snapshotFile: text file → created:false, content matches", async () => {
  const dir = await freshDir();
  const src = join(dir, "src.txt");
  await writeFile(src, "hello world", "utf8");

  const r = await snapshotFile(src, SID, "s1", "sub/src.txt");
  assert.deepEqual(r, { created: false });

  const snap = join(getSnapshotDir(SID, "s1"), "sub/src.txt");
  assert.equal(await readFile(snap, "utf8"), "hello world");
});

test("snapshotFile/restore: binary roundtrip is byte-identical", async () => {
  const dir = await freshDir();
  const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const src = join(dir, "bin.dat");
  await writeFile(src, bytes);

  const r = await snapshotFile(src, SID, "s2", "bin.dat");
  assert.equal(r.created, false);

  const dst = join(dir, "restored.dat");
  await restoreSnapshotFile(SID, "s2", "bin.dat", dst);
  assert.deepEqual(await readFile(dst), bytes);
});

test("snapshotFile: missing source (ENOENT) → created:true", async () => {
  await freshDir();
  const r = await snapshotFile("/nonexistent/nope.txt", SID, "s3", "nope.txt");
  assert.deepEqual(r, { created: true });
});

test("snapshotFile: directory source → created:false + unrestorable:true", async () => {
  const dir = await freshDir();
  const srcDir = join(dir, "adir");
  await mkdir(srcDir);

  const r = await snapshotFile(srcDir, SID, "s4", "adir");
  assert.equal(r.created, false, "must never report created on non-ENOENT errors");
  assert.equal(r.unrestorable, true);
});

// -- saveChange: prune + orphan cleanup + redo invalidation --

test("saveChange: prunes to 100, deletes orphan snapshot dirs, keeps referenced", async () => {
  const dir = await freshDir();
  const sessionDir = join(dir, SID);

  // Mirror real usage: snapshot dir is created just before its record is saved
  // (tool_call snapshots, tool_result records).
  for (let n = 1; n <= 105; n++) {
    if ([1, 2, 3, 4, 5, 6, 50, 105].includes(n)) {
      await mkdir(join(sessionDir, `snap-${n}`), { recursive: true });
    }
    await saveChange(SID, makeRecord(n));
  }

  const changes = await loadChanges(SID);
  assert.equal(changes.length, MAX_CHANGES);
  assert.equal(changes[0]!.entryId, "e6", "oldest 5 records pruned");
  assert.equal(changes[changes.length - 1]!.entryId, "e105");

  // Dirs of pruned records are gone
  for (const n of [1, 2, 3, 4, 5]) {
    assert.equal(await exists(join(sessionDir, `snap-${n}`)), false, `snap-${n} should be deleted`);
  }
  // Referenced dirs survive
  for (const n of [6, 50, 105]) {
    assert.equal(await exists(join(sessionDir, `snap-${n}`)), true, `snap-${n} should survive`);
  }
  // Sidecar survives
  assert.equal(await exists(join(sessionDir, "changes.jsonl")), true);
});

test("saveChange: concurrent saves are serialized — no lost records, no orphan-deleted dirs", async () => {
  const dir = await freshDir();
  const sessionDir = join(dir, SID);

  const N = MAX_CHANGES + 10;
  for (let n = 1; n <= N; n++) {
    await mkdir(join(sessionDir, `snap-${n}`), { recursive: true });
  }
  // Mirror production: snapshots n..N already exist on disk but have no
  // ledger record yet (tool_call ran, tool_result pending), so each save
  // protects the still-unsaved snapshots — same as index.ts does.
  await Promise.all(
    Array.from({ length: N }, (_, i) => {
      const n = i + 1;
      const pendingSnaps = new Set<string>();
      for (let k = n; k <= N; k++) pendingSnaps.add(`snap-${k}`);
      return saveChange(SID, makeRecord(n), pendingSnaps);
    }),
  );

  const changes = await loadChanges(SID);
  assert.equal(changes.length, MAX_CHANGES, "no record lost or duplicated under concurrency");
  assert.deepEqual(
    changes.map((c) => c.entryId),
    Array.from({ length: MAX_CHANGES }, (_, i) => `e${i + 11}`),
    "kept records are the newest, in append order",
  );
  // Kept records' snapshot dirs survive; only pruned ones are gone.
  assert.equal(await exists(join(sessionDir, "snap-1")), false);
  assert.equal(await exists(join(sessionDir, `snap-${N}`)), true);
});

test("saveChange: clears the redo stack", async () => {
  const dir = await freshDir();
  const sessionDir = join(dir, SID);
  await mkdir(join(sessionDir, "redo-1"), { recursive: true });
  await pushRedo(SID, makeRedo(1));
  assert.equal((await loadRedoStack(SID)).length, 1);

  await saveChange(SID, makeRecord(1));

  assert.deepEqual(await loadRedoStack(SID), []);
  assert.equal(await exists(join(sessionDir, "redo-1")), false, "redo snapshot dir removed");
});

// -- redo stack --

test("redo: pop is LIFO and deletes snapshot dirs; empty pop → null", async () => {
  const dir = await freshDir();
  const sessionDir = join(dir, SID);
  for (const n of [1, 2, 3]) {
    await mkdir(join(sessionDir, `redo-${n}`), { recursive: true });
    await pushRedo(SID, makeRedo(n));
  }

  const e3 = await popRedo(SID);
  assert.equal(e3?.targetId, "target-3");
  assert.equal(await exists(join(sessionDir, "redo-3")), false);
  assert.equal(await exists(join(sessionDir, "redo-2")), true, "others untouched");

  const e2 = await popRedo(SID);
  const e1 = await popRedo(SID);
  assert.equal(e2?.targetId, "target-2");
  assert.equal(e1?.targetId, "target-1");
  assert.equal(await popRedo(SID), null);
});

test("redo: push beyond MAX_REDO evicts oldest and deletes its dir", async () => {
  const dir = await freshDir();
  const sessionDir = join(dir, SID);
  for (let n = 1; n <= MAX_REDO + 2; n++) {
    await mkdir(join(sessionDir, `redo-${n}`), { recursive: true });
    await pushRedo(SID, makeRedo(n));
  }

  const stack = await loadRedoStack(SID);
  assert.equal(stack.length, MAX_REDO);
  assert.equal(stack[0]!.targetId, "target-3", "oldest two evicted");
  assert.equal(await exists(join(sessionDir, "redo-1")), false);
  assert.equal(await exists(join(sessionDir, "redo-2")), false);
  assert.equal(await exists(join(sessionDir, "redo-3")), true);
});

test("clearRedo: removes redo.json and all redo-* dirs, keeps other dirs", async () => {
  const dir = await freshDir();
  const sessionDir = join(dir, SID);
  await mkdir(join(sessionDir, "redo-1"), { recursive: true });
  await mkdir(join(sessionDir, "redo-2"), { recursive: true });
  await mkdir(join(sessionDir, "snap-keep"), { recursive: true });
  await pushRedo(SID, makeRedo(1));
  await pushRedo(SID, makeRedo(2));

  await clearRedo(SID);

  assert.deepEqual(await loadRedoStack(SID), []);
  assert.equal(await exists(join(sessionDir, "redo.json")), false);
  assert.equal(await exists(join(sessionDir, "redo-1")), false);
  assert.equal(await exists(join(sessionDir, "redo-2")), false);
  assert.equal(await exists(join(sessionDir, "snap-keep")), true, "non-redo dirs untouched");
});

// -- snapshotForRedo --

test("snapshotForRedo: existed / missing / unrestorable branches", async () => {
  const dir = await freshDir();
  const workDir = join(dir, "work");
  await mkdir(join(workDir, "adir"), { recursive: true });
  const filePath = join(workDir, "a.txt");
  await writeFile(filePath, "content-A", "utf8");

  const files = await snapshotForRedo(SID, "redo-x", [
    { path: "a.txt", absPath: filePath },
    { path: "missing.txt", absPath: join(workDir, "missing.txt") },
    { path: "adir", absPath: join(workDir, "adir") },
  ]);

  assert.deepEqual(files[0], { path: "a.txt", absPath: filePath, existed: true });
  assert.deepEqual(files[1], {
    path: "missing.txt",
    absPath: join(workDir, "missing.txt"),
    existed: false,
  });
  assert.equal(files[2]!.existed, true);
  assert.equal(files[2]!.unrestorable, true);

  // Captured content is in the redo snapshot dir
  const snap = join(getSnapshotDir(SID, "redo-x"), "a.txt");
  assert.equal(await readFile(snap, "utf8"), "content-A");
});

// -- loadChanges robustness --

test("loadChanges: corrupt lines skipped, missing file → []", async () => {
  const dir = await freshDir();
  const sessionDir = join(dir, SID);
  await mkdir(sessionDir, { recursive: true });
  const good1 = JSON.stringify(makeRecord(1));
  const good2 = JSON.stringify(makeRecord(2));
  await writeFile(
    join(sessionDir, "changes.jsonl"),
    `${good1}\n{bad json\n\n   \n${good2}\n`,
    "utf8",
  );

  const changes = await loadChanges(SID);
  assert.equal(changes.length, 2);
  assert.equal(changes[0]!.entryId, "e1");
  assert.equal(changes[1]!.entryId, "e2");

  assert.deepEqual(await loadChanges("no-such-session"), []);
});

test("saveChange: protected snapshot dirs are not deleted during prune", async () => {
  const dir = await freshDir();
  const sessionDir = join(dir, SID);

  // Seed 100 records so the next saveChange triggers a prune.
  for (let n = 1; n <= 100; n++) {
    if (n === 1) await mkdir(join(sessionDir, `snap-${n}`), { recursive: true });
    await saveChange(SID, makeRecord(n));
  }

  // snap-1 is the oldest record; prune will drop it.  Mark it protected
  // (e.g. it belongs to another in-flight tool_call whose tool_result
  // has not yet fired).  It must survive orphan cleanup.
  await saveChange(SID, makeRecord(101), new Set(["snap-1"]));

  const changes = await loadChanges(SID);
  assert.equal(changes[0]!.entryId, "e2", "oldest record pruned");
  assert.equal(await exists(join(sessionDir, "snap-1")), true, "protected dir survives");
});

// -- deleteFileAndCleanDirs --

test("deleteFileAndCleanDirs: removes file and empty parents up to stopAt", async () => {
  const dir = await freshDir();
  const stopAt = join(dir, "work");
  const deep = join(stopAt, "a/b/c");
  await mkdir(deep, { recursive: true });
  const f = join(deep, "x.txt");
  await writeFile(f, "x", "utf8");

  await deleteFileAndCleanDirs(f, stopAt);

  assert.equal(await exists(f), false);
  assert.equal(await exists(join(stopAt, "a")), false, "empty parents cleaned");
  assert.equal(await exists(stopAt), true, "stopAt itself preserved");
});

test("deleteFileAndCleanDirs: does not clean sibling directories with common prefix", async () => {
  const dir = await freshDir();
  const stopAt = join(dir, "work");
  const sibling = join(dir, "work-extra");
  const deep = join(stopAt, "a/b/c");
  const siblingDeep = join(sibling, "x");
  await mkdir(deep, { recursive: true });
  await mkdir(siblingDeep, { recursive: true });
  const f = join(deep, "x.txt");
  await writeFile(f, "x", "utf8");

  await deleteFileAndCleanDirs(f, stopAt);

  assert.equal(await exists(f), false);
  assert.equal(await exists(join(stopAt, "a")), false, "empty parents cleaned");
  assert.equal(await exists(stopAt), true, "stopAt itself preserved");
  assert.equal(await exists(siblingDeep), true, "sibling dir with common prefix must survive");
});

test("deleteFileAndCleanDirs: cleans an in-tree directory beginning with two dots", async () => {
  const dir = await freshDir();
  const stopAt = join(dir, "work");
  const nested = join(stopAt, "..cache", "nested");
  await mkdir(nested, { recursive: true });
  const f = join(nested, "x.txt");
  await writeFile(f, "x", "utf8");

  await deleteFileAndCleanDirs(f, stopAt);

  assert.equal(await exists(join(stopAt, "..cache")), false);
  assert.equal(await exists(stopAt), true);
});

test("deleteFileAndCleanDirs: refuses to delete a directory", async () => {
  const dir = await freshDir();
  const stopAt = join(dir, "work");
  const d = join(stopAt, "a-dir");
  await mkdir(d, { recursive: true });

  await assert.rejects(deleteFileAndCleanDirs(d, stopAt));
  assert.equal(await exists(d), true, "directory must not be deleted");
});

// -- runner --

let passed = 0;
let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    passed++;
    console.log(`ok ${passed + failed} - ${name}`);
  } catch (err) {
    failed++;
    console.error(`not ok ${passed + failed} - ${name}`);
    console.error(err);
  }
}
console.log(`\n${passed} passed, ${failed} failed, ${tests.length} total`);
process.exit(failed > 0 ? 1 : 0);
