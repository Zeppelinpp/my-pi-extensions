/**
 * core.ts — session-revert 纯逻辑核心
 *
 * 零依赖：禁止 import 任何 pi 包或 node 内置模块。
 * 只用可擦除 TS 语法（无 enum/namespace/参数属性），Node 26 可直接 `node file.ts` 运行。
 *
 * 语义：
 *   每个 write/edit 工具调用产生一条 ChangeRecord，由 `toolCallId` 唯一标识，
 *   挂在它所属的 assistant message（entryId）下。
 *   branch 为会话 entry 数组，新的在前（index 0 = leaf）。
 *   buildTreeNodes 返回的节点列表包含三类目标：
 *     - 每个 branch entry 节点（代表该 entry 之后的状态）
 *     - 每个 entry 下属的 write/edit 工具调用节点（代表该工具调用之前的状态）
 *   同一 entry 内的工具调用按 createdAt 升序；节点列表 newest-first，
 *   因此 entry 节点排在最前，其工具调用节点按逆序排列。
 */

export interface FileSnapshot {
  path: string; // 相对 cwd
  absPath: string;
  created: boolean; // true = 工具写入前文件不存在（revert 时应删除）
  unrestorable?: boolean; // true = 快照失败（如权限问题），restore 时跳过
}

export interface ChangeRecord {
  entryId: string; // 父 assistant message 的 entry id
  toolCallId: string; // 该工具调用的唯一 id
  toolName: string; // 工具名，如 "write" / "edit"
  snapshotId: string;
  cwd: string;
  files: FileSnapshot[];
  createdAt: number; // tool_result 时间戳，用于同一 entry 内排序
}

export interface FileAction {
  snapshotId: string;
  absPath: string;
  cwd: string;
  created: boolean;
  unrestorable?: boolean;
}

export type FileToRevert = FileAction;

export interface TreeNode {
  entry: any;
  filesAfter: Map<string, FileAction>;
}

/** entryId → branch index。缺 id / 重复 id 的 entry 容错（重复取先出现者）。 */
function buildBranchIndex(branch: any[]): Map<string, number> {
  const index = new Map<string, number>();
  if (!Array.isArray(branch)) return index;
  for (let i = 0; i < branch.length; i++) {
    const id = branch[i]?.id;
    if (typeof id === "string" && !index.has(id)) index.set(id, i);
  }
  return index;
}

/**
 * 一条 change 按 path 去重后的文件动作（同 change 内 jsonl 先出现者 wins）。
 * snapshotId / cwd 取自 change 记录本身。
 */
function changeActions(change: ChangeRecord): Array<[string, FileAction]> {
  const out = new Map<string, FileAction>();
  for (const f of change.files ?? []) {
    if (!f || typeof f.path !== "string") continue;
    if (out.has(f.path)) continue;
    out.set(f.path, {
      snapshotId: change.snapshotId,
      absPath: f.absPath,
      cwd: change.cwd,
      created: !!f.created,
      ...(f.unrestorable ? { unrestorable: true } : {}),
    });
  }
  return [...out.entries()];
}

/**
 * 构建 revert 目标节点列表。
 * 对 branch 中每个 entry：
 *   1. 先放入 entry 节点（filesAfter = 已累积的、来自更新 entry 的 change）
 *   2. 再放入该 entry 的 write/edit 工具调用节点，按 newest-first 排列
 *      （filesAfter = 已累积的更新 entry change + 同一 entry 内更晚的工具调用）
 *   3. 最后把该 entry 自身的所有 change 合并进累积态，供更老的 entry 使用
 */
export function buildTreeNodes(branch: any[], changes: ChangeRecord[]): TreeNode[] {
  const entries = Array.isArray(branch) ? branch : [];
  const indexOf = buildBranchIndex(entries);

  // 按 entryId 分组，同一 entry 内按 createdAt 升序（ oldest first ）
  const toolsByEntry = new Map<string, ChangeRecord[]>();
  for (const change of changes ?? []) {
    if (!change) continue;
    const idx = indexOf.get(change.entryId);
    if (idx === undefined) continue;
    const list = toolsByEntry.get(change.entryId) ?? [];
    list.push(change);
    toolsByEntry.set(change.entryId, list);
  }
  for (const list of toolsByEntry.values()) {
    list.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  }

  const nodes: TreeNode[] = [];
  const acc = new Map<string, FileAction>(); // 来自比当前 entry 更新的 entry 的 change

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const entryTools = toolsByEntry.get(entry?.id) ?? [];

    // 1) entry 节点：状态 = 该 entry 所有工具调用完成后
    nodes.push({ entry, filesAfter: new Map(acc) });

    // 2) 工具调用节点，newest-first
    for (let j = entryTools.length - 1; j >= 0; j--) {
      const change = entryTools[j];
      const beforeThisTool = new Map(acc);
      // 同一 entry 内，该工具调用之后的工具调用也要 revert；
      // 从 newest 向 oldest 迭代，让 oldest 覆盖 newest，实现「最早快照 wins」
      for (let k = entryTools.length - 1; k > j; k--) {
        for (const [path, action] of changeActions(entryTools[k])) {
          beforeThisTool.set(path, action);
        }
      }
      nodes.push({
        entry: {
          type: "tool_call",
          id: change.toolCallId,
          entryId: change.entryId,
          toolName: change.toolName,
          toolCallId: change.toolCallId,
          path: change.files[0]?.path,
        },
        filesAfter: beforeThisTool,
      });
    }

    // 3) 将该 entry 自身的 change 合并进 acc（oldest 覆盖 newest，实现「最早快照 wins」）
    for (let j = entryTools.length - 1; j >= 0; j--) {
      for (const [path, action] of changeActions(entryTools[j])) {
        acc.set(path, action);
      }
    }
  }

  return nodes;
}

/** 给定节点 id，返回需要恢复的文件集合（即该节点的 filesAfter）。 */
export function computeFilesToRevert(
  nodes: TreeNode[],
  targetId: string,
): Map<string, FileToRevert> {
  const node = nodes.find((n) => n.entry?.id === targetId);
  if (!node) return new Map();
  return new Map(node.filesAfter);
}
