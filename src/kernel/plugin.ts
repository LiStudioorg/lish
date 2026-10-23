/**
 * Plugin mechanism for the micro-kernel.
 *
 * A plugin declares the services it depends on via `inject`. The loader only
 * runs `apply` once every injected dependency can be resolved.
 */

import { Context, ServiceKey } from "./context.js";

export interface Plugin {
  /** Unique plugin name. */
  name: string;
  /** Service keys that must be available before `apply` runs. */
  inject?: ServiceKey[];
  /** Called with the context once dependencies are ready. */
  apply(ctx: Context): void | Promise<void>;
}

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
 * Check that every injected dependency is available, then apply the plugin.
 * Throws PluginDependencyError (and does not call apply) when something is
 * missing.
 */
export async function loadPlugin(ctx: Context, plugin: Plugin): Promise<void> {
  const missing = (plugin.inject ?? []).filter((key) => !ctx.has(key));
  if (missing.length > 0) {
    throw new PluginDependencyError(plugin.name, missing);
  }
  await plugin.apply(ctx);
}

/** Load plugins sequentially, in declaration order. */
export async function loadPlugins(
  ctx: Context,
  plugins: Plugin[],
): Promise<void> {
  for (const plugin of plugins) {
    await loadPlugin(ctx, plugin);
  }
}

/** Whether a plugin's dependencies are currently satisfiable. */
export function isReady(ctx: Context, plugin: Plugin): boolean {
  return (plugin.inject ?? []).every((key) => ctx.has(key));
}
