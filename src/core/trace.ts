/**
 * 轨迹事件模型（Trace）。
 *
 * 依据 AGENTS.md 第 5 条：每个事件必须携带 traceId、毫秒级 timestamp、
 * duration 与 tokenUsage，用于事后审计与问题定位。
 *
 * 与 Session 的 JSONL 日志不同，轨迹事件是**运行期**的富数据结构，
 * 面向 UI 展示（时间轴、条形图、详情面板），因此字段更完整。
 */

/** 轨迹事件类型。 */
export type TraceEventType =
  | "run.start"
  | "step.thinking"
  | "stream.delta"
  | "tool.call"
  | "tool.result"
  | "answer"
  | "run.end"
  | "error";

/** Token 用量。 */
export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** 首个 token 的延迟（毫秒）。 */
  firstTokenMs?: number;
  /** 每秒 token 数。 */
  tokensPerSecond?: number;
}

/** 一条轨迹事件。 */
export interface TraceEvent {
  /** 事件唯一 id，前端用作列表 key。 */
  id: string;
  /** 贯穿一次 run 的链路标识。 */
  traceId: string;
  /** 所属会话。 */
  sessionId: string;
  /** 事件类型。 */
  type: TraceEventType;
  /** 第几轮（从 1 开始）。 */
  step: number;
  /** 毫秒级时间戳。 */
  timestamp: number;
  /** 耗时（毫秒）；瞬时事件为 0。 */
  duration: number;
  /** 简要标题，用于时间轴单行展示。 */
  title: string;
  /** 关联的工具名（tool.call / tool.result）。 */
  toolName?: string;
  /** 工具调用 id，用于配对 call 与 result。 */
  callId?: string;
  /** 入参（已解析）。 */
  args?: Record<string, unknown>;
  /** 结果文本。 */
  result?: string;
  /** 是否为错误结果。 */
  isError?: boolean;
  /** Token 与性能指标。 */
  tokenUsage?: TokenUsage;
  /** 该工具允许的 JSON Schema（来自 ToolRegistry）。 */
  schema?: Record<string, unknown>;
  /** 解析失败时保留的原始文本。 */
  rawPayload?: string;
  /** 错误信息。 */
  error?: string;
}

/** 轨迹容器：按 traceId 分组保存在内存中，并限制总量防泄漏。 */
export class TraceStore {
  /** 单会话最多保留的事件数，超出按 FIFO 淘汰。 */
  private readonly maxPerSession: number;
  private readonly bySession = new Map<string, TraceEvent[]>();
  private seq = 0;

  constructor(maxPerSession = 2000) {
    this.maxPerSession = maxPerSession;
  }

  /** 追加事件，返回带 id 的完整事件。 */
  append(event: Omit<TraceEvent, "id">): TraceEvent {
    const id = `evt-${Date.now().toString(36)}-${++this.seq}`;
    const full: TraceEvent = { ...event, id };

    const list = this.bySession.get(event.sessionId) ?? [];
    list.push(full);
    // 超出上限时淘汰最旧的，避免长时间运行内存膨胀
    if (list.length > this.maxPerSession) {
      list.splice(0, list.length - this.maxPerSession);
    }
    this.bySession.set(event.sessionId, list);
    return full;
  }

  /** 读取某会话的全部事件（按时间顺序）。 */
  list(sessionId: string): TraceEvent[] {
    return [...(this.bySession.get(sessionId) ?? [])];
  }

  /** 清空某会话。 */
  clear(sessionId: string): void {
    this.bySession.delete(sessionId);
  }

  /** 当前总事件数（可观测性用）。 */
  get size(): number {
    let n = 0;
    for (const list of this.bySession.values()) n += list.length;
    return n;
  }
}

/**
 * 生成一个 traceId。
 *
 * 格式：trc_<时间戳36进制>_<随机>，便于按时间排序与肉眼辨识。
 */
export function newTraceId(): string {
  return `trc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
