/**
 * OpenAI 兼容的 LLM Provider。
 *
 * 同一份实现可直接用于 DeepSeek、Moonshot、vLLM、Ollama 等提供
 * OpenAI 兼容接口的服务，只需改 `baseURL` 与 `model`。
 *
 * 设计原则：
 *   - 只依赖 Node 原生 `fetch`，不引入任何 HTTP SDK；
 *   - 统一类型 <-> OpenAI 线格式的双向翻译集中在本文件，
 *     上层（Session / AgentLoop）完全不需要知道 OpenAI 的存在；
 *   - 网络/协议错误一律包装成带上下文的 `OpenAIProviderError`，
 *     方便上层判断是重试还是放弃。
 */

import type {
  FinishReason,
  GenerateOptions,
  GenerateResult,
  LlmProvider,
  Message,
  ToolCall,
  ToolSchema,
} from "../llm.js";

// --- 错误类型 -------------------------------------------------------------

export class OpenAIProviderError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly body?: unknown,
    public readonly retryable: boolean = false,
  ) {
    super(message);
    this.name = "OpenAIProviderError";
  }
}

// --- 配置 -----------------------------------------------------------------

export interface OpenAIProviderOptions {
  /** API 密钥。 */
  apiKey: string;
  /** 接口根地址，如 https://api.openai.com/v1 或 https://api.deepseek.com/v1。 */
  baseURL?: string;
  /** 默认模型名。 */
  model?: string;
  /** 自定义请求头（例如某些网关需要的额外标头）。 */
  headers?: Record<string, string>;
  /** 单次请求超时（毫秒），默认 60s。 */
  timeoutMs?: number;
  /** 注入 fetch 以便测试；默认使用全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** Provider 名称，默认 "openai"。 */
  name?: string;
}

// --- OpenAI 线格式类型 ----------------------------------------------------

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    /** 注意：OpenAI 返回的是 JSON **字符串**，不是对象。 */
    arguments: string;
  };
}

type OpenAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    }
  | { role: "tool"; content: string; tool_call_id: string };

interface OpenAIChatResponse {
  id?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
  error?: { message?: string; type?: string; code?: string };
}

// --- 消息转换 -------------------------------------------------------------

/** 把统一 `Message` 翻译成 OpenAI 的 messages 数组。 */
export function toOpenAIMessages(messages: Message[]): OpenAIMessage[] {
  return messages.map((message): OpenAIMessage => {
    switch (message.role) {
      case "system":
        return { role: "system", content: message.content ?? "" };

      case "user":
        return { role: "user", content: message.content ?? "" };

      case "assistant": {
        const out: Extract<OpenAIMessage, { role: "assistant" }> = {
          role: "assistant",
          // OpenAI 要求：只有 tool_calls 时 content 必须为 null
          content: message.content && message.content.length > 0 ? message.content : null,
        };
        if (message.toolCalls && message.toolCalls.length > 0) {
          out.tool_calls = message.toolCalls.map(toOpenAIToolCall);
        }
        return out;
      }

      case "tool": {
        const tool = message.tool;
        if (!tool) {
          throw new OpenAIProviderError(
            "A tool message requires a `tool` payload",
            undefined,
            undefined,
            false,
          );
        }
        return {
          role: "tool",
          content: tool.content,
          tool_call_id: tool.toolCallId,
        };
      }

      default: {
        // 穷尽性检查：新增角色时这里会编译失败，提醒补转换逻辑。
        const never: never = message.role;
        throw new OpenAIProviderError(`Unsupported message role: ${String(never)}`);
      }
    }
  });
}

/** 统一 ToolCall -> OpenAI tool_call（参数序列化为字符串）。 */
export function toOpenAIToolCall(call: ToolCall): OpenAIToolCall {
  return {
    id: call.id,
    type: "function",
    function: {
      name: call.name,
      arguments: JSON.stringify(call.arguments ?? {}),
    },
  };
}

/** 统一 ToolSchema -> OpenAI tools 数组。 */
export function toOpenAITools(tools: ToolSchema[] | undefined) {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      ...(tool.parameters !== undefined ? { parameters: tool.parameters } : {}),
    },
  }));
}

/** OpenAI finish_reason -> 统一 FinishReason。 */
export function fromOpenAIFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "length":
      return "length";
    case "stop":
    case "end_turn":
      return "stop";
    case "content_filter":
    case null:
    case undefined:
      return "stop";
    default:
      return "stop";
  }
}

