/**
 * assistant-ui 运行时适配层。
 *
 * 把 AI SDK `useChat` 的消息流桥接到 assistant-ui 的运行时，
 * 使 Thread / Composer 等组件能够渲染我们的会话。
 *
 * 为什么用 useChat 而不是 useExternalStoreRuntime：
 *   后端已经输出 AI SDK 数据流协议（0:/2:/a: 帧），useChat 原生支持解析；
 *   自研 store 反而要重复实现解析逻辑。
 */

import { useMemo } from "react";
import { useChat } from "@ai-sdk/react";
import {
  AssistantRuntimeProvider,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";

/** 后端通过 data 帧推送的工具事件（与 src/server.ts 的 ToolStreamEvent 对应）。 */
export interface ToolEventData {
  type: "session" | "thinking" | "tool_call" | "tool_result" | "aborted" | "done";
  runId?: string;
  step?: number;
  callId?: string;
  name?: string;
  argsJson?: string;
  content?: string;
  isError?: boolean;
  durationMs?: number;
  messageCount?: number;
  stopReason?: string;
  error?: string;
  sessionId?: string;
}

/** 把 useChat 的 UIMessage 转成 assistant-ui 可渲染的消息。 */
function toThreadMessage(message: {
  id: string;
  role: "user" | "assistant" | "system" | "data";
  content: string;
  data?: unknown[];
}): ThreadMessageLike {
  const toolEvents = (message.data ?? [])
    .map((d) => d as ToolEventData)
    .filter((d) => d && (d.type === "tool_call" || d.type === "tool_result" || d.type === "thinking"));

  return {
    id: message.id,
    role: message.role === "data" ? "assistant" : (message.role as "user" | "assistant" | "system"),
    content: [
      ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
      // 工具事件作为自定义 part 交给 MessagePrimitive.Parts 分发
      ...toolEvents.map((event) => ({
        type: "tool-call" as const,
        toolName: event.name ?? "tool",
        toolCallId: event.callId ?? `${message.id}-${event.type}`,
        argsText: event.argsJson ?? "{}",
        args: safeParse(event.argsJson),
        result: event.type === "tool_result" ? event.content : undefined,
        isError: event.isError,
        durationMs: event.durationMs,
      })),
    ],
  } as ThreadMessageLike;
}

function safeParse(json: string | undefined): Record<string, unknown> {
  if (!json) return {};
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 提供 assistant-ui 运行时，并暴露会话 id 供页面展示。 */
export function useLishRuntime(onSessionId?: (id: string) => void) {
  const chat = useChat({
    api: "/api/chat",
    onResponse() {
      // 会话 id 由服务端在首个 data 帧下发，这里从消息里读
    },
  });

  // 从最新消息的 data 中提取 sessionId
  const sessionId = useMemo(() => {
    for (const m of [...chat.messages].reverse()) {
      const found = (m.data as ToolEventData[] | undefined)?.find((d) => d?.sessionId);
      if (found?.sessionId) return found.sessionId;
    }
    return undefined;
  }, [chat.messages]);

  if (sessionId && onSessionId) onSessionId(sessionId);

  const messages = useMemo(
    () => chat.messages.map((m) => toThreadMessage(m as Parameters<typeof toThreadMessage>[0])),
    [chat.messages],
  );

  const runtime = useExternalStoreRuntime({
    messages,
    // 外部存储需要显式转换器：消息已经是 ThreadMessageLike 形态，原样返回。
    convertMessage: (message: ThreadMessageLike) => message,
    isRunning: chat.status === "streaming" || chat.status === "submitted",
    onNew: async (message) => {
      const text =
        typeof message.content === "string"
          ? message.content
          : message.content
              .map((part) => (part.type === "text" ? part.text : ""))
              .join("");
      await chat.append({ role: "user", content: text });
    },
  });

  return { runtime, chat, sessionId };
}

export { AssistantRuntimeProvider };
