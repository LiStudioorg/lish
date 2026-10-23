/**
 * 插件机制。
 *
 * 插件通过 `inject` 声明它依赖的服务；加载器只有在这些依赖全部就绪时
 * 才会执行插件的 `apply`，因此插件内部不需要写防御性的存在性判断。
 */

import { Context, ServiceKey } from "./context.js";

export interface Plugin {
  /** 插件唯一名称。 */
  name: string;
  /** 执行 `apply` 前必须就绪的服务 key。 */
  inject?: ServiceKey[];
  /** 依赖就绪后调用。 */
  apply(ctx: Context): void | Promise<void>;
}

/** 依赖缺失时抛出的错误。 */
export class PluginDependencyError extends Error {
  constructor(
    public readonly plugin: string,
    public readonly missing: ServiceKey[],
  ) {
    super(
      `Plugin "${plugin}" is missing dependencies: ${missing
        .map(String)
        .join(", ")}`,
    );
    this.name = "PluginDependencyError";
  }
}

/**
 * 检查依赖是否就绪，然后执行插件。
 * 依赖缺失时抛出 PluginDependencyError，且**不会**调用 apply（fail-closed）。
 */
export async function loadPlugin(ctx: Context, plugin: Plugin): Promise<void> {
  const missing = (plugin.inject ?? []).filter((key) => !ctx.has(key));
  if (missing.length > 0) {
    throw new PluginDependencyError(plugin.name, missing);
  }
  await plugin.apply(ctx);
}

/** 按声明顺序依次加载多个插件。 */
export async function loadPlugins(
  ctx: Context,
  plugins: Plugin[],
): Promise<void> {
  for (const plugin of plugins) {
    await loadPlugin(ctx, plugin);
  }
}

/** 判断某插件的依赖当前是否可满足。 */
export function isReady(ctx: Context, plugin: Plugin): boolean {
  return (plugin.inject ?? []).every((key) => ctx.has(key));
}
