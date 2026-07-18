/**
 * tests/core.test.ts — core.ts 单测
 *
 * 零框架零依赖：裸 assert + 顺序执行。运行：node tests/core.test.ts
 */

import assert from "node:assert/strict";
import { buildTreeNodes, computeFilesToRevert } from "../core.ts";
import type { ChangeRecord } from "../core.ts";

function mkUser(id: string): any {
  return { id, type: "message", message: { role: "user", content: id } };
}
function mkAssistant(id: string): any {
  return { id, type: "message", message: { role: "assistant", content: id } };
}

function mkChange(
  entryId: string,
  toolCallId: string,
  toolName: string,
  snapshotId: string,
  files: { path: string; created?: boolean; unrestorable?: boolean }[],
  createdAt: number,
): ChangeRecord {
  return {
    entryId,
    toolCallId,
    toolName,
    snapshotId,
    cwd: "/repo",
    files: files.map((f) => ({
      path: f.path,
      absPath: `/repo/${f.path}`,
      created: f.created ?? false,
      ...(f.unrestorable ? { unrestorable: true } : {}),
    })),
    createdAt,
  };
}

// branch: 新的在前（leaf 在 index 0）
const leaf = mkAssistant("e-leaf");
const mid = mkAssistant("e-mid");
const root = mkUser("e-root");
const branch = [leaf, mid, root];

const changes: ChangeRecord[] = [
  // e-mid: 2 个工具调用，oldest first
  mkChange("e-mid", "tc-mid-1", "write", "s-mid-1", [{ path: "a.ts" }], 10),
  mkChange("e-mid", "tc-mid-2", "edit", "s-mid-2", [{ path: "a.ts" }], 20),
  // e-leaf: 1 个工具调用
  mkChange("e-leaf", "tc-leaf-1", "write", "s-leaf-1", [{ path: "b.ts", created: true }], 30),
];

function assertNodesOrder() {
  const nodes = buildTreeNodes(branch, changes);
  assert.equal(nodes.length, 6, "3 entries + 3 tool calls");
  // newest-first: e-leaf entry, then e-leaf's tool calls (only 1),
  // then e-mid entry, then e-mid's tool calls in reverse order (tc-mid-2, tc-mid-1),
  // then e-root entry
  assert.equal(nodes[0]!.entry.id, "e-leaf");
  assert.equal(nodes[1]!.entry.type, "tool_call");
  assert.equal(nodes[1]!.entry.toolCallId, "tc-leaf-1");
  assert.equal(nodes[2]!.entry.id, "e-mid");
  assert.equal(nodes[3]!.entry.type, "tool_call");
  assert.equal(nodes[3]!.entry.toolCallId, "tc-mid-2");
  assert.equal(nodes[4]!.entry.type, "tool_call");
  assert.equal(nodes[4]!.entry.toolCallId, "tc-mid-1");
  assert.equal(nodes[5]!.entry.id, "e-root");
  return nodes;
}

// 1. 节点顺序与类型
assert.doesNotThrow(() => {
  assertNodesOrder();
  console.log("ok 1 - buildTreeNodes: order is entry → tool_calls (newest-first) → older entry");
});

// 2. entry 节点的 filesAfter 只包含更新 entry 的 change
(() => {
  const nodes = assertNodesOrder();
  assert.equal(nodes[0]!.filesAfter.size, 0, "leaf entry: nothing newer");
  assert.equal(nodes[2]!.filesAfter.size, 1, "e-mid entry: e-leaf's b.ts");
  assert.equal(nodes[2]!.filesAfter.get("b.ts")!.snapshotId, "s-leaf-1");
  assert.equal(nodes[5]!.filesAfter.size, 2, "e-root entry: all newer changes");
  assert.equal(nodes[5]!.filesAfter.get("a.ts")!.snapshotId, "s-mid-1", "earliest wins");
  console.log("ok 2 - buildTreeNodes: entry nodes only see newer entries");
})();

// 3. tool_call 节点的 filesAfter 包含同一 entry 内更晚的工具调用
(() => {
  const nodes = assertNodesOrder();
  // tc-mid-2 (edit) 是 e-mid 内最晚的工具调用，其 filesAfter 只包含 e-leaf 的 change
  const mid2 = nodes.find((n) => n.entry.toolCallId === "tc-mid-2")!;
  assert.equal(mid2.filesAfter.size, 1);
  assert.equal(mid2.filesAfter.get("b.ts")!.snapshotId, "s-leaf-1");

  // tc-mid-1 (write) 是 e-mid 内最早的工具调用，其 filesAfter 包含 tc-mid-2 的 a.ts + e-leaf 的 b.ts
  const mid1 = nodes.find((n) => n.entry.toolCallId === "tc-mid-1")!;
  assert.equal(mid1.filesAfter.size, 2);
  assert.equal(mid1.filesAfter.get("a.ts")!.snapshotId, "s-mid-2");
  assert.equal(mid1.filesAfter.get("b.ts")!.snapshotId, "s-leaf-1");
  console.log("ok 3 - buildTreeNodes: tool_call nodes include later tool calls in same entry");
})();

