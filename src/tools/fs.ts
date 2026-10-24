/**
 * 沙箱友好的文件系统工具。
 *
 * 安全要点（这是本文件的全部意义）：
 *   任何由模型给出的相对路径，都必须先经 `path.resolve` 解析成绝对路径，
 *   再校验它是否仍落在 `workspaceRoot` 之内。这样可以拦住
 *   `../outside.txt`、`a/../../etc/passwd` 以及符号化混淆的越界尝试。
 *
 * 另外还会用 `realpath` 校验「真实路径」，防止通过**符号链接**从工作区
 * 内部指向工作区外部（`resolve` 只看字面路径，看不到软链的真实指向）。
 */

import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { ToolDefinition } from "../core/tools.js";

/** 越界访问工作区时抛出的错误。 */
export class PathEscapeError extends Error {
  constructor(
    public readonly requestedPath: string,
    public readonly workspaceRoot: string,
    public readonly resolvedPath: string,
  ) {
    super(
      `Path "${requestedPath}" escapes the workspace root "${workspaceRoot}" (resolved to "${resolvedPath}")`,
    );
    this.name = "PathEscapeError";
  }
}

export type FsPermission = "workspace" | "full";

export interface FsToolsOptions {
  /** 单个文件的最大可读字节数，默认 1 MiB。 */
  maxReadBytes?: number;
  /** 单次写入的最大字节数，默认 1 MiB。 */
  maxWriteBytes?: number;
  /**
   * 权限模式。
   *   - "workspace"（默认）：路径必须落在 workspaceRoot 内；
   *   - "full"：允许访问工作区之外的绝对路径。
   *
   * 该值可由配置热更新：传入一个 getter 而非静态值，
   * 这样用户在设置里改权限后，工具行为立即生效。
   */
  permission?: FsPermission | (() => FsPermission);
}

/**
 * 校验并解析路径，确保其位于工作区内。
 *
 * @param root    工作区根目录（会被解析为绝对真实路径）
 * @param input   模型给出的路径（相对路径按工作区根计算）
 * @returns       绝对路径
 * @throws PathEscapeError 当路径越界时
 */
export async function resolveInsideWorkspace(
  root: string,
  input: string,
  _options: { allowMissingLeaf?: boolean } = {},
): Promise<string> {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error("Path must be a non-empty string");
  }
  if (input.includes("\0")) {
    throw new Error("Path must not contain NUL bytes");
  }

  // 1) 把根目录解析为真实绝对路径（根目录若不存在则退回归一化结果）。
  const absoluteRoot = resolve(root);
  const realRoot = await realpath(absoluteRoot).catch(() => absoluteRoot);

  // 2) 字面解析：`..` 在这里就被折叠掉，越界会在第 3 步暴露。
  //    file:// URL 也支持，方便工具接收 URL 形式的路径。
  const candidate = input.startsWith("file://")
    ? fileURLToPath(input)
    : resolve(realRoot, input);

  assertContained(realRoot, candidate, input);

  // 3) 真实路径校验：防止软链指到工作区外。
  //    叶子节点可能尚不存在（写入新文件），此时校验其最近的已存在祖先。
  const realCandidate = await realpath(candidate).catch(async () => {
    const existingAncestor = await nearestExisting(candidate, realRoot);
    const realAncestor = await realpath(existingAncestor).catch(() => existingAncestor);
    // 用真实祖先 + 剩余相对段重建真实路径
    const rest = relative(existingAncestor, candidate);
    return resolve(realAncestor, rest);
  });

  assertContained(realRoot, realCandidate, input);
  return realCandidate;
}

/** 断言 `candidate` 位于 `root` 之内（含 root 本身）。 */
function assertContained(root: string, candidate: string, original: string): void {
  const rel = relative(root, candidate);
  const escapes =
    rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (escapes) {
    throw new PathEscapeError(original, root, candidate);
  }
}

/** 向上寻找最近的已存在目录。 */
async function nearestExisting(target: string, stopAt: string): Promise<string> {
  let current = target;
  for (;;) {
    try {
      await stat(current);
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return stopAt;
      if (relative(stopAt, parent).startsWith("..")) return stopAt;
      current = parent;
    }
  }
}

/** 把字节数格式化为易读的字符串。 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/**
 * 创建两个文件系统工具：`fs.read` 与 `fs.write`。
 *
 * 返回的是可直接交给 `ToolRegistry.register()` 的定义数组，
 * 也可 `registry.register(tools.fs.read)` 单独注册。
 */
export function createFsTools(
  workspaceRoot: string,
  options: FsToolsOptions = {},
): { read: ToolDefinition; write: ToolDefinition } {
  const maxReadBytes = options.maxReadBytes ?? 1024 * 1024;
  const maxWriteBytes = options.maxWriteBytes ?? 1024 * 1024;
  const root = resolve(workspaceRoot);

  /** 每次调用都重新求值，使权限变更即时生效。 */
  const permission = (): FsPermission => {
    const p = options.permission;
    if (typeof p === "function") return p();
    return p ?? "workspace";
  };

  /**
   * 按当前权限解析目标路径。
   * "full" 模式下跳过沙箱校验，但仍拒绝 NUL 字节等非法输入。
   */
  const resolveTarget = async (input: string): Promise<string> => {
    if (permission() === "full") {
      if (!input || input.includes("\0")) throw new Error("Path must be a non-empty string");
      return isAbsolute(input) ? resolve(input) : resolve(root, input);
    }
    return resolveInsideWorkspace(root, input);
  };

  const read: ToolDefinition = {
    name: "fs.read",
    description:
      "读取工作区内某个文件的文本内容。路径必须是工作区内的相对路径。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "工作区内的相对路径" },
      },
      required: ["path"],
    },
    handler: async (args) => {
      const target = await resolveTarget(String(args.path ?? ""));
      const info = await stat(target).catch(() => undefined);
      if (!info) {
        throw new Error(`File not found: ${String(args.path)}`);
      }
      if (info.isDirectory()) {
        throw new Error(`Path is a directory, not a file: ${String(args.path)}`);
      }
      if (info.size > maxReadBytes) {
        throw new Error(
          `File too large to read (${formatSize(info.size)} > limit ${formatSize(maxReadBytes)})`,
        );
      }
      const content = await readFile(target, "utf8");
      return { path: String(args.path), content, bytes: info.size };
    },
  };

  const write: ToolDefinition = {
    name: "fs.write",
    description:
      "把文本写入工作区内的文件，父目录会自动创建。路径必须是工作区内的相对路径。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "工作区内的相对路径" },
        content: { type: "string", description: "要写入的文本内容" },
      },
      required: ["path", "content"],
    },
    handler: async (args) => {
      const rawPath = String(args.path ?? "");
      const content = String(args.content ?? "");

      const bytes = Buffer.byteLength(content, "utf8");
      if (bytes > maxWriteBytes) {
        throw new Error(
          `Content too large to write (${formatSize(bytes)} > limit ${formatSize(maxWriteBytes)})`,
        );
      }

      const target = await resolveTarget(rawPath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
      return { path: rawPath, bytes };
    },
  };

  return { read, write };
}

/** 便捷函数：把两个工具一次性注册进注册表。 */
export function registerFsTools(
  registry: { register(tool: ToolDefinition): unknown },
  workspaceRoot: string,
  options: FsToolsOptions = {},
): { read: ToolDefinition; write: ToolDefinition } {
  const tools = createFsTools(workspaceRoot, options);
  registry.register(tools.read);
  registry.register(tools.write);
  return tools;
}
