/**
 * Agent 循环：驱动「模型 -> 工具 -> 模型」的往复，直到模型不再请求工具。
 *
 * 每一步都会写入会话日志，因此日志就是一份忠实、可回放的行为记录。
 * 循环有三重保护：
 *   - `maxSteps`：单次 run 内允许的模型轮次上限；
 *   - `maxToolCalls`：单次 run 内允许的工具执行次数上限；
 *   - 重复调用检测：识别 A->B->A->B 式震荡，纯计步器只会在耗尽预算后才停。
 */

import type { Context } from "../kernel/context.js";
import type { Session } from "./session.js";
import {
  assistantMessageFrom,
  LlmRuntime,
  type GenerateOptions,
  type Message,
  type ToolCall,
} from "./llm.js";
import { ToolBlockedError, ToolNotFoundError, ToolRegistry } from "./tools.js";

export const AGENT_STEP = "agent:step";
export const AGENT_COMPLETE = "agent:complete";
export const AGENT_ABORTED = "agent:aborted";

export interface AgentLoopOptions {
  /** 单次 `run` 允许的最大模型轮次，默认 8。 */
  maxSteps?: number;
  /** 单次 `run` 允许的最大工具执行次数，默认 24。 */
  maxToolCalls?: number;
  /**
   * 同一「工具名 + 参数」在单次 run 中被请求超过该次数时中断，默认 3。
   */
  maxRepeatedCalls?: number;
  /** 透传给每次模型调用的参数。 */
  generateOptions?: GenerateOptions;
  /** 是否把会话折叠成 API 规范形状（唯一一条置顶 system）。 */
  hoistSystem?: boolean;
}

export type AgentStopReason =
  | "stop"
  | "max_steps"
  | "max_tool_calls"
  | "repeated_call"
  | "length"
  | "error";

export interface AgentStepRecord {
  step: number;
  text: string;
  toolCalls: ToolCall[];
  finishReason: string;
}

export interface AgentRunResult {
  sessionId: string;
  stopReason: AgentStopReason;
  steps: AgentStepRecord[];
  /** 最终 assistant 文本（模型最后一次产出的文本）。 */
  text: string;
  toolCallsExecuted: number;
  error?: string;
}

export class AgentLoopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentLoopError";
  }
}

export class AgentLoop {
  static readonly KEY = "agent";

  private readonly ctx: Context;
  private readonly options: Required<
    Pick<AgentLoopOptions, "maxSteps" | "maxToolCalls" | "maxRepeatedCalls" | "hoistSystem">
  > &
    AgentLoopOptions;

  constructor(ctx: Context, options: AgentLoopOptions = {}) {
    this.ctx = ctx;
    this.options = {
      ...options,
      maxSteps: options.maxSteps ?? 8,
      maxToolCalls: options.maxToolCalls ?? 24,
      maxRepeatedCalls: options.maxRepeatedCalls ?? 3,
      hoistSystem: options.hoistSystem ?? true,
    };
  }

  /** 惰性解析依赖，以便本插件可以先于依赖被挂载。 */
  private get llm(): LlmRuntime {
    if (!this.ctx.has(LlmRuntime.KEY)) {
      throw new AgentLoopError(`AgentLoop requires the "${LlmRuntime.KEY}" service`);
    }
    return this.ctx.resolve<LlmRuntime>(LlmRuntime.KEY);
  }

  private get tools(): ToolRegistry {
    if (!this.ctx.has(ToolRegistry.KEY)) {
      throw new AgentLoopError(`AgentLoop requires the "${ToolRegistry.KEY}" service`);
    }
    return this.ctx.resolve<ToolRegistry>(ToolRegistry.KEY);
  }

