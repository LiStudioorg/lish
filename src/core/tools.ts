/**
 * Tool registry with an interception pipeline.
 *
 * Tools are plain async functions plus a JSON-schema-ish description. Before a
 * tool runs, `tools/pre-execute` fires as a waterfall so plugins can inspect
 * or rewrite the arguments — or throw to block the call outright. After it
 * runs, `tools/post-execute` fires so results can be post-processed.
 */

import type { Context } from "../kernel/context.js";
import type { ToolSchema, ToolCall } from "./llm.js";

/** Event names used by the pipeline. */
export const TOOLS_PRE_EXECUTE = "tools/pre-execute";
export const TOOLS_POST_EXECUTE = "tools/post-execute";

/** A tool implementation. `args` is whatever the model produced. */
export type ToolHandler = (
  args: Record<string, unknown>,
) => unknown | Promise<unknown>;

export interface ToolDefinition {
  name: string;
  description?: string;
  /** JSON Schema for the arguments object, surfaced to the model. */
  parameters?: Record<string, unknown>;
  handler: ToolHandler;
}

/** Payload flowing through `tools/pre-execute`. */
export interface PreExecutePayload {
  name: string;
  args: Record<string, unknown>;
  callId?: string;
}

/** Payload flowing through `tools/post-execute`. */
export interface PostExecutePayload {
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  /** Serialised result, as it will be shown to the model. */
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

  /** Passing the context enables the pre/post interception pipeline. */
  constructor(ctx?: Context) {
    this.ctx = ctx;
  }

  /** Register (or replace) a tool. Returns the registry for chaining. */
  register(tool: ToolDefinition): this {
    if (!tool.name) throw new Error("Tool requires a name");
    if (typeof tool.handler !== "function") {
      throw new Error(`Tool "${tool.name}" requires a handler function`);
    }
    this.tools.set(tool.name, tool);
    return this;
  }

  /** Remove a tool; returns whether something was removed. */
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

  /** Names of all registered tools, in registration order. */
  list(): string[] {
    return [...this.tools.keys()];
  }

  /** Schemas for the model's `tools` option. */
  schemas(): ToolSchema[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      ...(t.description !== undefined ? { description: t.description } : {}),
      ...(t.parameters !== undefined ? { parameters: t.parameters } : {}),
    }));
  }

  /**
   * Execute a tool by name.
   *
   * Order of operations:
   *   1. resolve the definition (throws ToolNotFoundError);
   *   2. `tools/pre-execute` waterfall — may rewrite args or block;
   *   3. run the handler;
   *   4. `tools/post-execute` waterfall — may reshape the content.
   *
   * Handler failures are captured and returned as `isError: true` rather than
   * thrown, because a failed tool is data the model needs to see. Blocking via
   * the pre-execute hook *is* thrown to the caller: that is a policy decision,
   * not a tool outcome.
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
      // A waterfall returns what the chain resolves to; the last listener that
      // calls next() contributes the final payload.
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

  /** Execute a batch of model tool calls, preserving order. */
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

  /** Drop every tool (used on teardown). */
  clear(): void {
    this.tools.clear();
  }
}

/** Render a tool result as the string the model will read. */
export function serialise(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
