/**
 * 插件加载器（Loader）。
 *
 * 职责：
 *   1. 汇总配置源（内置 bundle patch + 用户 patch），合并出最终的插件行列表；
 *   2. 按行动态 `import()` 插件模块，调用其 `apply(ctx, config)`；
 *   3. 维护每个插件的运行状态（loaded / disabled / error）；
 *   4. 支持热更新：update(id, newConfig) 先卸载再重新加载，不重启进程。
 *
 * 插件模块约定：
 *   export function apply(ctx: Context, config: Record<string, unknown>): void | Promise<void>
 *   export function dispose?(): void | Promise<void>   // 可选，卸载时调用
 */

import { pathToFileURL } from "node:url";
import { dirname, isAbsolute, resolve } from "node:path";

import type { Context } from "../../kernel/context.js";
import { applyPatch, validatePatch, type PatchFile, type PluginRow } from "./patch.js";

export type PluginStatus = "loaded" | "disabled" | "error";

/** 插件的运行时信息，用于 /api/plugins 下发。 */
export interface LoadedPluginInfo {
  id: string;
  name: string;
  version?: string;
  module: string;
  status: PluginStatus;
  /** 加载或执行失败时的错误信息。 */
  error?: string;
  /** 实际解析到的模块路径（便于排错）。 */
  resolvedFrom?: string;
  /** 插件所在目录（便于 HMR 判断变更归属）。 */
  sourceDir?: string;
  /** 最近一次加载耗时（毫秒）。 */
  loadMs?: number;
}

/** 插件模块需要导出的接口。 */
export interface PluginModule {
  apply(ctx: Context, config: Record<string, unknown>): void | Promise<void>;
  dispose?(): void | Promise<void>;
}

interface RuntimeEntry {
  row: PluginRow;
  /** 该插件相对路径的解析根（通常是 patch 文件所在目录）。 */
  baseDir: string;
  info: LoadedPluginInfo;
  /** 卸载函数：调用插件自身的 dispose，并释放本插件登记的 ctx 副作用。 */
  teardown?: () => Promise<void>;
}

export interface LoaderOptions {
  /** 内核上下文。 */
  ctx: Context;
  /** 基础插件行（来自内置 bundle）。 */
  baseRows?: PluginRow[];
  /** 额外 patch 文件路径（用户自定义），按顺序应用。 */
  patchFiles?: string[];
  /** 模块解析基目录：相对 module 说明符以此为根。 */
  resolveBase?: string;
  /** 日志输出，默认 console.log。 */
  logger?: (msg: string) => void;
}

/**
 * 动态导入插件模块。
 *
 * 支持：
 *   - 包名（交给 Node 解析）
 *   - 绝对路径
 *   - 相对路径（相对 resolveBase）
 * 并自动尝试 .js / .mjs / .ts 后缀（tsx 环境下可直接加载 .ts）。
 */
