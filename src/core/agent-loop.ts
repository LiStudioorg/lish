/**
 * Agent loop: drives the model -> tool -> model cycle until the model stops
 * asking for tools.
 *
 * Every step is written to the session log, so the transcript is a faithful,
 * replayable record of what the agent did. The loop is bounded three ways:
 *   - `maxSteps` caps model turns per run;
 *   - `maxToolCalls` caps tool executions per run;
 *   - a repeated-identical-call detector catches A->B->A->B oscillation that a
 *     plain step counter would only stop after burning the whole budget.
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
  /** Maximum model turns in one `run`. Defaults to 8. */
  maxSteps?: number;
  /** Maximum tool executions in one `run`. Defaults to 24. */
  maxToolCalls?: number;
  /**
   * Abort when the same (name + arguments) tool call is requested more than
   * this many times in one run. Defaults to 3.
   */
  maxRepeatedCalls?: number;
  /** Options forwarded to every model call. */
  generateOptions?: GenerateOptions;
  /** Fold the session into API-shaped messages (single leading system). */
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
  /** Final assistant text (the last text the model produced). */
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

  /** Lazily resolve dependencies so the plugin can be mounted before them. */
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
   * Run one user turn to completion.
   *
   * Writes: user message, assistant messages (with tool calls), tool results,
   * and an `agent:complete` event carrying the stop reason.
   */
  async run(session: Session, userMessage: string | Message): Promise<AgentRunResult> {
    const user =
      typeof userMessage === "string"
        ? userMessage
        : (userMessage.content ?? "");

    // 1. Log the user turn first: the log leads, the model follows.
    session.appendUserMessage(user);

    const steps: AgentStepRecord[] = [];
    let toolCallsExecuted = 0;
    let stopReason: AgentStopReason = "stop";
    let text = "";
    let error: string | undefined;

    // Oscillation guard: how often each distinct call has been seen.
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

        // 2. Record the assistant turn verbatim.
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

        // 3. No tool calls => the turn is done.
        if (result.toolCalls.length === 0) {
          stopReason = result.finishReason === "length" ? "length" : "stop";
          break;
        }

        // 4. Loop protection before executing anything.
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

        // 5. Execute each call and log its result.
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
            // Unknown / blocked tools are surfaced to the model, not fatal:
            // it may recover by choosing a different tool.
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
          // We used the last allowed turn and the model still wants tools.
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

/** Deterministic JSON with sorted keys, for the repeat detector. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(",")}}`;
}
