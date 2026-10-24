/**
 * Chat area — main message display with:
 * - Empty state / welcome screen
 * - Message list with auto-scroll
 * - Input area at bottom
 * - Stats line (token usage simulation)
 */

import { useRef, useEffect, useState } from 'react'
import type { Message } from '../store.ts'
import { MessageItem } from './MessageItem.tsx'
import { ChatInput } from './ChatInput.tsx'
import { store, subscribe } from '../store.ts'
import { TracePanel, ContextPanel } from '../app/layout/ConvPanels.tsx'

/** Format elapsed milliseconds into a human-readable duration label. */
function formatRunDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0
    ? `${minutes}:${String(seconds).padStart(2, '0')}`
    : `${seconds}秒`
}

/**
 * TurnStatus — displays "Deep diving..." during a running turn,
 * with a shimmer gradient animation and an optional running-clock
 * that appears after 15 seconds.
 */
function TurnStatus({ streamingStartTime }: {
  streamingStartTime: number | null
}) {
  const mountedAt = useRef(Date.now())
  const anchor = streamingStartTime ?? mountedAt.current
  const [elapsedMs, setElapsedMs] = useState(() => Math.max(0, Date.now() - anchor))

  useEffect(() => {
    const tick = () => setElapsedMs(Math.max(0, Date.now() - anchor))
    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [anchor])

  const showClock = elapsedMs >= 15_000

  return (
    <div className="dsh-turn-status" role="status" aria-live="polite">
      Deep diving...
      {showClock && (
        <span className="dsh-turn-status-clock" aria-hidden>
          {formatRunDuration(elapsedMs)}
        </span>
      )}
    </div>
  )
}

interface ChatAreaProps {
  activeSessionId: string | null
  convTab?: string
}

export function ChatArea({ activeSessionId, convTab = '对话' }: ChatAreaProps) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [isStreaming, setIsStreaming] = useState(false)
  const [streamingStartTime, setStreamingStartTime] = useState<number | null>(null)
  const [autoScroll, setAutoScroll] = useState(store.settings.autoScroll)
  const [composerTouched, setComposerTouched] = useState(store.composerTouched)

  /* Subscribe to store */
  useEffect(() => {
    const unsub = subscribe(() => {
      const session = store.sessions.find(s => s.id === activeSessionId)
      // 必须浅拷贝：store 是原地修改 message.content 的（流式追加），
      // 若直接传原数组，React 因引用未变而跳过重渲染，
      // 表现为打字机效果失效、文本在结束时一次性出现。
      setMessages(session ? session.messages.map(m => ({ ...m })) : [])
      setIsStreaming(store.isStreaming)
      setStreamingStartTime(store.streamingStartTime)
      setAutoScroll(store.settings.autoScroll)
      setComposerTouched(store.composerTouched)
    })
    return unsub
  }, [activeSessionId])

  /* Auto-scroll */
  useEffect(() => {
    if (autoScroll && scrollRef.current && !isStreaming) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages.length, autoScroll, isStreaming])

  /* Show the centered hero composer when:
   * - no session is selected, OR
   * - the session is still empty and the user hasn't begun typing yet.
   * Once the user starts typing (or messages exist), the input sinks to the bottom. */
  if (!activeSessionId || (messages.length === 0 && !composerTouched)) {
    return (
      <div className="dsh-composer-seat">
        <div className="dsh-composer-stack">
          <div className="dsh-hero-headline">
            <h1 className="dsh-hero-title">探索未至之境</h1>
          </div>
          <div className="dsh-hero-body">
            <p className="dsh-hero-subtitle">开始新对话，向 AI 描述你想构建的内容</p>
          </div>
          <div className="dsh-hero-workspace-row">
            <div className="dsh-hero-toolbar">
              <button
                type="button"
                className="dsh-hero-workspace-btn"
                aria-label="选择工作区"
                aria-haspopup="menu"
                aria-expanded="false"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path d="M2.3 3.5a1.2 1.2 0 011.2-1.2h3l1.1 1.4h5.2a1.2 1.2 0 011.2 1.2v1h.2a1.2 1.2 0 011 1.7l-1.1 3.2a1.2 1.2 0 01-1.1.8H3.2a1.2 1.2 0 01-1.2-1.5l.3-4.6z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
                  <path opacity="0.4" d="M2.3 5.6h11.4l-1 3a.6.6 0 01-.6.4H3.9l-.7-3.4z" fill="currentColor"/>
                </svg>
                <span className="dsh-hero-workspace-label">rewrite-agently</span>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
              <button
                type="button"
                className="dsh-hero-agent-btn"
                aria-haspopup="menu"
                aria-expanded="false"
                title="即将开始的这个会话所用的 Agent 预设"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <circle cx="8" cy="3.2" r="1.5" stroke="currentColor" strokeWidth="1.2"/>
                  <circle cx="3.4" cy="11.4" r="1.5" stroke="currentColor" strokeWidth="1.2"/>
                  <circle cx="12.6" cy="11.4" r="1.5" stroke="currentColor" strokeWidth="1.2"/>
                  <path d="M5.1 9.2c.8-.6 1.8-1 2.9-1s2.1.4 2.9 1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                </svg>
                <span className="dsh-hero-agent-label">标准模式 (Windows)</span>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                  <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </button>
            </div>
            <ChatInput sessionId={activeSessionId} />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="dsh-chat-area">
      {convTab === '轨迹' ? (
        <TracePanel />
      ) : convTab === '上下文' ? (
        <ContextPanel />
      ) : (
        <>
          {/* Message list */}
          <div className="dsh-chat-messages" ref={scrollRef}>
            {messages.map((msg: Message) => (
              <MessageItem key={msg.id} message={msg} />
            ))}
            {isStreaming && (
              <div className="dsh-message" style={{ paddingTop: 4 }}>
                <TurnStatus streamingStartTime={streamingStartTime} />
              </div>
            )}
          </div>

          {/* Input */}
          <div className="dsh-chat-input-area">
            <ChatInput sessionId={activeSessionId} placeholder="给智能体发消息" />
          </div>

          {/* Composer dock stats */}
          <div className="dsh-composer-dock">
            <span>1 轮 · 3 步</span><span className="dsh-dock-sep">|</span>
            <span>LLM 4.2s · 工具调用 7m29s</span><span className="dsh-dock-sep">|</span>
            <span>首 token 平均 0.7s · 169 tok/s</span><span className="dsh-dock-sep">|</span>
            <span>缓存命中 67%</span><span className="dsh-dock-sep">|</span>
            <span>输入 49K tok · 输出 337 tok</span>
          </div>
        </>
      )}
    </div>
  )
}