async function importPluginModule(
  specifier: string,
  resolveBase: string,
): Promise<PluginModule> {
  const candidates: string[] = [];

  if (isAbsolute(specifier)) {
    candidates.push(pathToFileURL(specifier).href);
  } else if (specifier.startsWith(".")) {
    const abs = resolve(resolveBase, specifier);
    // 顺序很重要：先精确路径，再补后缀，最后才当作目录找 index。
    // 若先试 index 分支，会把 "x/index.ts" 误拼成 "x/index.ts/index.js"。
    candidates.push(pathToFileURL(abs).href);
    if (!/\.[cm]?[jt]s$/.test(abs)) {
      for (const ext of [".ts", ".mjs", ".js"]) {
        candidates.push(pathToFileURL(abs + ext).href);
      }
    }
    for (const ext of [".ts", ".mjs", ".js"]) {
      candidates.push(pathToFileURL(resolve(abs, `index${ext}`)).href);
    }
  } else {
    // 包名：直接交给 Node 解析
    candidates.push(specifier);
  }

  let lastErr: unknown;
  for (const url of candidates) {
    try {
      const mod = (await import(url)) as Record<string, unknown>;
      const apply = (mod.apply ?? (mod.default as Record<string, unknown> | undefined)?.apply) as
        | PluginModule["apply"]
        | undefined;
      if (typeof apply !== "function") {
        throw new Error(`插件模块未导出 apply 函数：${specifier}`);
      }
      const dispose = (mod.dispose ?? (mod.default as Record<string, unknown> | undefined)?.dispose) as
        | PluginModule["dispose"]
        | undefined;
      return { apply, dispose };
    } catch (err) {
      // 模型未找到才继续尝试下一个候选；语法错误等应直接抛出
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ERR_MODULE_NOT_FOUND" || code === "ENOENT") {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error(`无法解析插件模块：${specifier}`);
}

export class PluginLoader {
  private readonly ctx: Context;
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly logger: (msg: string) => void;
  private readonly resolveBase: string;
  private warnings: string[] = [];

  constructor(options: LoaderOptions) {
    this.ctx = options.ctx;
    this.logger = options.logger ?? ((m) => console.log(m));
    this.resolveBase = options.resolveBase ?? process.cwd();
  }

  /**
   * 从多个 patch 文件 + 基础行构建 Loader 并加载全部启用的插件。
   */
  static async create(options: LoaderOptions): Promise<PluginLoader> {
    const loader = new PluginLoader(options);

    let rows = options.baseRows ?? [];
    // 记录每一行来自哪个目录，供相对模块路径解析
    const baseDirOf = new Map<string, string>();

    for (const file of options.patchFiles ?? []) {
      try {
        const raw = await readPatchFile(file);
        const patch: PatchFile = validatePatch(raw);
        const result = applyPatch(rows, patch);
        rows = result.rows;
        loader.warnings.push(...result.warnings);
        // 该 patch 新增/修改的行，用 patch 文件所在目录作为解析根
        for (const op of patch.operations ?? []) {
          const id = op.row?.id ?? op.id;
          if (id) baseDirOf.set(id, dirname(resolve(process.cwd(), file)));
        }
        loader.logger(`  已应用 patch：${patch.name ?? file}`);
      } catch (err) {
        loader.warnings.push(`读取 patch 失败 ${file}：${String(err)}`);
      }
    }

    for (const row of rows) {
      await loader.load(row, baseDirOf.get(row.id) ?? options.resolveBase ?? process.cwd());
    }
    return loader;
  }

  /** 当前所有插件信息。 */
  list(): LoadedPluginInfo[] {
    return [...this.entries.values()].map((e) => ({ ...e.info }));
  }

  /** 合并过程中的告警。 */
  getWarnings(): string[] {
    return [...this.warnings];
  }

  /**
   * 挂载单个插件。
   *
   * 已存在的同 id 插件会先卸载，保证幂等。
   */
  async load(row: PluginRow, baseDir: string = this.resolveBase): Promise<LoadedPluginInfo> {
    const existing = this.entries.get(row.id);
    if (existing) await this.unload(row.id);

    const info: LoadedPluginInfo = {
      id: row.id,
      name: row.name ?? row.id,
      version: row.version,
      module: row.module,
      status: "disabled",
    };

    if (row.enabled === false) {
      this.entries.set(row.id, { row, info, baseDir });
      return info;
    }

    const started = Date.now();
    try {
      const mod = await importPluginModule(row.module, baseDir);
      info.resolvedFrom = baseDir;
      info.sourceDir = baseDir;

      /*
       * 在 Context 的局部作用域内执行 apply：
       * 插件登记的服务与监听器会被记录下来，卸载时精确回滚，
       * 因此热更新时同一个 key 可以重新 provide，不会报「已注册」。
       */
      const scoped = this.ctx.scope(() => mod.apply(this.ctx, row.config ?? {}));
      await scoped.result;

      info.status = "loaded";
      info.loadMs = Date.now() - started;

      const dispose = mod.dispose;
      const revert = scoped.revert;
      this.entries.set(row.id, {
        row,
        info,
        baseDir,
        teardown: async () => {
          try {
            if (dispose) await dispose();
          } finally {
            // 即使插件自己的 dispose 抛错，也必须回滚内核登记
            revert();
          }
        },
      });
      this.logger(`  ✓ 插件已加载：${info.name} (${row.id})`);
    } catch (err) {
      info.status = "error";
      info.error = err instanceof Error ? err.message : String(err);
      this.entries.set(row.id, { row, info, baseDir });
      this.logger(`  ✗ 插件加载失败：${row.id} — ${info.error}`);
    }

    return info;
  }

  /** 卸载插件。 */
  async unload(id: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry) return false;
    try {
      await entry.teardown?.();
    } catch (err) {
      this.logger(`  ! 插件 ${id} 卸载时出错：${String(err)}`);
    }
    this.entries.delete(id);
    return true;
  }

  /**
   * 热更新：用新配置原地重载插件。
   *
   * 先卸载旧实例再加载新实例，因此插件可以安全地重复初始化。
   */
  async update(id: string, patch: Partial<PluginRow>): Promise<LoadedPluginInfo> {
    const entry = this.entries.get(id);
    const base: PluginRow = entry
      ? { ...entry.row, ...patch }
      : ({ id, module: patch.module ?? id, ...patch } as PluginRow);
    return this.load(base, entry?.baseDir ?? this.resolveBase);
  }

  /** 移除插件。 */
  async remove(id: string): Promise<boolean> {
    return this.unload(id);
  }

  /** 卸载全部插件（进程退出时调用）。 */
  async disposeAll(): Promise<void> {
    for (const id of [...this.entries.keys()]) {
      await this.unload(id);
    }
  }
}

/** 读取 patch 文件（支持 .json；.yml/.yaml 需要 js-yaml，本项目未引入，给出明确提示）。 */
export async function readPatchFile(file: string): Promise<unknown> {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(file, "utf8");

  if (/\.ya?ml$/i.test(file)) {
    // 避免为单一格式引入依赖：YAML 用极简的 JSON 兼容子集解析（键值 + 数组）
    // 若内容以 { 开头则按 JSON 处理，否则提示用户改用 JSON。
    const trimmed = text.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      return JSON.parse(trimmed);
    }
    throw new Error(
      "检测到 YAML 格式的 patch，但本项目未引入 js-yaml。请改用 patch.json，或运行 npm i js-yaml 后扩展 readPatchFile。",
    );
  }

  return JSON.parse(text);
}
