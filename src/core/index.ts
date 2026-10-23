/**
 * Mount the M1 core services onto a Context.
 *
 * One plugin, three services, in dependency order:
 *   ctx.sessions  -> ctx.llm -> ctx.tools -> ctx.agent
 *
 * Each is registered before the next one that may inject it, and all are torn
 * down with the kernel (the Context disposes the EventBus last, so tools can
 * still observe events during teardown).
 */

import type { Context } from "../kernel/context.js";
import type { Plugin } from "../kernel/plugin.js";
import { AgentLoop, type AgentLoopOptions } from "./agent-loop.js";
import { LlmRuntime } from "./llm.js";
import { SessionService, type SessionServiceOptions } from "./sessions.js";
import { ToolRegistry } from "./tools.js";

export interface CorePluginOptions {
  sessions?: SessionServiceOptions;
  llm?: { provider?: import("./llm.js").LlmProvider };
  agent?: AgentLoopOptions;
}

/** Mount sessions + llm + tools + agent. Idempotent per key. */
export function mountCore(ctx: Context, options: CorePluginOptions = {}): void {
  const provide = <T>(key: string, value: T): T => {
    if (ctx.has(key)) return ctx.resolve<T>(key);
    return ctx.provide(key, value);
  };

  provide(SessionService.KEY, new SessionService(ctx, options.sessions));
  provide(LlmRuntime.KEY, new LlmRuntime(ctx, options.llm ?? {}));
  provide(ToolRegistry.KEY, new ToolRegistry(ctx));
  provide(AgentLoop.KEY, new AgentLoop(ctx, options.agent ?? {}));
}

/** The core plugin, for use with `loadPlugin`. */
export function corePlugin(options: CorePluginOptions = {}): Plugin {
  return {
    name: "core",
    apply(ctx) {
      mountCore(ctx, options);
    },
  };
}