  /**
   * 完整跑完一轮用户输入。
   *
   * 会写入：user 消息、assistant 消息（含工具调用）、工具结果，
   * 以及一条携带结束原因的 `agent:complete` 事件。
   */
  async run(session: Session, userMessage: string | Message): Promise<AgentRunResult> {
    const user =
      typeof userMessage === "string"
        ? userMessage
        : (userMessage.content ?? "");

    // 1. 先记录用户输入：日志先行，模型随后。
    session.appendUserMessage(user);

    const steps: AgentStepRecord[] = [];
    let toolCallsExecuted = 0;
    let stopReason: AgentStopReason = "stop";
    let text = "";
    let error: string | undefined;

    // 震荡保护：统计每个不同调用已出现的次数。
    const seenCalls = new Map<string, number>();

    try {
      for (let step = 0; step < this.options.maxSteps; step++) {
        const messages = session.deriveMessages({
          hoistSystem: this.options.hoistSystem,
        });

        const result = await this.llm.generate(messages, {
          tools: this.tools.schemas(),
          ...this.options.generateOptions,
        });

        // 2. 原样记录 assistant 本轮输出。
        const assistant = assistantMessageFrom(result);
        session.appendAssistantMessage(assistant.content, assistant.toolCalls ?? []);

        steps.push({
          step: step + 1,
          text: result.text,
          toolCalls: result.toolCalls,
          finishReason: result.finishReason,
        });
        this.ctx.emit(AGENT_STEP, { step: step + 1, result });

        if (result.text) text = result.text;

        // 3. 没有工具调用 => 本轮结束。
        if (result.toolCalls.length === 0) {
          stopReason = result.finishReason === "length" ? "length" : "stop";
          break;
        }

        // 4. 执行任何工具之前先做循环保护判断。
        let repeated = false;
        for (const call of result.toolCalls) {
          const key = `${call.name}:${stableStringify(call.arguments)}`;
          const count = (seenCalls.get(key) ?? 0) + 1;
          seenCalls.set(key, count);
          if (count > this.options.maxRepeatedCalls) repeated = true;
        }
        if (repeated) {
          stopReason = "repeated_call";
          error = `The model requested the same tool call more than ${this.options.maxRepeatedCalls} times; aborting to break a loop`;
          break;
        }

        if (toolCallsExecuted + result.toolCalls.length > this.options.maxToolCalls) {
          stopReason = "max_tool_calls";
          error = `Tool call budget exhausted (max ${this.options.maxToolCalls})`;
          break;
        }

        // 5. 逐个执行调用并记录结果。
        for (const call of result.toolCalls) {
          toolCallsExecuted++;
          let content: string;
          let isError = false;

          try {
            const outcome = await this.tools.executeTool(
              call.name,
              call.arguments,
              call.id,
            );
            content = outcome.content;
            isError = outcome.isError;
          } catch (err) {
            // 未知工具/被阻断的调用作为错误结果反馈给模型，而非致命错误：
            // 模型有机会改选其它工具自救。
            if (err instanceof ToolNotFoundError || err instanceof ToolBlockedError) {
              content = err.message;
              isError = true;
            } else {
              throw err;
            }
          }

          session.appendToolResult({
            toolCallId: call.id,
            name: call.name,
            content,
            ...(isError ? { isError: true } : {}),
          });
        }

        if (step === this.options.maxSteps - 1) {
          // 已用尽最后一个允许的轮次，而模型仍想调用工具。
          stopReason = "max_steps";
          error = `Reached max steps (${this.options.maxSteps})`;
        }
      }
    } catch (err) {
      stopReason = "error";
      error = err instanceof Error ? err.message : String(err);
    }

    session.append({
      type: AGENT_COMPLETE,
      stopReason,
      steps: steps.length,
      toolCallsExecuted,
      ...(error ? { error } : {}),
    });

    if (stopReason === "error" || stopReason === "max_steps" || stopReason === "max_tool_calls" || stopReason === "repeated_call") {
      this.ctx.emit(AGENT_ABORTED, { sessionId: session.id, stopReason, error });
    } else {
      this.ctx.emit(AGENT_COMPLETE, { sessionId: session.id, stopReason, steps: steps.length });
    }

    return {
      sessionId: session.id,
      stopReason,
      steps,
      text,
      toolCallsExecuted,
      ...(error ? { error } : {}),
    };
  }
}

/** 键名排序的确定性 JSON 序列化，供重复调用检测使用。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(",")}}`;
}
