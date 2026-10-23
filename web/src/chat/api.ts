/**
 * 与 lish 后端通信的 API 客户端。
 *
 * 后端 POST /api/chat 返回 AI SDK 数据流协议（非标准 SSE 的 event: 语法）：
 *   0:"文本"            正文增量
 *   2:[{...}]           data 帧（工具事件、会话信息）
 *   d:{...}             结束帧（部分版本）
 * 每个帧以换行分隔，连接关闭代表流结束。
 *
 * 本模块把该协议解析为对 store 的增量更新，并返回 Promise 表示本轮结束。
 */

import { store } from '../store.ts'

/** 后端推来的工具事件（与 src/server.ts 的 ToolStreamEvent 对应）。 */
export interface ToolStreamEvent {
  type: 'session' | 'thinking' | 'tool_call' | 'tool_result' | 'aborted' | 'done'
  runId?: string
  sessionId?: string
  step?: number
  callId?: string
  name?: string
  /** 工具参数，以 JSON 字符串传输（避免索引签名限制） */
  argsJson?: string
  content?: string
  isError?: boolean
  durationMs?: number
  messageCount?: number
  stopReason?: string
  error?: string
}

/** 后端地址：优先环境变量，默认本机 3000。 */
export const API_BASE: string =
  (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_API_BASE ??
  'http://localhost:3000'

/** 协议帧类型。 */
type Frame =
  | { kind: 'text'; text: string }
  | { kind: 'data'; payload: unknown }
  | { kind: 'other'; raw: string }

/** 解析一行协议帧。 */
function parseFrame(line: string): Frame | null {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null

  const colon = trimmed.indexOf(':')
  if (colon <= 0) return { kind: 'other', raw: trimmed }

  const prefix = trimmed.slice(0, colon)
  const body = trimmed.slice(colon + 1)

  try {
    if (prefix === '0') {
      // 文本帧：内容是 JSON 字符串字面量
      const value = JSON.parse(body)
      return { kind: 'text', text: typeof value === 'string' ? value : String(value) }
    }
    if (prefix === '2' || prefix === 'a' || prefix === '9' || prefix === 'b') {
      return { kind: 'data', payload: JSON.parse(body) }
    }
    if (prefix === 'd') {
      return { kind: 'data', payload: { type: 'done' } }
    }
  } catch {
    return { kind: 'other', raw: trimmed }
  }
  return { kind: 'other', raw: trimmed }
}

/** 从 data 帧中提取事件（可能是单个对象或数组）。 */
function flattenPayload(payload: unknown): ToolStreamEvent[] {
  if (Array.isArray(payload)) {
    return payload.filter((p): p is ToolStreamEvent => !!p && typeof p === 'object' && 'type' in p)
  }
  if (payload && typeof payload === 'object' && 'type' in (payload as Record<string, unknown>)) {
    return [payload as ToolStreamEvent]
  }
  return []
}

export interface ChatCallbacks {
  /** 收到正文增量。 */
  onText: (delta: string) => void
  /** 收到工具/状态事件。 */
  onEvent: (event: ToolStreamEvent) => void
  /** 本轮结束（正常或异常）。 */
  onDone: (info: { stopReason?: string; error?: string }) => void
  /** 网络或协议错误。 */
  onError: (error: Error) => void
}

/**
 * 发起一次对话请求并流式消费响应。
 *
 * @returns 一个可中止的句柄；调用 abort() 会中断请求。
 */
export function streamChat(
  message: string,
  sessionId: string | null,
  callbacks: ChatCallbacks,
): { abort: () => void; done: Promise<void> } {
  const controller = new AbortController()

  const done = (async () => {
    try {
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // 后端同时兼容 { message } 与 useChat 的 { messages }，这里用最简形式
        body: JSON.stringify({ message, sessionId: sessionId ?? undefined }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`服务端返回 ${res.status}${text ? `：${text.slice(0, 200)}` : ''}`)
      }
      if (!res.body) throw new Error('响应没有可读取的流')

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let stopReason: string | undefined
      let lastError: string | undefined

      const handleLine = (line: string) => {
        const frame = parseFrame(line)
        if (!frame || frame.kind === 'other') return

        if (frame.kind === 'text') {
          if (frame.text.length > 0) callbacks.onText(frame.text)
          return
        }

        for (const event of flattenPayload(frame.payload)) {
          if (event.type === 'done') {
            stopReason = event.stopReason
            if (event.error) lastError = event.error
          }
          if (event.type === 'aborted' && event.error) {
            lastError = event.error
          }
          callbacks.onEvent(event)
        }
      }

      for (;;) {
        const { done: finished, value } = await reader.read()
        if (finished) break
        buffer += decoder.decode(value, { stream: true })

        let newline: number
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline)
          buffer = buffer.slice(newline + 1)
          handleLine(line)
        }
      }
      if (buffer.trim().length > 0) handleLine(buffer)

      callbacks.onDone({ stopReason, error: lastError })
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        callbacks.onDone({ stopReason: 'aborted' })
        return
      }
      callbacks.onError(err instanceof Error ? err : new Error(String(err)))
    }
  })()

  return { abort: () => controller.abort(), done }
}

/** 健康检查，用于顶部状态指示。 */
export async function checkHealth(): Promise<{
  ok: boolean
  model?: string
  tools?: string[]
}> {
  try {
    const res = await fetch(`${API_BASE}/api/health`)
    if (!res.ok) return { ok: false }
    const data = (await res.json()) as { ok?: boolean; model?: string; tools?: string[] }
    return { ok: data.ok === true, model: data.model, tools: data.tools }
  } catch {
    return { ok: false }
  }
}

/** 供 UI 判断后端是否可达。 */
export function isStoreReady(): boolean {
  return typeof store.addMessage === 'function'
}
