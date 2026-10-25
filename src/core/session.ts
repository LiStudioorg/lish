/**
 * Session：基于事件溯源的会话状态。
 *
 * 唯一真源是一条**只追加（append-only）的 JSONL 日志**。
 * 任何派生数据（例如发给 LLM 的消息列表）都不会被就地修改：
 * 它们每次都通过对日志做 fold（折叠）重新计算，因此投影随时可以从零重建。
 *
 * 日志格式：每行一个 JSON 对象，至少包含 `type` 与 `seq`。
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  assistantMessageFrom,
  type Message,
  type ToolCall,
  type ToolResult,
} from "./llm.js";

// --- 事件类型 -------------------------------------------------------------

export interface SessionEventBase {
  /** 单调递增序号，由 Session 统一盖章。 */
  seq: number;
  /** 墙上时钟时间（毫秒）。 */
  ts: number;
  /** 事件类型。 */
  type: string;
}

/** 会话创建事件。 */
export interface SessionCreatedEvent extends SessionEventBase {
  type: "session.created";
  sessionId: string;
  title?: string;
}

/** 用户消息事件。 */
export interface UserMessageEvent extends SessionEventBase {
  type: "message.user";
  content: string;
}

/** 系统提示（system prompt）消息事件。 */
export interface SystemMessageEvent extends SessionEventBase {
  type: "message.system";
  content: string;
}

/** 助手消息事件（可能同时带文本与工具调用）。 */
export interface AssistantMessageEvent extends SessionEventBase {
  type: "message.assistant";
  content?: string;
  toolCalls?: ToolCall[];
}

/** 工具执行结果事件。 */
export interface ToolResultEvent extends SessionEventBase {
  type: "tool.result";
  tool: ToolResult;
}

/** LLM Provider 切换事件（记录在会话时间线上）。 */
export interface ProviderChangedEvent extends SessionEventBase {
  type: "llm.provider-changed";
  provider?: string;
}

/** 逃生舱口：应用可在同一时间线上记录自定义领域事件。 */
export interface CustomEvent extends SessionEventBase {
  type: string;
  [key: string]: unknown;
}

export type AnySessionEvent = { seq: number; ts: number; type: string } & Record<
  string,
  unknown
>;

/** 会被投影成 LLM 消息的事件集合。 */
export type MessageEvent =
  | UserMessageEvent
  | SystemMessageEvent
  | AssistantMessageEvent
  | ToolResultEvent;

// --- 配置选项 -------------------------------------------------------------

/**
 * 内存中默认保留的事件条数上限。
 *
 * 取 5000 的理由：一轮完整对话通常产生 3–8 条事件，
 * 5000 条 ≈ 600–1600 轮，单进程内几乎不可能达到；
 * 同时 5000 条事件约占几 MB 内存，对 0.5GB 红线而言可忽略。
 */
export const DEFAULT_MAX_EVENTS = 5000;

export interface SessionOptions {
  /** 显式指定 id；否则自动生成。 */
  id?: string;
  title?: string;
  /** 可选的 JSONL 文件，每次 append 都会镜像写入其中。 */
  file?: string;
  /** 时钟注入，便于写出确定性的测试。 */
  now?: () => number;
  /** 是否记录 `session.created` 事件，默认 true。 */
  emitCreated?: boolean;
  /**
   * 严格解析模式。为 true 时，遇到损坏/截断的 JSONL 行会让 `Session.load`
   * 直接抛错，而不是跳过该行。默认 false，以便进程崩溃后仍能尽量恢复。
   */
  strict?: boolean;
  /**
   * 内存中最多保留多少个事件（滑动窗口）。
   *
   * 为什么需要：会话是 append-only 的，长时间运行的单个会话（例如挂了几个月
   * 的守护进程）会把每轮对话、每次工具输出、每条轨迹事件都留在内存里，
   * 累积到几十万条后 RSS 会突破 P0 红线（0.5GB）。
   *
   * 注意窗口只裁剪**内存**，磁盘上的 JSONL 仍是完整历史——
   * `deriveMessages` 与分页接口读取的是被裁剪后的窗口，
   * 需要更早的历史时应从磁盘重新加载（`Session.load`）。
   *
   * 默认 5000 条，约等于 1000+ 轮对话，远超实际交互长度。
   */
  maxEvents?: number;
}

/** `deriveMessages` 投影的选项。 */
export interface DeriveOptions {
  /**
   * 把所有 system 消息合并为一条并置于数组最前。真实厂商 API 通常只接受
   * 一条 system prompt 且必须排在最前。默认 false（保持日志中的原始顺序）。
   */
  hoistSystem?: boolean;
}

// --- Session 主体 ---------------------------------------------------------

export class Session {
  readonly id: string;
  readonly title?: string;
  /** 加载时坏行是否视为致命错误。 */
  readonly strict: boolean;
  /** 内存事件窗口上限（见 SessionOptions.maxEvents）。 */
  private readonly maxEvents: number;

