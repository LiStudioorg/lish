/**
 * 工作区文件树读取。
 *
 * 只读、限定深度、跳过重量级目录，避免在大仓库里卡死或返回海量数据。
 */

import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

/** 一律忽略的目录/文件（体积大或与源码无关）。 */
const IGNORED = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "out",
  "build",
  "coverage",
  ".turbo",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
  ".DS_Store",
  "*.tsbuildinfo",
]);

/** 单层最多返回的条目数，防止超大目录拖垮前端。 */
const MAX_ENTRIES_PER_DIR = 200;

export interface FileNode {
  /** 相对工作区根的路径，使用 / 分隔 */
  path: string;
  name: string;
  type: "file" | "dir";
  /** 字节数（仅文件） */
  size?: number;
  children?: FileNode[];
  /** 子项被截断时置 true */
  truncated?: boolean;
}

function isIgnored(name: string): boolean {
  if (IGNORED.has(name)) return true;
  if (name.endsWith(".tsbuildinfo")) return true;
  return false;
}

/**
 * 递归读取目录树。
 *
 * @param root      工作区根（绝对路径）
 * @param maxDepth  最大深度，默认 3
 */
export async function readFileTree(
  root: string,
  maxDepth = 3,
): Promise<FileNode> {
  const build = async (dir: string, depth: number): Promise<FileNode[]> => {
    if (depth > maxDepth) return [];

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const nodes: FileNode[] = [];
    let count = 0;

    // 目录在前、文件在后，各自按名称排序，与常见编辑器一致
    const sorted = entries
      .filter((e) => !isIgnored(e.name))
      .sort((a, b) => {
        const aDir = a.isDirectory() ? 0 : 1;
        const bDir = b.isDirectory() ? 0 : 1;
        if (aDir !== bDir) return aDir - bDir;
        return a.name.localeCompare(b.name, "zh-CN");
      });

    for (const entry of sorted) {
      if (count >= MAX_ENTRIES_PER_DIR) {
        nodes.push({
          path: join(relative(root, dir), "__truncated__").replace(/\\/g, "/"),
          name: `…还有更多（已截断）`,
          type: "file",
        });
        break;
      }
      count++;

      const full = join(dir, entry.name);
      const rel = relative(root, full).replace(/\\/g, "/");

      if (entry.isDirectory()) {
        const children = await build(full, depth + 1);
        nodes.push({ path: rel, name: entry.name, type: "dir", children });
      } else if (entry.isFile()) {
        nodes.push({ path: rel, name: entry.name, type: "file" });
      }
      // 符号链接等其它类型跳过，避免越界或循环
    }

    return nodes;
  };

  const children = await build(root, 1);
  return {
    path: "",
    name: "lish",
    type: "dir",
    children,
  };
}
