/**
 * 工具注册表与拦截管线。
 *
 * 工具本质上是「一个异步函数 + 一段 JSON Schema 描述」。执行前后各有一个钩子：
 *   - 执行前触发 `tools/pre-execute`（waterfall 语义），插件可检查、改写参数，
 *     或直接抛错阻断本次调用；
 *   - 执行后触发 `tools/post-execute`，可对结果做后处理。
 */

import type { Context } from "../kernel/context.js";
import type { ToolSchema, ToolCall } from "./llm.js";

/** 管线使用的事件名。 */
export const TOOLS_PRE_EXECUTE = "tools/pre-execute";
export const TOOLS_POST_EXECUTE = "tools/post-execute";

/** 工具实现。`args` 是模型给出的参数对象。 */
export type ToolHandler = (
  args: Record<string, unknown>,
) => unknown | Promise<unknown>;

export interface ToolDefinition {
  name: string;
  description?: string;
  /** 参数对象的 JSON Schema，会展示给模型。 */
  parameters?: Record<string, unknown>;
  handler: ToolHandler;
}

/** 流经 `tools/pre-execute` 的载荷。 */
export interface PreExecutePayload {
  name: string;
  args: Record<string, unknown>;
  callId?: string;
}

/** 流经 `tools/post-execute` 的载荷。 */
export interface PostExecutePayload {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  /** 序列化后的结果，即最终展示给模型的内容。 */
  content: string;
  isError: boolean;
  durationMs: number;
  callId?: string;
}

export class ToolNotFoundError extends Error {
  constructor(public readonly toolName: string) {
    super(`Unknown tool: ${toolName}`);
    this.name = "ToolNotFoundError";
  }
}

export class ToolBlockedError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly reason: string,
  ) {
    super(`Tool "${toolName}" was blocked before execution: ${reason}`);
    this.name = "ToolBlockedError";
  }
}

export interface ExecuteToolResult {
  content: string;
  isError: boolean;
  result: unknown;
}

export class ToolRegistry {
  static readonly KEY = "tools";

  private readonly tools = new Map<string, ToolDefinition>();
  private readonly ctx?: Context;

  /** 传入 Context 才会启用前后拦截管线；不传则退化为裸注册表。 */
  constructor(ctx?: Context) {
    this.ctx = ctx;
  }

  /** 注册（或替换）一个工具，返回自身以支持链式调用。 */
  register(tool: ToolDefinition): this {
    if (!tool.name) throw new Error("Tool requires a name");
    if (typeof tool.handler !== "function") {
      throw new Error(`Tool "${tool.name}" requires a handler function`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  /** 移除一个工具，返回是否确有移除。 */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  get size(): number {
    return this.tools.size;
  }

  /** 全部已注册工具的名称，按注册顺序。 */
  list(): string[] {
    return [...this.tools.keys()];
  }

  /** 生成供模型 `tools` 参数使用的 schema 列表。 */
  schemas(): ToolSchema[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      ...(t.parameters !== undefined ? { parameters: t.parameters } : {}),
    }));
  }

  /**
   * 按名称执行工具。
   *
   * 执行顺序：
   *   1. 查找工具定义（找不到抛 ToolNotFoundError）；
   *   2. `tools/pre-execute` waterfall —— 可改写参数或阻断；
   *   3. 执行 handler；
   *   4. `tools/post-execute` waterfall —— 可重塑返回内容。
   *
   * 语义区分（重要）：
   *   - handler 抛出的异常会被捕获并返回 `isError: true`，因为「工具失败」
   *     本身就是模型需要看到的数据，不应中断整个循环；
   *   - 被 pre-execute 钩子阻断则**向外抛出**，因为那是策略决定，
   *     而不是工具的执行结果。
   */
  async executeTool(
    name: string,
    args: Record<string, unknown> = {},
    callId?: string,
  ): Promise<ExecuteToolResult> {
    const tool = this.tools.get(name);
    if (!tool) throw new ToolNotFoundError(name);

    let payload: PreExecutePayload = { name, args: { ...args }, ...(callId ? { callId } : {}) };

    if (this.ctx) {
      // waterfall 返回链路解析出的值；最后一个调用 next() 的监听器
      // 决定最终载荷。
      const intercepted = await this.ctx.waterfall<PreExecutePayload>(
        TOOLS_PRE_EXECUTE,
        payload,
      );
      if (!intercepted || typeof intercepted !== "object") {
        throw new ToolBlockedError(name, "pre-execute hook returned no payload");
      }
      payload = intercepted;
    }

    const start = Date.now();
    let result: unknown;
    let isError = false;

    try {
      result = await tool.handler(payload.args ?? {});
    } catch (err) {
      isError = true;
      result = err instanceof Error ? err.message : String(err);
    }

    const content = serialise(result);
    const post: PostExecutePayload = {
      name,
      args: payload.args ?? {},
      result,
      content,
      isError,
      durationMs: Date.now() - start,
      ...(callId ? { callId } : {}),
    };

    let final: PostExecutePayload = post;
    if (this.ctx) {
      const interceptedPost = await this.ctx.waterfall<PostExecutePayload>(
        TOOLS_POST_EXECUTE,
        post,
      );
      if (interceptedPost && typeof interceptedPost === "object") {
        final = interceptedPost;
      }
    }

    return {
      content: final.content,
      isError: final.isError,
      result: final.result,
    };
  }

  /** 批量执行模型给出的工具调用，保持原有顺序。 */
  async executeCalls(calls: ToolCall[]): Promise<ExecuteToolResult[]> {
    const out: ExecuteToolResult[] = [];
    for (const call of calls) {
      try {
        out.push(await this.executeTool(call.name, call.arguments, call.id));
      } catch (err) {
        if (err instanceof ToolNotFoundError || err instanceof ToolBlockedError) {
          out.push({
            content: err.message,
            isError: true,
            result: err.message,
          });
          continue;
        }
        throw err;
      }
    }
    return out;
  }

  /** 清空所有工具（用于拆除阶段）。 */
  clear(): void {
    this.tools.clear();
  }
}

/** 把工具结果渲染成模型将要阅读的字符串。 */
export function serialise(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
