/**
 * 子智能体（Sub-agent）。
 *
 * 设计要点（遵循 AGENTS.md）：
 *   1. **开闭原则**：子代理通过 `spawn_agent` 工具暴露，核心 AgentLoop 不硬编码业务分支；
 *   2. **继承而非新建**：子代理复用父级的 LlmRuntime 与 ToolRegistry，
 *      因此工具权限、插件开关、权限模式自动继承，不会出现「子代理越权」；
 *   3. **深度限制**：通过 Context 上的计数防止无限递归（A 调 B，B 又调 A）；
 *   4. **独立轨迹**：子代理使用全新 Session 与独立 traceId，
 *      在轨迹面板中可单独查看，同时通过 parentTraceId 关联到父级。
 */

import type { Context } from "../kernel/context.js";
import type { SessionService } from "./sessions.js";
import { AgentLoop } from "./agent-loop.js";
import type { ToolRegistry } from "./tools.js";
import type { ToolDefinition } from "./tools.js";
import { AsyncLocalStorage } from "node:async_hooks";

/** 子代理运行状态，供前端展示「子智能体 N 个」。 */
export interface SubAgentRecord {
  id: string;
  role: string;
  task: string;
  status: "running" | "done" | "error";
  startedAt: number;
  finishedAt?: number;
  sessionId: string;
  traceId?: string;
  result?: string;
  error?: string;
}

/** 子代理注册表：进程内保存运行记录，便于前端轮询。 */
export class SubAgentRegistry {
  private readonly records = new Map<string, SubAgentRecord>();
  /** 父级 traceId -> 子代理 id 列表，用于轨迹面板分组。 */
  private readonly byParent = new Map<string, string[]>();
  private seq = 0;

  /** 创建一条运行中记录。 */
  create(input: {
    role: string;
    task: string;
    sessionId: string;
    parentTraceId?: string;
  }): SubAgentRecord {
    const id = `sub-${Date.now().toString(36)}-${++this.seq}`;
    const record: SubAgentRecord = {
      id,
      role: input.role,
      task: input.task,
      status: "running",
      startedAt: Date.now(),
      sessionId: input.sessionId,
    };
    this.records.set(id, record);

    if (input.parentTraceId) {
      const list = this.byParent.get(input.parentTraceId) ?? [];
      list.push(id);
      this.byParent.set(input.parentTraceId, list);
    }
    return record;
  }

