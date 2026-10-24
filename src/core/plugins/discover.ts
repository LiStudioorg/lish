/**
 * 目录扫描式动态插件发现。
 *
 * 与 Patch 机制互补：
 *   - Patch 面向「声明式配置」（一个 Bundle 用 patch.json 描述多个插件）；
 *   - 本模块面向「即插即用」——把 .js/.ts 文件直接丢进插件目录即可生效。
 *
 * 约定（两种形态都支持）：
 *   1. 目录 + patch.json：~/.lish/plugins/<id>/patch.json（走 Patch 流程）
 *   2. 单文件直投：~/.lish/plugins/hello-world.ts（本模块扫描）
 *
 * 扫描规则：
 *   - 只接受 .js / .mjs / .ts 文件，忽略 .d.ts 与以 _ 开头的文件；
 *   - 每个文件导出 apply(ctx) 即视为合法插件；
 *   - 插件 id 取文件基名（hello-world.ts → hello-world）。
 */

import { mkdir, readdir } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { basename, extname, join } from "node:path";

import type { PluginRow } from "./patch.js";

/** 允许的插件文件扩展名。 */
const PLUGIN_EXTS = new Set([".ts", ".mts", ".js", ".mjs"]);

export interface DiscoveredPlugin {
  /** 插件 id（文件名去扩展名）。 */
  id: string;
  /** 模块说明符（绝对路径）。 */
  module: string;
  /** 文件所在目录。 */
  sourceDir: string;
  /** 展示名。 */
  name: string;
}

/** 确保插件目录存在（不存在则递归创建）。 */
export async function ensurePluginDir(dir: string): Promise<boolean> {
  try {
    await mkdir(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * 扫描目录下的单文件插件。
 *
 * @param dir 插件根目录
 * @returns 可直接交给 Loader 的 PluginRow 列表
 */
export async function discoverPlugins(dir: string): Promise<PluginRow[]> {
  await ensurePluginDir(dir);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const rows: PluginRow[] = [];

  for (const name of entries) {
    // 忽略声明文件、临时文件与隐藏文件
    if (name.endsWith(".d.ts")) continue;
    if (name.startsWith("_") || name.startsWith(".")) continue;

    const ext = extname(name);
    if (!PLUGIN_EXTS.has(ext)) continue;

    const id = basename(name, ext);
    rows.push({
      id,
      // 用绝对路径导入，避免相对路径的基准歧义
      module: join(dir, name),
      name: id,
      version: "0.0.0-local",
      enabled: true,
    });
  }

  return rows;
}

/** 同步版本，供不便使用异步的调用点（如构造期）。 */
export function discoverPluginsSync(dir: string): PluginRow[] {
  try {
    const entries = readdirSync(dir);
    const rows: PluginRow[] = [];
    for (const name of entries) {
      if (name.endsWith(".d.ts")) continue;
      if (name.startsWith("_") || name.startsWith(".")) continue;
      const ext = extname(name);
      if (!PLUGIN_EXTS.has(ext)) continue;
      const id = basename(name, ext);
      rows.push({
        id,
        module: join(dir, name),
        name: id,
        version: "0.0.0-local",
        enabled: true,
      });
    }
    return rows;
  } catch {
    return [];
  }
}
