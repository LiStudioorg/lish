/**
 * 版本更新检测。
 *
 * 启动时向 npm registry 查询最新版本，若当前版本落后就在终端给出提示。
 *
 * 硬性约束（务必保持）：
 *   1. **绝不阻塞主进程**：调用方拿到的是 Promise，但启动流程不 await 它；
 *      查询本身带 1.5 秒超时与 AbortController。
 *   2. **绝不因网络问题报错**：离线、超时、registry 异常一律静默返回 null。
 *   3. **可关闭**：`LISH_NO_UPDATE_CHECK=1` 或非 TTY 环境直接跳过。
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** registry 查询地址。 */
const REGISTRY_URL = "https://registry.npmjs.org/@listudioorg%2flish/latest";

/** 网络超时（毫秒）。宁可放弃检测，也不让用户盯着启动日志等。 */
const TIMEOUT_MS = 1500;

export interface UpdateInfo {
  current: string;
  latest: string;
}

/**
 * 解析语义化版本。
 *
 * 只处理 `1.2.3` 与 `1.2.3-alpha.4` 这两种本项目实际出现的形态；
 * 无法解析时返回 null，调用方据此放弃比较（不误报）。
 */
export function parseVersion(
  version: string,
): { major: number; minor: number; patch: number; pre: string } | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(version.trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ?? "",
  };
}

/**
 * 比较两个版本，返回当前是否落后。
 *
 * 规则要点：
 *   - 预发布版 < 同号正式版（1.0.0-alpha.1 < 1.0.0）
 *   - 同为预发布时按点分段逐项比较，纯数字按数值比、否则按字典序
 *   - 解析失败一律视为"不落后"，避免误报打断用户
 */
export function isOutdated(current: string, latest: string): boolean {
  const a = parseVersion(current);
  const b = parseVersion(latest);
  if (!a || !b) return false;

  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] < b[key];
  }

  // 主次补丁号相同：正式版优先于预发布版
  if (a.pre === b.pre) return false;
  if (a.pre === "") return false; // 当前是正式版，不比预发布低
  if (b.pre === "") return true; // 当前是预发布，最新是正式版 → 落后

  const av = a.pre.split(".");
  const bv = b.pre.split(".");
  const len = Math.max(av.length, bv.length);
  for (let i = 0; i < len; i++) {
    const x = av[i];
    const y = bv[i];
    if (x === undefined) return true; // a 更短 → 更早 → 落后
    if (y === undefined) return false;
    if (x === y) continue;
    const xn = Number(x);
    const yn = Number(y);
    const bothNumeric = Number.isFinite(xn) && Number.isFinite(yn);
    if (bothNumeric) return xn < yn;
    return x < y;
  }
  return false;
}

/** 读取本包版本号（与 CLI 的 --version 保持同一来源）。 */
export function readCurrentVersion(): string {
  const start = dirname(fileURLToPath(import.meta.url));
  let dir = start;
  for (let depth = 0; depth < 6; depth++) {
    try {
      const raw = readFileSync(join(dir, "package.json"), "utf8");
      const pkg = JSON.parse(raw) as { version?: unknown };
      if (typeof pkg.version === "string" && pkg.version.length > 0) {
        return pkg.version;
      }
    } catch {
      // 继续向上找
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "0.0.0";
}

/**
 * 查询 npm 上的最新版本。
 *
 * 任何异常（离线、超时、非 2xx、JSON 损坏）都返回 null，绝不抛出。
 */
export async function fetchLatestVersion(
  signal?: AbortSignal,
): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  // 外部 signal 与内部超时任一触发都中止
  signal?.addEventListener("abort", () => controller.abort(), { once: true });

  try {
    const res = await fetch(REGISTRY_URL, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const data: unknown = await res.json();
    if (!data || typeof data !== "object") return null;
    const version = (data as { version?: unknown }).version;
    return typeof version === "string" && version.length > 0 ? version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 启动时的静默检测。
 *
 * @returns 有更新时返回 `{ current, latest }`，否则 null。
 *          调用方**不要 await**，让它自己在后台跑完。
 */
export async function checkForUpdate(
  options: {
    current?: string;
    enabled?: boolean;
    fetchLatest?: () => Promise<string | null>;
  } = {},
): Promise<UpdateInfo | null> {
  const enabled = options.enabled ?? true;
  if (!enabled) return null;

  // 显式关闭 / 非交互环境（CI、管道）都跳过：那里刷提示只会污染日志
  if (process.env.LISH_NO_UPDATE_CHECK === "1") return null;
  if (process.env.CI) return null;

  const current = options.current ?? readCurrentVersion();
  const latest = await (options.fetchLatest ?? (() => fetchLatestVersion()))();
  if (!latest) return null;
  return isOutdated(current, latest) ? { current, latest } : null;
}

/** 生成提示文案（黄色/青色由调用方决定，这里只负责内容）。 */
export function formatUpdateHint(info: UpdateInfo): string {
  return (
    `🚀 发现新版本 v${info.latest}（当前 v${info.current}），` +
    `请运行 npm i -g @listudioorg/lish 更新`
  );
}
