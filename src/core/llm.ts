/**
 * Vendor-neutral LLM seam.
 *
 * Everything above this layer speaks `Message` / `ToolCall` / `GenerateResult`;
 * concrete providers translate to their own wire format. This keeps the
 * session log and the kernel independent of any single vendor SDK.
 */

import type { Context } from "../kernel/context.js";

// --- Core message types ---------------------------------------------------

export type MessageRole = "system" | "user" | "assistant" | "tool";

/** A request from the assistant to invoke a tool. */
export interface ToolCall {
  id: string;
  name: string;
  /** Parsed arguments; providers are responsible for JSON decoding. */
  arguments: Record<string, unknown>;
}

/** Result of executing a `ToolCall`, fed back to the model. */
export interface ToolResult {
  toolCallId: string;
  name?: string;
  /** Serialised result payload. */
  content: string;
  isError?: boolean;
}

export interface TextPart {
  type: "text";
  text: string;
}

export interface ToolCallPart {
  type: "tool_call";
  call: ToolCall;
}

export type ContentPart = TextPart | ToolCallPart;

/**
 * One entry in the conversation sent to the model.
 *
 * `tool` messages carry the result of a tool call and reference it by id, so a
 * whole round-trip survives a serialise/deserialise cycle.
 */
export interface Message {
  role: MessageRole;
  /** Plain text content; optional when only tool calls are present. */
  content?: string;
  /** Assistant tool calls (role === "assistant"). */
  toolCalls?: ToolCall[];
  /** Tool result payload (role === "tool"). */
  tool?: ToolResult;
}

// --- Generation options / result -----------------------------------------

export interface ToolSchema {
  name: string;
  description?: string;
  /** JSON Schema for the arguments object. */
  parameters?: Record<string, unknown>;
}

export interface GenerateOptions {
  /** Provider-specific model identifier. */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** Tools the model may call in this turn. */
  tools?: ToolSchema[];
  /** Arbitrary pass-through for provider-specific knobs. */
  [key: string]: unknown;
}

export type FinishReason = "stop" | "tool_calls" | "length" | "error";

export interface GenerateResult {
  /** Assistant text, if any. */
  text: string;
  /** Tool calls requested by the model. */
  toolCalls: ToolCall[];
  finishReason: FinishReason;
  /** Provider that produced this result (useful for logging/routing). */
  provider: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

// --- Provider seam --------------------------------------------------------

/** Anything that can turn a message list into a model response. */
export interface LlmProvider {
  /** Stable name used in logs and results. */
  readonly name: string;
  generate(
    messages: Message[],
    options: GenerateOptions,
  ): Promise<GenerateResult>;
}

// --- MockProvider ---------------------------------------------------------

/**
 * Deterministic stand-in for a real model.
 *
 * Behaviour: if the history already contains a tool result, it "summarises"
 * it in plain text and stops. Otherwise it asks for one tool call (default
 * `echo`), so the full call/observe loop can be exercised without a network.
 */
export interface MockProviderOptions {
  /** Tool to request before any tool result exists. Defaults to "echo". */
  toolName?: string;
  /** Argument payload for that tool call. */
  toolArguments?: Record<string, unknown>;
  /** Text returned once tool results are present. */
  summaryPrefix?: string;
  /** Artificial latency, useful for testing concurrency. */
  delayMs?: number;
}

export class MockProvider implements LlmProvider {
  readonly name: string;
  private readonly options: Required<MockProviderOptions>;
  private seq = 0;

  constructor(options: MockProviderOptions = {}, name = "mock") {
    this.name = name;
    this.options = {
      toolName: options.toolName ?? "echo",
      toolArguments: options.toolArguments ?? { text: "hello from mock" },
      summaryPrefix: options.summaryPrefix ?? "Summary of tool results",
      delayMs: options.delayMs ?? 0,
    };
  }

  /** Number of times `generate` was called (handy in tests). */
  get callCount(): number {
    return this.seq;
  }

  async generate(
    messages: Message[],
    _options: GenerateOptions = {},
  ): Promise<GenerateResult> {
    this.seq++;
    if (this.options.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.options.delayMs));
    }

    const toolMessages = messages.filter((m) => m.role === "tool");

