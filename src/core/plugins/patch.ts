/**
 * Patch 机制：插件配置的声明与合并。
 *
 * 设计取自 DSH 的分层配置思想：
 *   - 每个 Bundle 提供一个 `patch`（声明它包含哪些插件行）；
 *   - 多个 Bundle 的 patch 按顺序叠加到「基础配置」上；
 *   - 合并支持三种操作：replace（按 id 替换整行）、insert（插入新行）、remove（删除）。
 *
 * 这样用户可以写一份自己的 patch 覆盖默认值，而无需改动 Bundle 本身。
 */

/** 单个插件行的配置。 */
export interface PluginRow {
  /** 唯一 id，用于定位与热更新。 */
  id: string;
  /** 插件模块的导入说明符（包名或相对 patch 文件的路径）。 */
  module: string;
  /** 可读名称。 */
  name?: string;
  /** 版本。 */
  version?: string;
  /** 是否启用，默认 true。 */
  enabled?: boolean;
  /** 传给插件 apply 的任意配置。 */
  config?: Record<string, unknown>;
}

/** Patch 操作。 */
export interface PatchOperation {
  /** 操作类型；省略时按 replace 处理。 */
  op?: "replace" | "insert" | "remove";
  /** 目标行（remove 可只给 id）。 */
  row?: PluginRow;
  /** remove 时的目标 id。 */
  id?: string;
}

/** 一份 patch 文件的结构。 */
export interface PatchFile {
  /** patch 自身标识，便于排错。 */
  name?: string;
  /** 声明本 patch 依赖的其它 patch（暂做记录用途）。 */
  extends?: string[];
  /** 操作列表，按顺序应用。 */
  operations: PatchOperation[];
}

/** 合并结果。 */
export interface MergeResult {
  rows: PluginRow[];
  /** 合并过程中的告警（例如插入了已存在的 id）。 */
  warnings: string[];
}

/**
 * 把一份 patch 应用到已有的行列表上。
 *
 * 规则：
 *   - replace：按 id 找到旧行则整体替换，找不到则视为插入；
 *   - insert：总是插入；若 id 已存在则先移除旧的（幂等），并记录告警；
 *   - remove：按 id 删除，不存在则忽略。
 *
 * 返回新数组，不修改入参（便于热更新时对比前后差异）。
 */
export function applyPatch(base: PluginRow[], patch: PatchFile): MergeResult {
  const rows = base.map((r) => ({ ...r }));
  const warnings: string[] = [];

  for (const op of patch.operations ?? []) {
    const kind = op.op ?? "replace";

    if (kind === "remove") {
      const id = op.id ?? op.row?.id;
      if (!id) {
        warnings.push("remove 操作缺少 id，已忽略");
        continue;
      }
      const idx = rows.findIndex((r) => r.id === id);
      if (idx >= 0) rows.splice(idx, 1);
      continue;
    }

    const row = op.row;
    if (!row?.id || !row.module) {
      warnings.push(`${kind} 操作缺少 row.id 或 row.module，已忽略`);
      continue;
    }

    const idx = rows.findIndex((r) => r.id === row.id);

    if (kind === "insert") {
      if (idx >= 0) {
        warnings.push(`insert 的 id "${row.id}" 已存在，按替换处理`);
        rows[idx] = { ...row };
      } else {
        rows.push({ ...row });
      }
      continue;
    }

    // replace
    if (idx >= 0) {
      rows[idx] = { ...row };
    } else {
      rows.push({ ...row });
    }
  }

  return { rows, warnings };
}

/** 校验 patch 文件结构（用于加载时给出清晰报错）。 */
export function validatePatch(raw: unknown): PatchFile {
  if (!raw || typeof raw !== "object") {
    throw new Error("patch 必须是对象");
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.operations)) {
    throw new Error("patch 缺少 operations 数组");
  }
  return {
    name: typeof obj.name === "string" ? obj.name : undefined,
    extends: Array.isArray(obj.extends) ? (obj.extends as string[]) : undefined,
    operations: obj.operations as PatchOperation[],
  };
}