  /** 更新记录。 */
  update(id: string, patch: Partial<SubAgentRecord>): SubAgentRecord | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;
    Object.assign(record, patch);
    return record;
  }

  /** 全部记录（按启动时间倒序）。 */
  list(): SubAgentRecord[] {
    return [...this.records.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  /** 正在运行的数量（前端状态栏用）。 */
  get runningCount(): number {
    let n = 0;
    for (const r of this.records.values()) if (r.status === "running") n++;
    return n;
  }

  /** 某父级轨迹下的子代理。 */
  childrenOf(parentTraceId: string): SubAgentRecord[] {
    return (this.byParent.get(parentTraceId) ?? [])
      .map((id) => this.records.get(id))
      .filter((r): r is SubAgentRecord => r !== undefined);
  }
}

/** 子代理依赖：全部从父级继承，保证权限与工具一致。 */
export interface SpawnAgentDeps {
  ctx: Context;
  sessions: SessionService;
  /** 父级 AgentLoop，用于继承其配置（maxSteps 等）。 */
  agent: AgentLoop;
  tools: ToolRegistry;
  registry: SubAgentRegistry;
  /** 最大嵌套深度，默认 2（父 → 子 → 孙后禁止再派生）。 */
  maxDepth?: number;
  /** 单次子代理的最大步数。 */
  maxSteps?: number;
}

/**
 * 深度计数。
 *
 * 之前用 Context 上的全局单值（`ctx.provide`），
 * 并发派生子代理时会因「key 已存在」而抛错或互相覆盖。
 * 改为 AsyncLocalStorage：每条异步调用链拥有独立的深度，
 * 天然支持并发派生，且无需手动回滚。
 */
const depthStorage = new AsyncLocalStorage<number>();

/** 读取当前异步上下文的嵌套深度。 */
function currentDepth(): number {
  return depthStorage.getStore() ?? 0;
}

/**
 * 在指定的嵌套深度上下文中执行一段逻辑。
 *
 * 供测试与外部编排使用：传入 depth 后，期间发生的 spawn_agent
 * 会认为自己处于该深度，从而验证深度保护。
 */
export function runInSpawnDepth<T>(depth: number, fn: () => T): T {
  return depthStorage.run(depth, fn);
}

/**
 * 构造 `spawn_agent` 工具。
 *
 * 入参：{ role: string, task: string }
 * 返回：子代理的最终文本结果（作为工具结果回给父 Agent）。
 */
export function createSpawnAgentTool(deps: SpawnAgentDeps): ToolDefinition {
  const maxDepth = deps.maxDepth ?? 2;
  const maxSteps = deps.maxSteps ?? 6;

  return {
    name: "spawn_agent",
    description:
      "派生一个子智能体来独立完成一项子任务。子代理继承当前的工具与权限，返回其最终结论。" +
      "适用于可并行拆分的调研、分析类任务。",
    parameters: {
      type: "object",
      properties: {
        role: {
          type: "string",
          description: "子代理的角色设定（将作为 system prompt）",
        },
        task: {
          type: "string",
          description: "要交给子代理完成的具体任务描述",
        },
      },
      required: ["role", "task"],
    },

    handler: async (args) => {
      const role = String(args.role ?? "").trim();
      const task = String(args.task ?? "").trim();
      if (!role || !task) {
        throw new Error("spawn_agent 需要同时提供 role 与 task");
      }

      // --- 深度保护：防止 A 调 B、B 调 A 的无限递归 ---
      const depth = currentDepth();
      if (depth >= maxDepth) {
        throw new Error(
          `已达到最大嵌套深度（${maxDepth}），禁止继续派生；请直接完成该子任务`,
        );
      }

      // --- 建立独立会话，role 作为 system prompt ---
      const session = deps.sessions.create({
        title: `子代理·${role}`.slice(0, 40),
      });
      session.appendSystemMessage(role);

      const record = deps.registry.create({
        role,
        task,
        sessionId: session.id,
        parentTraceId: deps.ctx.has("agent:trace")
          ? deps.ctx.resolve<string>("agent:trace")
          : undefined,
      });

      try {
        /*
         * 子代理使用独立的 AgentLoop 实例，但注入同一个 ctx / tools / traceStore，
         * 因此权限、插件开关、轨迹都自动继承；仅步数上限可按参数收窄。
         */
        const childAgent = new AgentLoop(deps.ctx, {
          maxSteps: Math.min(maxSteps, deps.agent.maxSteps),
          traceStore: deps.agent.traceStoreForChild,
        });
        // 在独立的异步上下文中运行，深度 +1；并发派生互不干扰
        const result = await depthStorage.run(depth + 1, () =>
          childAgent.run(session, task),
        );

        // 子代理独立 traceId：从其自身轨迹中取首条事件的 traceId
        let childTraceId: string | undefined;
        const childEvents = deps.agent.traceStoreForChild.list(session.id);
        if (childEvents.length > 0) childTraceId = childEvents[0]?.traceId;

        deps.registry.update(record.id, {
          status: result.stopReason === "error" ? "error" : "done",
          finishedAt: Date.now(),
          sessionId: session.id,
          ...(childTraceId ? { traceId: childTraceId } : {}),
          result: result.text,
          ...(result.error ? { error: result.error } : {}),
        });

        if (result.stopReason === "error") {
          return {
            agentId: record.id,
            status: "error",
            error: result.error ?? "子代理运行失败",
            sessionId: session.id,
          };
        }

        return {
          agentId: record.id,
          status: "done",
          sessionId: session.id,
          steps: result.steps.length,
          toolCalls: result.toolCallsExecuted,
          result: result.text || "（子代理未产出文本结果）",
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.registry.update(record.id, {
          status: "error",
          finishedAt: Date.now(),
          error: message,
        });
        throw err;
      }
    },
  };
}