    if (toolMessages.length > 0) {
      const lines = toolMessages.map(
        (m) => `- ${m.tool?.name ?? m.tool?.toolCallId ?? "tool"}: ${m.tool?.content ?? ""}`,
      );
      return {
        text: `${this.options.summaryPrefix} (${toolMessages.length}):\n${lines.join("\n")}`,
        toolCalls: [],
        finishReason: "stop",
        provider: this.name,
        usage: { inputTokens: estimateTokens(messages), outputTokens: 24 },
      };
    }

    const call: ToolCall = {
      id: `call_${this.name}_${this.seq}`,
      name: this.options.toolName,
      arguments: { ...this.options.toolArguments },
    };
    return {
      text: "",
      toolCalls: [call],
      finishReason: "tool_calls",
      provider: this.name,
      usage: { inputTokens: estimateTokens(messages), outputTokens: 12 },
    };
  }
}

/** Rough token estimate so mocks produce plausible usage numbers. */
function estimateTokens(messages: Message[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += (m.content ?? "").length;
    chars += m.tool?.content.length ?? 0;
    for (const c of m.toolCalls ?? []) {
      chars += JSON.stringify(c.arguments).length + c.name.length;
    }
  }
  return Math.ceil(chars / 4);
}

// --- LlmRuntime -----------------------------------------------------------

export class NoProviderError extends Error {
  constructor() {
    super("No LLM provider is configured; call llm.setProvider() first");
    this.name = "NoProviderError";
  }
}

export interface LlmRuntimeOptions {
  /** Provider installed at mount time. */
  provider?: LlmProvider;
}

/**
 * Kernel service that owns "the currently selected provider".
 *
 * Mounted as `ctx.llm`. Switching providers is hot: the next `generate` uses
 * whatever provider is current, and a `llm:provider-changed` event is emitted
 * so observers (UI, logging, metrics) can react.
 */
export class LlmRuntime {
  static readonly KEY = "llm";
  static readonly PROVIDER_CHANGED = "llm:provider-changed";

  private provider: LlmProvider | undefined;
  private readonly ctx: Context;
  private history: Message[] = [];
  private readonly log: GenerateResult[] = [];

  constructor(ctx: Context, options: LlmRuntimeOptions = {}) {
    this.ctx = ctx;
    this.provider = options.provider;
  }

  get currentProvider(): LlmProvider | undefined {
    return this.provider;
  }

  get providerName(): string | undefined {
    return this.provider?.name;
  }

  /** Hot-swap the provider. Undefined clears it. */
  setProvider(provider: LlmProvider | undefined): void {
    const previous = this.provider?.name;
    this.provider = provider;
    this.ctx.emit(LlmRuntime.PROVIDER_CHANGED, {
      previous,
      current: provider?.name,
      provider,
    });
  }

  /**
   * Stateless call: generate from an explicit message list.
   * Use `ask()` when you want the runtime to track conversation history.
   */
  async generate(
    messages: Message[],
    options: GenerateOptions = {},
  ): Promise<GenerateResult> {
    if (!this.provider) {
      throw new NoProviderError();
    }
    const result = await this.provider.generate(messages, options);
    this.log.push(result);
    return result;
  }

  /** Append `messages` to the internal history, generate, and record it. */
  async ask(messages: Message[], options: GenerateOptions = {}): Promise<GenerateResult> {
    this.history.push(...messages);
    const result = await this.generate(this.history, options);
    this.history.push(assistantMessageFrom(result));
    return result;
  }

  /** Read-only view of the tracked conversation. */
  get messages(): readonly Message[] {
    return this.history;
  }

  /** Replace the tracked conversation (e.g. after loading a session). */
  resetHistory(messages: Message[] = []): void {
    this.history = [...messages];
  }

  /** Every result produced by this runtime, in order. */
  get results(): readonly GenerateResult[] {
    return this.log;
  }
}

/** Convert a result into the assistant message that represents it. */
export function assistantMessageFrom(result: GenerateResult): Message {
  const message: Message = { role: "assistant" };
  if (result.text) message.content = result.text;
  if (result.toolCalls.length > 0) message.toolCalls = result.toolCalls;
  if (!message.content && !message.toolCalls) message.content = "";
  return message;
}

/** Build tool-result messages for a batch of calls. */
export function toolResultMessage(
  call: ToolCall,
  content: string,
  isError = false,
): Message {
  return {
    role: "tool",
    tool: {
      toolCallId: call.id,
      name: call.name,
      content,
      ...(isError ? { isError: true } : {}),
    },
  };
}