  private readonly events: AnySessionEvent[] = [];
  private readonly file?: string;
  private readonly now: () => number;
  /** 串行化文件写入，避免并发 append 导致行交错。 */
  private writeChain: Promise<void> = Promise.resolve();
  private seq = 0;

  constructor(options: SessionOptions = {}) {
    this.id = options.id ?? generateId();
    this.title = options.title;
    this.file = options.file;
    this.now = options.now ?? (() => Date.now());
    this.strict = options.strict ?? false;
    this.maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;

    if (options.emitCreated !== false) {
      this.append({ type: "session.created", sessionId: this.id, ...(this.title !== undefined ? { title: this.title } : {}) });
    }
  }

  /**
   * 追加一个事件。
   *
   * `seq` 与 `ts` 由 Session 统一盖章，会覆盖调用方传入的值，
   * 以保证日志自身的一致性。返回实际存储的事件。
   */
  append<T extends { type: string }>(event: T): T & { seq: number; ts: number } {
    if (!event || typeof event.type !== "string" || event.type.length === 0) {
      throw new Error("Session event requires a non-empty `type`");
    }
    const stored = {
      ...event,
      seq: this.seq++,
      ts: this.now(),
    } as T & { seq: number; ts: number };

    this.events.push(stored as unknown as AnySessionEvent);

    // 滑动窗口：超出上限时一次性裁掉最旧的一批（批量裁剪比逐条 shift 快得多）
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }

    if (this.file) {
      const line = JSON.stringify(stored) + "\n";
      this.writeChain = this.writeChain.then(async () => {
        await mkdir(dirname(this.file as string), { recursive: true });
        await appendFile(this.file as string, line, "utf8");
      });
    }
    return stored;
  }

  /** 常用事件类型的便捷封装。 */
  appendUserMessage(content: string): UserMessageEvent {
    return this.append({ type: "message.user", content }) as UserMessageEvent;
  }

  appendSystemMessage(content: string): SystemMessageEvent {
    return this.append({ type: "message.system", content }) as SystemMessageEvent;
  }

  appendAssistantMessage(
    content: string | undefined,
    toolCalls: ToolCall[] = [],
  ): AssistantMessageEvent {
    const event: { type: "message.assistant"; content?: string; toolCalls?: ToolCall[] } = {
      type: "message.assistant",
    };
    if (content !== undefined) event.content = content;
    if (toolCalls.length > 0) event.toolCalls = toolCalls;
    return this.append(event) as AssistantMessageEvent;
  }

  appendToolResult(tool: ToolResult): ToolResultEvent {
    return this.append({ type: "tool.result", tool }) as ToolResultEvent;
  }

  /** 全部事件，按追加顺序。 */
  get log(): readonly AnySessionEvent[] {
    return this.events;
  }

  get length(): number {
    return this.events.length;
  }

  /** 当前全部日志的 JSONL 文本表示。 */
  toJSONL(): string {
    return this.events.map((e) => JSON.stringify(e)).join("\n") + (this.events.length ? "\n" : "");
  }

  /** 等待尚未落盘的文件写入完成。 */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  /**
   * 把日志折叠成发给 LLM 的消息列表。
   *
   * 投影规则：
   *   - `message.user` / `message.system` -> user / system 消息；
   *   - `message.assistant` -> assistant 消息（保留 toolCalls）；
   *   - `tool.result` -> 引用对应调用 id 的 `tool` 消息；
   *   - 其余事件类型一律忽略。
   *
   * 传入 `{ hoistSystem: true }` 时，所有 system 消息会被合并成一条并置顶
   * （见 `hoistSystemPrompt`）。
   */
  deriveMessages(options: DeriveOptions = {}): Message[] {
    const messages = this.events.reduce<Message[]>((acc, event) => {
      const projected = projectEvent(event);
      if (projected) acc.push(projected);
      return acc;
    }, []);
    return options.hoistSystem ? hoistSystemPrompt(messages) : messages;
  }

  /**
   * 折叠日志，并把 system 消息合并为唯一一条置顶消息。
   * 等价于 `deriveMessages({ hoistSystem: true })` 的便捷写法。
   */
  deriveApiMessages(): Message[] {
    return this.deriveMessages({ hoistSystem: true });
  }

  // --- 持久化 -------------------------------------------------------------

  /** 把完整日志写入 `file`，覆盖原内容。 */
  async persist(file = this.file): Promise<string> {
    if (!file) {
      throw new Error("persist() requires a target file path");
    }
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, this.toJSONL(), "utf8");
    return file;
  }

  /**
   * 从 JSONL 文件重建会话。
   * 磁盘上已有的事件原样保留（不重新盖 seq/ts），
   * 序号计数器从现有最大 `seq` 之后继续。
   */
  static async load(file: string, options: Omit<SessionOptions, "file"> = {}): Promise<Session> {
    const content = await readFile(file, "utf8");
    const rawEvents = parseJsonl(content, { strict: options.strict, file });

    // 日志是唯一真源：身份信息从 `session.created` 事件恢复，
    // 而不是每次加载都生成新 id。显式传入的 options 优先级更高。
    const meta = readSessionMeta(rawEvents);
    const session = new Session({
      ...options,
      id: options.id ?? meta.id,
      title: options.title ?? meta.title,
      file,
      emitCreated: false,
    });
    session.restore(rawEvents);
    return session;
  }

  /** 从已解析的事件数组恢复（JSONL 记录的原样形式）。 */
  restore(rawEvents: unknown[]): void {
    let maxSeq = -1;
    for (const raw of rawEvents) {
      if (!raw || typeof raw !== "object") continue;
      const event = raw as AnySessionEvent;
      if (typeof event.type !== "string") continue;
      this.events.push(event);
      if (typeof event.seq === "number" && event.seq > maxSeq) maxSeq = event.seq;
    }
    this.seq = maxSeq + 1;
  }
}

