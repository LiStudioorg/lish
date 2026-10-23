/**
 * Chat input — DSH-style layered composer card with:
 * - Multi-line textarea with auto-resize
 * - Send on Enter (Shift+Enter for newline)
 * - Stop generation button during streaming
 * - Toolbar: [+] command, access mode, freeze, status, model, send
 * - Placeholder "描述你想要构建的内容"
 */

import { useState, useRef, type FormEvent } from 'react'
import { IconStop } from '../components/Icons.tsx'
import { store } from '../store.ts'
import { streamChat, type ToolStreamEvent } from './api.ts'

interface ChatInputProps {
  sessionId: string | null
  placeholder?: string
}

export function ChatInput({ sessionId, placeholder }: ChatInputProps) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    doSend()
  }

  function doSend() {
    const text = value.trim()
    if (!text) return

    // If there's no active session (hero state), create one so the reply simulates.
    let sid = sessionId
    if (!sid) {
      store.createSession()
      sid = store.activeSessionId ?? ''
    }

    const userMsg = {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'user' as const,
      content: text,
      status: 'sent' as const,
      timestamp: Date.now(),
    }

    store.addMessage(sid, userMsg)
    setValue('')

    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }

    startStreaming(sid, text)
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      doSend()
    }
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setValue(e.target.value)
    // The user has begun typing — sink the composer to the bottom.
    store.setComposerTouched(true)
    // Auto-resize
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 200) + 'px'
  }

  function handleStop() {
    store.setStreaming(false)
  }

  const hasContent = value.trim().length > 0
  const isStreaming = store.isStreaming

  return (
    <div className="dsh-composer-card">
      {/* Layered card: backdrop / mirror / grow / core form */}
      <div className="dsh-composer-card-backdrop" aria-hidden="true" />
      <div className="dsh-composer-card-mirror" aria-hidden="true" />
      <div className="dsh-composer-card-grow" aria-hidden="true" />

      <form className="dsh-composer-form" onSubmit={handleSubmit}>
        <textarea
          ref={textareaRef}
          className="dsh-composer-textarea"
          value={value}
          onChange={handleInput}
          onFocus={() => store.setComposerTouched(true)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? '描述你想要构建的内容'}
          disabled={isStreaming}
          rows={1}
        />
        <div className="dsh-composer-row">
          <div className="dsh-composer-tools">
            <button className="dsh-composer-add" type="button" disabled title="命令" aria-label="命令">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M8.64453 1.5V7.34961H14.5V8.65039H8.64453V14.5H7.34473V8.65039H1.5V7.34961H7.34473V1.5H8.64453Z" fill="currentColor"/>
              </svg>
            </button>
            <div className="dsh-composer-modes">
              <button className="dsh-composer-mode" type="button" title="访问模式，当前：Workspace Write">
                <span className="dsh-composer-mode-icon">
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <path d="M4 9l3 3 5-6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </span>
                <span className="dsh-composer-mode-label">Workspace Write</span>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            </div>
          </div>
          <div className="dsh-composer-trailing">
            <button className="dsh-composer-freeze" type="button" title="冻结会话" aria-label="冻结会话">
              <span className="dsh-composer-freeze-label">冻结会话</span>
            </button>
            <span className="dsh-composer-status" title="周末 · Asia/Shanghai · 周末模式">周末</span>
            <button className="dsh-composer-model" type="button" title="Qwen3.6-35B-A3B · On" aria-label="选择模型，当前 Qwen3.6-35B-A3B，推理等级 On">
              <span className="dsh-composer-model-name">Qwen3.6-35B-A3B</span>
              <span className="dsh-composer-model-effort">On</span>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            {isStreaming ? (
              <button
                className="dsh-composer-primary"
                onClick={handleStop}
                title="停止生成"
                type="button"
              >
                <IconStop size={16} />
              </button>
            ) : (
              <button
                className={`dsh-composer-primary ${!hasContent ? 'dsh-composer-primary-disabled' : ''}`}
                onClick={doSend}
                type="button"
                disabled={!hasContent}
                title="发送"
                aria-label="发送"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path d="M8 13V3M4 7l4-4 4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            )}
          </div>
        </div>
      </form>
    </div>
  )
}

/* 与后端对接的真实流式处理 */
function startStreaming(sessionId: string, userText: string) {
  const assistantMsg = {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: 'assistant' as const,
    content: '',
    status: 'streaming' as const,
    timestamp: Date.now(),
  }

  store.addMessage(sessionId, assistantMsg)
  store.setStreaming(true, assistantMsg.id)

  // 工具事件按 callId 去重：先建卡片，结果回来后再更新同一张卡片
  const toolIndex = new Map<string, number>()

  // 文本增量缓冲：按动画帧合并写入，避免每个 token 都触发一次全量重渲染。
  let pendingText = ''
  let flushHandle: number | null = null

  function flushText() {
    flushHandle = null
    if (pendingText.length === 0) return
    const chunk = pendingText
    pendingText = ''
    const session = store.sessions.find(s => s.id === sessionId)
    const msg = session?.messages.find(m => m.id === assistantMsg.id)
    store.updateMessage(sessionId, assistantMsg.id, {
      content: (msg?.content ?? '') + chunk,
      status: 'streaming' as const,
    })
  }

  function appendText(delta: string) {
    pendingText += delta
    if (flushHandle === null) {
      // requestAnimationFrame 在标签页不可见时会暂停，这里用 setTimeout 兜底。
      flushHandle = window.setTimeout(flushText, 16)
    }
  }

  function handleEvent(event: ToolStreamEvent) {
    if (event.type === 'tool_call') {
      const callId = event.callId ?? event.name ?? `tool-${Date.now()}`
      let args: Record<string, unknown> = {}
      try {
        args = event.argsJson ? (JSON.parse(event.argsJson) as Record<string, unknown>) : {}
      } catch {
        args = { _raw: event.argsJson }
      }
      const session = store.sessions.find(s => s.id === sessionId)
      const msg = session?.messages.find(m => m.id === assistantMsg.id)
      const existing = msg?.toolCalls ?? []
      toolIndex.set(callId, existing.length)
      store.addToolCall(sessionId, assistantMsg.id, {
        id: callId,
        name: event.name ?? 'tool',
        args,
      })
      return
    }

    if (event.type === 'tool_result') {
      const callId = event.callId ?? event.name ?? ''
      const session = store.sessions.find(s => s.id === sessionId)
      const msg = session?.messages.find(m => m.id === assistantMsg.id)
      const calls = msg?.toolCalls ?? []
      const index = toolIndex.get(callId)
      const target = index !== undefined ? calls[index] : calls.find(c => c.id === callId)
      if (target) {
        // store 的 ToolCall 用 output 字段承载结果文本；
        // 失败时加前缀标记，让卡片能区分「成功 / 失败」。
        const output = event.isError
          ? `✗ ${event.content ?? ''}`
          : (event.content ?? '')
        store.updateMessage(sessionId, assistantMsg.id, {
          toolCalls: calls.map(c => (c === target ? { ...c, output } : c)),
        })
      }
      return
    }
  }

  streamChat(userText, sessionId, {
    onText: appendText,
    onEvent: handleEvent,
    onDone: info => {
      if (flushHandle !== null) {
        clearTimeout(flushHandle)
        flushHandle = null
      }
      flushText()
      const session = store.sessions.find(s => s.id === sessionId)
      const msg = session?.messages.find(m => m.id === assistantMsg.id)
      store.updateMessage(sessionId, assistantMsg.id, {
        status: info.error ? ('error' as const) : ('sent' as const),
        content:
          info.error && !(msg?.content ?? '')
            ? `请求失败：${info.error}`
            : msg?.content ?? '',
      })
      store.setStreaming(false)
    },
    onError: err => {
      if (flushHandle !== null) {
        clearTimeout(flushHandle)
        flushHandle = null
      }
      flushText()
      store.updateMessage(sessionId, assistantMsg.id, {
        status: 'error' as const,
        content: `请求失败：${err.message}`,
      })
      store.setStreaming(false)
    },
  })
}
