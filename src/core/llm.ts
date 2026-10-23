/**
 * 厂商无关的 LLM 接缝（seam）。
 *
 * 本层之上的所有代码只认识 `Message` / `ToolCall` / `GenerateResult` 这些统一类型；
 * 具体厂商的线格式（wire format）翻译由各 Provider 自己负责。
 * 这样会话日志与内核就完全不依赖任何单一厂商的 SDK。
 */

import type { Context } from "../kernel/context.js";

// --- 核心消息类型 ---------------------------------------------------------

/** 消息角色：system / user / assistant / tool。 */
export type MessageRole = "system" | "user" | "assistant" | "tool";

/** 模型请求调用某个工具。 */
export interface ToolCall {
  /** 调用 id，用于把工具结果回填到对应的调用上。 */
  id: string;
  /** 工具名。 */
  name: string;
  /** 已解析的参数对象；各 Provider 负责完成 JSON 解码。 */
  arguments: Record<string, unknown>;
}

/** 工具执行结果，会回传给模型。 */
export interface ToolResult {
  /** 对应的工具调用 id。 */
  toolCallId: string;
  /** 工具名（便于日志阅读）。 */
  name?: string;
  /** 序列化后的结果内容。 */
  content: string;
  /** 该次调用是否失败。 */
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
 * 发给模型的一条对话消息。
 *
 * `tool` 角色的消息携带某次工具调用的结果，并通过 id 反向引用该调用，
 * 因此一次完整的「调用—观察」往返可以经受序列化/反序列化而不失真。
 */
export interface Message {
  role: MessageRole;
  /** 纯文本内容；只含工具调用时可以为空。 */
  content?: string;
  /** 助手发起的工具调用（仅 role === "assistant" 时有效）。 */
  toolCalls?: ToolCall[];
  /** 工具结果载荷（仅 role === "tool" 时有效）。 */
  tool?: ToolResult;
}

// --- 生成参数与结果 -------------------------------------------------------

/** 暴露给模型的工具描述（JSON Schema 形式）。 */
export interface ToolSchema {
  name: string;
  description?: string;
  /** 参数对象的 JSON Schema。 */
  parameters?: Record<string, unknown>;
}

export interface GenerateOptions {
  /** 厂商特定的模型标识。 */
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** 本轮允许模型调用的工具。 */
  tools?: ToolSchema[];
  /**
   * 文本增量回调（Token 级流式）。
   *
   * Provider 每收到一段文本增量就立即调用它，上层据此实现打字机效果。
   * 注意：回调触发时 `generate` 尚未返回，最终仍会返回聚合后的完整结果。
   */
  onTextDelta?: (delta: string) => void;
  /** 其余厂商特定参数原样透传。 */
  [key: string]: unknown;
}

/** 结束原因：正常结束 / 请求工具 / 达到长度上限 / 出错。 */
export type FinishReason = "stop" | "tool_calls" | "length" | "error";

export interface GenerateResult {
  /** 助手输出的文本，可能为空。 */
  text: string;
  /** 模型请求的工具调用。 */
  toolCalls: ToolCall[];
  /** 结束原因。 */
  finishReason: FinishReason;
  /** 产出该结果的 Provider 名称，便于日志与路由。 */
  provider: string;
  /** Token 用量（若厂商返回）。 */
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
}

// --- Provider 接缝 --------------------------------------------------------

/** 任何能把「消息列表」变成「模型响应」的实现都算 Provider。 */
export interface LlmProvider {
  /** 稳定名称，会出现在日志与结果里。 */
  readonly name: string;
  generate(
    messages: Message[],
    options: GenerateOptions,
  ): Promise<GenerateResult>;
}

// --- MockProvider 模拟 Provider ---

/**
 * 确定性的模型替身，用于无网络环境下的测试。
 *
 * 行为：若历史中已存在工具结果，则用纯文本「总结」这些结果并结束；
 * 否则请求一次工具调用（默认 `echo`），从而可在不联网的情况下
 * 完整跑通「调用—观察」闭环。
 */
export interface MockProviderOptions {
  /** 在尚未出现工具结果时所请求的工具名，默认 "echo"。 */
  toolName?: string;
  /** 该工具调用的参数载荷。 */
  toolArguments?: Record<string, unknown>;
  /** 出现工具结果后返回文本的前缀。 */
  summaryPrefix?: string;
  /** 人为延迟（毫秒），用于测试并发行为。 */
  delayMs?: number;
  /** 模拟流式时每块字符数，默认 3。 */
  chunkSize?: number;
  /** 模拟流式时块间间隔（毫秒），默认 50。 */
  chunkDelayMs?: number;
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
      chunkSize: options.chunkSize ?? 3,
      chunkDelayMs: options.chunkDelayMs ?? 50,
    };
  }

  /** `generate` 被调用的次数（测试断言用）。 */
  get callCount(): number {
    return this.seq;
  }

  /**
   * 把文本切块逐段回调，模拟真实模型的 Token 流。
   * 默认每块 3 个字符、间隔 50ms，可由构造参数调整。
   */
  private async emitChunks(
    text: string,
    onDelta: (delta: string) => void,
  ): Promise<void> {
    const size = Math.max(1, this.options.chunkSize);
    for (let i = 0; i < text.length; i += size) {
      onDelta(text.slice(i, i + size));
      if (this.options.chunkDelayMs > 0) {
        await new Promise((r) => setTimeout(r, this.options.chunkDelayMs));
      }
    }
  }

  async generate(
    messages: Message[],
    options: GenerateOptions = {},
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
      const text = `${this.options.summaryPrefix} (${toolMessages.length}):\n${lines.join("\n")}`;

      // 模拟流式：按小块吐出文本，每块之间 sleep，便于无 Key 时验证打字机效果。
      if (typeof options.onTextDelta === "function") {
        await this.emitChunks(text, options.onTextDelta);
      }

      return {
        text,
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

/** 粗略估算 token 数，让 Mock 也能给出看似合理的用量。 */
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

// --- LlmRuntime 运行时 ---

export class NoProviderError extends Error {
  constructor() {
    super("No LLM provider is configured; call llm.setProvider() first");
    this.name = "NoProviderError";
  }
}

export interface LlmRuntimeOptions {
  /** 挂载时即安装的 Provider。 */
  provider?: LlmProvider;
}

/**
 * 内核服务：持有「当前选中的 Provider」。
 *
 * 以 `ctx.llm` 挂载。切换 Provider 是热切换：下一次 `generate` 立即使用新的
 * Provider，同时发出 `llm:provider-changed` 事件，供观察者（UI、日志、指标）响应。
 *
 * 注意：本运行时**不维护任何对话历史**。会话的唯一真源是 `Session` 的追加日志，
 * Agent Loop 每次都以 `session.deriveApiMessages()` 作为唯一输入。
 * 这里只保留一份「生成结果流水」（`results`）用于审计，它不是对话状态。
 */
export class LlmRuntime {
  static readonly KEY = "llm";
  static readonly PROVIDER_CHANGED = "llm:provider-changed";

  private provider: LlmProvider | undefined;
  private readonly ctx: Context;
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

  /** 热切换 Provider；传入 undefined 表示清空。 */
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
   * 无状态生成：完全由调用方提供消息列表。
   *
   * 运行时不会记住这次调用，也不会把它拼进任何隐式历史；
   * 对话状态的记录与回放一律由 `Session` 负责。
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

  /**
   * 便捷调用（无状态）。
   *
   * 等价于 `generate()`：`messages` 必须由调用方完整给出。
   * 早期版本会在这里自行累积 `history`，导致出现第二个「对话真源」，
   * 现已移除——请改用 `AgentLoop.run(session, ...)`，或自行从 `Session` 折叠消息。
   */
  async ask(
    messages: Message[],
    options: GenerateOptions = {},
  ): Promise<GenerateResult> {
    return this.generate(messages, options);
  }

  /** 本运行时产出过的所有结果，按时间顺序。 */
  get results(): readonly GenerateResult[] {
    return this.log;
  }
}

/** 把生成结果转换成代表它的 assistant 消息。 */
export function assistantMessageFrom(result: GenerateResult): Message {
  const message: Message = { role: "assistant" };
  if (result.text) message.content = result.text;
  if (result.toolCalls.length > 0) message.toolCalls = result.toolCalls;
  if (!message.content && !message.toolCalls) message.content = "";
  return message;
}

/** 为一次工具调用构造 tool 角色的结果消息。 */
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