// 4. computeFilesToRevert 直接返回目标节点的 filesAfter
(() => {
  const nodes = assertNodesOrder();
  const rootFiles = computeFilesToRevert(nodes, "e-root");
  assert.equal(rootFiles.size, 2);
  assert.equal(rootFiles.get("a.ts")!.snapshotId, "s-mid-1");
  assert.equal(rootFiles.get("b.ts")!.snapshotId, "s-leaf-1");

  const mid1Files = computeFilesToRevert(nodes, "tc-mid-1");
  assert.equal(mid1Files.size, 2);
  assert.equal(mid1Files.get("a.ts")!.snapshotId, "s-mid-2");

  const leafFiles = computeFilesToRevert(nodes, "e-leaf");
  assert.equal(leafFiles.size, 0);
  console.log("ok 4 - computeFilesToRevert: returns filesAfter of selected target");
})();

// 5. 同一文件多次 change 取最早快照
(() => {
  const files = computeFilesToRevert(buildTreeNodes(branch, changes), "e-root");
  assert.equal(files.get("a.ts")!.snapshotId, "s-mid-1");
  console.log("ok 5 - earliest snapshot wins per file");
})();

// 6. entryId 不在 branch 的 change 被忽略
(() => {
  const ghost: ChangeRecord[] = [
    mkChange("e-ghost", "tc-ghost", "write", "s-ghost", [{ path: "g.ts" }], 1),
  ];
  const nodes = buildTreeNodes(branch, ghost);
  assert.ok(nodes.every((n) => n.filesAfter.size === 0));
  assert.equal(computeFilesToRevert(nodes, "e-root").size, 0);
  console.log("ok 6 - ghost changes ignored");
})();

// 7. 旧格式记录兼容：storage 层会把缺 toolCallId/toolName/createdAt 的记录
//    规范化；core.ts 只负责消费规范后的记录。
(() => {
  const oldStyle: ChangeRecord = {
    entryId: "e-mid",
    toolCallId: "old-snap", // storage 会把它设为 snapshotId
    toolName: "write/edit",  // storage 会默认填充
    snapshotId: "old-snap",
    cwd: "/repo",
    files: [{ path: "a.ts", absPath: "/repo/a.ts", created: false }],
    createdAt: 0,
  };
  const nodes = buildTreeNodes(branch, [...changes, oldStyle]);
  const toolNode = nodes.find((n) => n.entry.type === "tool_call" && n.entry.toolCallId === "old-snap")!;
  assert.equal(toolNode.entry.toolName, "write/edit");
  // filesAfter 是否被正确计算：old-snap 是 e-mid 内最早的工具调用，
  // 它之后有 tc-mid-1，所以 a.ts 的快照应来自 tc-mid-1 (s-mid-1)
  assert.equal(computeFilesToRevert(nodes, toolNode.entry.id).get("a.ts")?.snapshotId, "s-mid-1");
  console.log("ok 7 - normalized old-format records compatible");
})();

// 8. created / unrestorable 透传
(() => {
  const c = mkChange("e-leaf", "tc-x", "write", "s-x", [{ path: "b.ts", created: true }], 1);
  const files = computeFilesToRevert(buildTreeNodes(branch, [c]), "e-root");
  assert.equal(files.get("b.ts")!.created, true);

  const c2 = mkChange("e-mid", "tc-y", "edit", "s-y", [{ path: "a.ts", unrestorable: true }], 1);
  const files2 = computeFilesToRevert(buildTreeNodes(branch, [c2]), "e-root");
  assert.equal(files2.get("a.ts")!.unrestorable, true);
  console.log("ok 8 - created and unrestorable propagated");
})();

// 9. 脏数据容错
(() => {
  const weirdBranch = [{ type: "session" }, mkUser("e1")];
  const weirdChanges = [
    { snapshotId: "x", cwd: "/r", files: [{ path: "f", absPath: "/r/f", created: false }] },
    null,
    { entryId: "e1", toolCallId: "tc", toolName: "write", snapshotId: "y", cwd: "/r", files: [null, { created: true }], createdAt: 1 },
  ] as any;

  assert.doesNotThrow(() => {
    const nodes = buildTreeNodes(weirdBranch, weirdChanges);
    assert.equal(nodes.length, 3, "2 entries + 1 tool call node");
    computeFilesToRevert(nodes, "e1");
  });
  assert.equal(buildTreeNodes([], []).length, 0);
  assert.equal(computeFilesToRevert([], [], "x").size, 0);
  assert.doesNotThrow(() => buildTreeNodes(null as any, undefined as any));
  console.log("ok 9 - dirty data tolerance");
})();

console.log("\n9 passed, 0 failed");
process.exit(0);
