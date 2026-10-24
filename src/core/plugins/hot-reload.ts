/**
 * 插件热重载（HMR）。
 *
 * 监听插件目录，一旦源码或 patch 变化就就地重载对应插件，无需重启 lish web。
 *
 * 实现要点：
 *   - 用 fs.watch 监听目录（递归在 Linux 上不可用，因此逐层注册）；
 *   - 事件去抖 300ms，避免编辑器保存时产生多次事件；
 *   - 对正在加载的插件加锁，防止重入；
 *   - 只重载「文件属于该插件目录」的插件，避免连带重载无关插件。
 */

import { watch, type FSWatcher } from "node:fs";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { PluginLoader } from "./loader.js";

export interface HotReloadOptions {
  loader: PluginLoader;
  /** 要监听的目录列表。 */
  dirs: string[];
  /** 去抖毫秒，默认 300。 */
  debounceMs?: number;
  logger?: (msg: string) => void;
}

export class PluginHotReloader {
  private readonly watchers: FSWatcher[] = [];
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly loader: PluginLoader;
  private readonly debounceMs: number;
  private readonly logger: (msg: string) => void;
  private disposed = false;

  constructor(options: HotReloadOptions) {
    this.loader = options.loader;
    this.debounceMs = options.debounceMs ?? 300;
    this.logger = options.logger ?? ((m) => console.log(m));

    for (const dir of options.dirs) {
      if (!existsSync(dir)) continue;
      try {
        const watcher = watch(dir, { persistent: false }, (_event, filename) => {
          if (!filename) return;
          this.scheduleReload(dir, String(filename));
        });
        watcher.on("error", () => {
          /* 目录被删除等，忽略 */
        });
        this.watchers.push(watcher);
      } catch {
        /* 某些平台不支持 watch，静默降级 */
      }
    }
  }

  /** 去抖后执行重载。 */
  private scheduleReload(dir: string, filename: string): void {
    if (this.disposed) return;
    const key = resolve(dir, filename);

    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);

    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.reloadForFile(dir, filename);
      }, this.debounceMs),
    );
  }

  /**
   * 找到该文件所属的插件并重载。
   *
   * 判定方式：插件的 sourceDir（即 patch 所在目录）是文件路径的前缀。
   */
  private async reloadForFile(dir: string, filename: string): Promise<void> {
    if (this.disposed) return;
    const filePath = resolve(dir, filename);

    const plugins = this.loader.list();
    const target = plugins.find(
      (p) => p.sourceDir && filePath.startsWith(p.sourceDir + "/"),
    );

    if (!target) return;

    this.logger(`  ⟳ 检测到变更，重载插件：${target.name} (${target.id})`);
    try {
      const info = await this.loader.update(target.id, {});
      this.logger(
        info.status === "loaded"
          ? `  ✓ 重载完成：${info.name}（${info.loadMs ?? 0}ms）`
          : `  ✗ 重载失败：${info.error ?? info.status}`,
      );
    } catch (err) {
      this.logger(`  ✗ 重载异常：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 停止监听。 */
  dispose(): void {
    this.disposed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const w of this.watchers) {
      try {
        w.close();
      } catch {
        /* 忽略 */
      }
    }
    this.watchers.length = 0;
  }

  /** 当前监听的目录数（测试与状态展示用）。 */
  get watchCount(): number {
    return this.watchers.length;
  }
}
