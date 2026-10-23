/**
 * 把 M1 的核心服务挂载到 Context 上。
 *
 * 一个插件、四个服务，按依赖顺序注册：
 *   ctx.sessions -> ctx.llm -> ctx.tools -> ctx.agent
 *
 * 每个服务都先于「可能注入它」的下一个服务注册；全部随内核一起销毁。
 * Context 最后才销毁 EventBus，因此拆除阶段工具仍能观察到事件。
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

/** 挂载 sessions + llm + tools + agent；按 key 幂等。 */
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

/** 核心插件，可直接交给 `loadPlugin` 使用。 */
export function corePlugin(options: CorePluginOptions = {}): Plugin {
  return {
    name: "core",
    apply(ctx) {
      mountCore(ctx, options);
    },
  };
}