/**
 * 解析 OpenAI 返回的 tool_calls。
 *
 * 注意 `function.arguments` 是 JSON 字符串，可能是**非法 JSON**
 * （部分兼容实现会给出空串或截断内容），此处按 fail-closed 处理：
 * 解析失败时保留原始字符串到 `_rawArguments`，参数置为空对象，
 * 由上层工具执行时再报错，而不是让整个响应崩掉。
 */
export function parseOpenAIToolCalls(
  raw: OpenAIToolCall[] | undefined,
): ToolCall[] {
  if (!raw || raw.length === 0) return [];
  return raw.map((call, index) => {
    const argsText = call.function?.arguments ?? "";
    let parsed: Record<string, unknown> = {};
    try {
      const value = argsText.trim().length === 0 ? {} : JSON.parse(argsText);
      parsed =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : { value };
    } catch {
      parsed = { _rawArguments: argsText, _parseError: true };
    }
    return {
      id: call.id ?? `call_${index}`,
      name: call.function?.name ?? "",
      arguments: parsed,
    };
  });
}

/** 把 OpenAI 响应翻译成统一 GenerateResult。 */
export function fromOpenAIResponse(
  response: OpenAIChatResponse,
  providerName: string,
): GenerateResult {
  const choice = response.choices?.[0];
  if (!choice) {
    throw new OpenAIProviderError(
      "OpenAI response contained no choices",
      undefined,
      response,
      true,
    );
  }

  const message = choice.message ?? {};
  const toolCalls = parseOpenAIToolCalls(message.tool_calls);
  const text = typeof message.content === "string" ? message.content : "";

  return {
    text,
    toolCalls,
    // 有工具调用时，即使厂商给了 "stop"，也应视为 tool_calls，
    // 否则 Agent Loop 会漏掉这一轮工具执行。
    finishReason:
      toolCalls.length > 0 ? "tool_calls" : fromOpenAIFinishReason(choice.finish_reason),
    provider: providerName,
    ...(response.usage
      ? {
          usage: {
            inputTokens: response.usage.prompt_tokens,
            outputTokens: response.usage.completion_tokens,
          },
        }
      : {}),
  };
}

// --- Provider 主体 --------

export class OpenAIProvider implements LlmProvider {
  readonly name: string;
  readonly baseURL: string;
  readonly model: string;

  private readonly apiKey: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAIProviderOptions) {
    if (!options.apiKey) {
      throw new OpenAIProviderError("OpenAIProvider requires an apiKey");
    }
    this.name = options.name ?? "openai";
    // 去掉末尾斜杠，避免拼出 //chat/completions
    this.baseURL = (options.baseURL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.model = options.model ?? "gpt-4o-mini";
    this.apiKey = options.apiKey;
    this.headers = options.headers ?? {};
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    if (typeof this.fetchImpl !== "function") {
      throw new OpenAIProviderError(
        "No fetch implementation available (Node >= 18 is required)",
      );
    }
  }

  /** 组装请求体；单独提供便于测试断言。 */
  buildRequestBody(
    messages: Message[],
    options: GenerateOptions = {},
  ): Record<string, unknown> {
    const tools = toOpenAITools(
      (options.tools as ToolSchema[] | undefined) ?? undefined,
    );
    const body: Record<string, unknown> = {
      model: (options.model as string | undefined) ?? this.model,
      messages: toOpenAIMessages(messages),
    };
    if (options.temperature !== undefined) body.temperature = options.temperature;
    if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
    if (tools) body.tools = tools;
    return body;
  }

  async generate(
    messages: Message[],
    options: GenerateOptions = {},
  ): Promise<GenerateResult> {
    const url = `${this.baseURL}/chat/completions`;
    const body = this.buildRequestBody(messages, options);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
          ...this.headers,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      throw new OpenAIProviderError(
        aborted
          ? `Request to ${url} timed out after ${this.timeoutMs}ms`
          : `Network error calling ${url}: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        undefined,
        true,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new OpenAIProviderError(
        `Malformed JSON from ${url} (status ${response.status})`,
        response.status,
        text.slice(0, 500),
        response.status >= 500,
      );
    }

    if (!response.ok) {
      const payload = parsed as OpenAIChatResponse;
      const message =
        payload?.error?.message ?? `HTTP ${response.status} from ${url}`;
      throw new OpenAIProviderError(
        message,
        response.status,
        parsed,
        // 429 与 5xx 值得重试；4xx 通常是我们请求本身有问题。
        response.status === 429 || response.status >= 500,
      );
    }

    return fromOpenAIResponse(parsed as OpenAIChatResponse, this.name);
  }
}