// --- 投影（fold） ---------------------------------------------------------

function projectEvent(event: AnySessionEvent): Message | undefined {
  switch (event.type) {
    case "message.user":
      return { role: "user", content: String(event.content ?? "") };

    case "message.system":
      return { role: "system", content: String(event.content ?? "") };

    case "message.assistant": {
      const message: Message = { role: "assistant" };
      if (typeof event.content === "string" && event.content.length > 0) {
        message.content = event.content;
      }
      if (Array.isArray(event.toolCalls) && event.toolCalls.length > 0) {
        message.toolCalls = event.toolCalls as ToolCall[];
      }
      if (message.content === undefined && message.toolCalls === undefined) {
        message.content = "";
      }
      return message;
    }

    case "tool.result": {
      const tool = event.tool as ToolResult | undefined;
      if (!tool) return undefined;
      return { role: "tool", tool };
    }

    default:
      // session.created、llm.provider-changed、自定义事件：都不是消息。
      return undefined;
  }
}

/** 把 `GenerateResult` 转换成消息事件的载荷列表。 */
export function assistantEventsFrom(result: {
  text: string;
  toolCalls: ToolCall[];
}): Array<{ type: "message.assistant"; content?: string; toolCalls?: ToolCall[] }> {
  const message = assistantMessageFrom({
    text: result.text,
    toolCalls: result.toolCalls,
    finishReason: result.toolCalls.length ? "tool_calls" : "stop",
    provider: "session",
  });
  // 完全跳过空的 assistant 轮次：它们只会给日志增加噪音。
  if (!message.content && !message.toolCalls) return [];
  return [
    {
      type: "message.assistant",
      ...(message.content !== undefined ? { content: message.content } : {}),
      ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
    },
  ];
}

// --- 辅助函数 -------------------------------------------------------------

/** 从首个 `session.created` 事件中恢复会话身份信息。 */
function readSessionMeta(rawEvents: unknown[]): {
  id?: string;
  title?: string;
} {
  for (const raw of rawEvents) {
    if (!raw || typeof raw !== "object") continue;
    const event = raw as Record<string, unknown>;
    if (event.type !== "session.created") continue;
    const id = typeof event.sessionId === "string" ? event.sessionId : undefined;
    const title = typeof event.title === "string" ? event.title : undefined;
    return { id, title };
  }
  return {};
}

export class SessionCorruptLogError extends Error {
  constructor(
    public readonly file: string,
    public readonly line: number,
    public readonly cause: unknown,
  ) {
    super(
      `Corrupt JSONL in "${file}" at line ${line}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "SessionCorruptLogError";
  }
}

function parseJsonl(
  content: string,
  options: { strict?: boolean; file?: string } = {},
): unknown[] {
  const out: unknown[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] as string).trim();
    if (trimmed.length === 0) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch (err) {
      if (options.strict) {
        throw new SessionCorruptLogError(
          options.file ?? "<memory>",
          i + 1,
          err,
        );
      }
      // 非严格模式：末行被截断（写入过程中崩溃）时跳过而不报错，
      // 使持久日志的其余部分仍可恢复。
      continue;
    }
  }
  return out;
}

/**
 * 把所有 system 消息合并成一条置顶消息。
 *
 * 厂商 API 通常只接受一条 system prompt 且需置于首位。这里把每条 system
 * 消息的正文（用空行连接）全部保留，而不是丢弃后面那些——否则会静默丢失指令。
 */
export function hoistSystemPrompt(messages: Message[]): Message[] {
  const systemParts: string[] = [];
  const rest: Message[] = [];

  for (const message of messages) {
    if (message.role === "system") {
      const text = message.content ?? "";
      if (text.length > 0) systemParts.push(text);
    } else {
      rest.push(message);
    }
  }

  if (systemParts.length === 0) return rest;
  return [{ role: "system", content: systemParts.join("\n\n") }, ...rest];
}

let idCounter = 0;
function generateId(): string {
  idCounter++;
  return `sess_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}
