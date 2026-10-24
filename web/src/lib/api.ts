/**
 * 与 lish 后端通信的客户端。
 *
 * 后端 POST /api/chat 返回 AI SDK 数据流协议：
 *   0:"文本"   正文增量帧
 *   2:[{...}]  data 帧（工具事件、会话信息）
 *   每个帧以换行分隔，连接关闭即流结束。
 *
 * 所有请求走同源相对路径 /api/*，由后端（生产）或 Next rewrites（开发）转发，
 * 因此手机通过局域网 IP 访问时不会指向错误的主机。
 */

/** 后端地址：默认同源相对路径。 */
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";

export interface ToolStreamEvent {
  type: "session" | "thinking" | "tool_call" | "tool_result" | "aborted" | "done";
  runId?: string;
  sessionId?: string;
  step?: number;
  callId?: string;
  name?: string;
  /** 工具参数，以 JSON 字符串传输 */
  argsJson?: string;
  content?: string;
  isError?: boolean;
  durationMs?: number;
  messageCount?: number;
  stopReason?: string;
  error?: string;
}

type Frame =
  | { kind: "text"; text: string }
  | { kind: "data"; payload: unknown }
  | { kind: "other" };

/** 解析单行协议帧。 */
function parseFrame(line: string): Frame | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;

  const colon = trimmed.indexOf(":");
  if (colon <= 0) return { kind: "other" };

  const prefix = trimmed.slice(0, colon);
  const body = trimmed.slice(colon + 1);

  try {
    if (prefix === "0") {
      const value = JSON.parse(body);
      return { kind: "text", text: typeof value === "string" ? value : String(value) };
    }
    if (prefix === "2" || prefix === "a" || prefix === "9" || prefix === "b") {
      return { kind: "data", payload: JSON.parse(body) };
    }
    if (prefix === "d") {
      return { kind: "data", payload: { type: "done" } };
    }
  } catch {
    return { kind: "other" };
  }
  return { kind: "other" };
}

/** data 帧可能是单个对象或数组。 */
function flattenPayload(payload: unknown): ToolStreamEvent[] {
  if (Array.isArray(payload)) {
    return payload.filter(
      (p): p is ToolStreamEvent => !!p && typeof p === "object" && "type" in p,
    );
  }
  if (payload && typeof payload === "object" && "type" in (payload as Record<string, unknown>)) {
    return [payload as ToolStreamEvent];
  }
  return [];
}

export interface ChatCallbacks {
  onText: (delta: string) => void;
  onEvent: (event: ToolStreamEvent) => void;
  onDone: (info: { stopReason?: string; error?: string }) => void;
  onError: (error: Error) => void;
}

/** 发起一次对话请求，流式消费响应。 */
export function streamChat(
  message: string,
  sessionId: string | null,
  callbacks: ChatCallbacks,
): { abort: () => void; done: Promise<void> } {
  const controller = new AbortController();

  const done = (async () => {
    try {
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, sessionId: sessionId ?? undefined }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`服务端返回 ${res.status}${text ? `：${text.slice(0, 200)}` : ""}`);
      }
      if (!res.body) throw new Error("响应没有可读取的流");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let stopReason: string | undefined;
      let lastError: string | undefined;

      const handleLine = (line: string) => {
        const frame = parseFrame(line);
        if (!frame || frame.kind === "other") return;

        if (frame.kind === "text") {
          if (frame.text.length > 0) callbacks.onText(frame.text);
          return;
        }

        for (const event of flattenPayload(frame.payload)) {
          if (event.type === "done") {
            stopReason = event.stopReason;
            if (event.error) lastError = event.error;
          }
          if (event.type === "aborted" && event.error) {
            lastError = event.error;
          }
          callbacks.onEvent(event);
        }
      };

      for (;;) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        buffer += decoder.decode(value, { stream: true });

        let newline: number;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          handleLine(line);
        }
      }
      if (buffer.trim().length > 0) handleLine(buffer);

      callbacks.onDone({ stopReason, error: lastError });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        callbacks.onDone({ stopReason: "aborted" });
        return;
      }
      callbacks.onError(err instanceof Error ? err : new Error(String(err)));
    }
  })();

  return { abort: () => controller.abort(), done };
}

// --- 配置接口 -------------------------------------------------------------

export interface ServerConfig {
  baseURL: string;
  model: string;
  maxSteps: number;
  workspaceRoot: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
  providerName: string;
  tools: string[];
}

export async function fetchConfig(): Promise<ServerConfig | null> {
  try {
    const res = await fetch(`${API_BASE}/api/config`);
    if (!res.ok) return null;
    return (await res.json()) as ServerConfig;
  } catch {
    return null;
  }
}

export interface ConfigPatch {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  maxSteps?: number;
}

export async function updateConfig(
  patch: ConfigPatch,
): Promise<{ ok: boolean; error?: string; config?: Partial<ServerConfig> }> {
  try {
    const res = await fetch(`${API_BASE}/api/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      config?: Partial<ServerConfig>;
    };
    if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` };
    return { ok: true, config: data.config };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
