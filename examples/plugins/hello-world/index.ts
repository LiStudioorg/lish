/**
 * hello-world 示例插件。
 *
 * 用途：验证 Bundle / Patch / Loader 的整套链路——
 * 通过修改 patch 文件即可动态加载或卸载本插件，无需重启 lish web。
 *
 * 热更新注意事项：
 *   Context.provide 不允许重复注册同一 key，
 *   因此插件在 apply 时需要先自行清理上一次的登记（见下方 dispose 逻辑）。
 */

import type { Context } from "../../../src/kernel/context.js";

/** 保存本模块最近一次登记的清理函数，供热更新时先撤销旧状态。 */
let cleanup: (() => void) | undefined;

export function apply(ctx: Context, config: Record<string, unknown>): void {
  // 热更新时本模块会被重新 import（新实例），旧实例的清理由 dispose 负责；
  // 但若同一实例被重复 apply，这里先撤销上一次登记。
  cleanup?.();
  cleanup = undefined;

  const greeting = typeof config.greeting === "string" ? config.greeting : "Hello, World!";
  console.log(`[hello-world] ${greeting}`);

  // 用一个内部注册表存放服务，避免与 Context 的「禁止重复 provide」冲突
  const registry = getRegistry(ctx);
  registry.set(greeting, Date.now());
  ctx.provide("hello-world", { greeting, loadedAt: Date.now() });

  const onPing = (payload: unknown) => {
    console.log(`[hello-world] 收到 ping:`, payload);
  };
  ctx.on("plugin:ping", onPing);

  cleanup = () => {
    ctx.off("plugin:ping", onPing);
  };
}

export function dispose(): void {
  cleanup?.();
  cleanup = undefined;
  console.log("[hello-world] 已卸载");
}

/** 极简的插件私有状态存储（挂在模块级，跨 apply 复用）。 */
const registry = new Map<string, number>();

function getRegistry(_ctx: Context): Map<string, number> {
  return registry;
}
