"use client";

/**
 * lish 主界面。
 *
 * 布局参考 DSH 复刻版（三栏），防重叠方案参考 Vercel AI Chatbot：
 *   - 外层 flex 列 + min-h-0
 *   - 消息区：relative flex-1 + 内部 absolute inset-0 overflow-y-auto
 *     （滚动区脱离文档流，永远不会把输入条顶下去）
 *   - 输入条：shrink-0 紧贴底部
 *
 * 纯客户端渲染（静态导出），所有数据来自后端 /api/*。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileText,
  FolderOpen,
  MessageSquarePlus,
  PanelRight,
  Settings,
  Square,
  Trash2,
  Wrench,
  X,
} from "lucide-react";

import {
  fetchConfig,
  streamChat,
  updateConfig,
  type ServerConfig,
  type ToolStreamEvent,
} from "../lib/api";

// --- 类型 -----------------------------------------------------------------

type Role = "user" | "assistant";

interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  output?: string;
  isError?: boolean;
  running: boolean;
}

interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  toolCalls: ToolCall[];
  streaming?: boolean;
  error?: string;
}

interface Session {
  id: string;
  title: string;
  messages: ChatMessage[];
}

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now()}-${++seq}`;

// --- 小组件 ---------------------------------------------------------------

/** 可折叠的工具调用卡片。 */
function ToolCard({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="w-full max-w-[520px] overflow-hidden rounded-lg border border-line bg-layer1/60">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] transition-colors hover:bg-white/[0.03]"
      >
        <Wrench size={13} className="shrink-0 text-ink-caption" />
        <span className="font-mono text-ink-2">{call.name}</span>
        {call.running ? (
          <span className="flex items-center gap-1 text-[11px] text-amber-400/90">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
            执行中
          </span>
        ) : call.isError ? (
          <span className="text-[11px] text-red-400">失败</span>
        ) : (
          <span className="flex items-center gap-1 text-[11px] text-emerald-400/90">
            <Check size={11} />
            完成
          </span>
        )}
        <span className="ml-auto text-ink-caption">
          {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
      </button>

      {open ? (
        <div className="space-y-2 border-t border-line px-3 py-2">
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-ink-caption">参数</div>
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-black/30 p-2 font-mono text-[11px] text-ink-3">
              {JSON.stringify(call.args, null, 2)}
            </pre>
          </div>
          {!call.running ? (
            <div>
              <div className="mb-1 text-[10px] uppercase tracking-wide text-ink-caption">结果</div>
              <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-black/30 p-2 font-mono text-[11px] text-ink-3">
                {call.output || "（空）"}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** 消息气泡：用户有气泡，AI 是纯文本流（同 Vercel 模板）。 */
function MessageView({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";

  return (
    <div className={`lish-fade-up w-full ${isUser ? "flex justify-end" : "flex justify-start"}`}>
      <div className={isUser ? "max-w-[min(80%,56ch)] min-w-0" : "min-w-0 w-full max-w-[820px]"}>
        {isUser ? (
          <div className="w-fit max-w-full whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-line-strong bg-layer2 px-3.5 py-2 text-[13px] leading-[1.65] text-ink">
            {message.content}
          </div>
        ) : (
          <div className="space-y-2">
            {message.toolCalls.map((call) => (
              <ToolCard key={call.id} call={call} />
            ))}
            {message.content ? (
              <div
                className={`whitespace-pre-wrap break-words text-[13px] leading-[1.65] text-ink-2 ${
                  message.streaming ? "lish-cursor" : ""
                }`}
              >
                {message.content}
              </div>
            ) : message.streaming && message.toolCalls.length === 0 ? (
              <div className="flex items-center gap-2 text-[13px] text-ink-caption">
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand-soft" />
                思考中…
              </div>
            ) : null}
            {message.error ? (
              <div className="rounded-lg border border-red-900/60 bg-red-950/30 px-3 py-2 text-[12px] text-red-300">
                {message.error}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

/** 设置弹窗。 */
function SettingsModal({
  open,
  onClose,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: (cfg: ServerConfig | null) => void;
}) {
  const [apiKey, setApiKey] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [model, setModel] = useState("");
  const [maxSteps, setMaxSteps] = useState(8);
  const [server, setServer] = useState<ServerConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void fetchConfig().then((cfg) => {
      if (!alive || !cfg) return;
      setServer(cfg);
      setBaseURL(cfg.baseURL);
      setModel(cfg.model);
      setMaxSteps(cfg.maxSteps);
      setApiKey(""); // 密钥不回显
      setMessage(null);
    });
    return () => {
      alive = false;
    };
  }, [open]);

  if (!open) return null;

  const save = async () => {
    setSaving(true);
    setMessage(null);
    const result = await updateConfig({
      model,
      baseURL,
      maxSteps,
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    });
    setSaving(false);
    if (result.ok) {
      setApiKey("");
      setMessage({ ok: true, text: "已保存并生效" });
      const fresh = await fetchConfig();
      setServer(fresh);
      onSaved(fresh);
    } else {
      setMessage({ ok: false, text: result.error ?? "保存失败" });
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-2xl border border-line-strong bg-layer1 shadow-[0_20px_60px_rgba(0,0,0,0.5)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="text-sm font-medium text-ink">设置</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-ink-caption transition-colors hover:bg-white/5 hover:text-ink"
            aria-label="关闭"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <div>
            <label className="mb-1.5 block text-[12px] text-ink-3">模型</label>
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="deepseek-chat"
              spellCheck={false}
              className="w-full rounded-lg border border-line-strong bg-base px-3 py-2 text-[13px] text-ink outline-none transition-colors focus:border-brand"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-[12px] text-ink-3">Base URL</label>
            <input
              value={baseURL}
              onChange={(e) => setBaseURL(e.target.value)}
              placeholder="https://api.deepseek.com"
              spellCheck={false}
              className="w-full rounded-lg border border-line-strong bg-base px-3 py-2 text-[13px] text-ink outline-none transition-colors focus:border-brand"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-[12px] text-ink-3">API Key</label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                server?.hasApiKey
                  ? `已配置 ${server.apiKeyMasked}（留空不修改）`
                  : "未配置，请输入 sk-..."
              }
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-lg border border-line-strong bg-base px-3 py-2 text-[13px] text-ink outline-none transition-colors focus:border-brand"
            />
          </div>

          <div>
            <label className="mb-1.5 block text-[12px] text-ink-3">最大步数</label>
            <input
              type="number"
              min={1}
              max={50}
              value={maxSteps}
              onChange={(e) => setMaxSteps(Number(e.target.value))}
              className="w-full rounded-lg border border-line-strong bg-base px-3 py-2 text-[13px] text-ink outline-none transition-colors focus:border-brand"
            />
          </div>

          {message ? (
            <p className={`text-[12px] ${message.ok ? "text-emerald-400" : "text-red-400"}`}>
              {message.text}
            </p>
          ) : null}
        </div>

        <div className="flex items-center justify-between border-t border-line px-5 py-3">
          <span className="text-[11px] text-ink-caption">
            Provider：{server?.providerName ?? "…"}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-3 py-1.5 text-[12px] text-ink-3 transition-colors hover:bg-white/5"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="rounded-lg bg-brand px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
            >
              {saving ? "保存中…" : "保存"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// --- 主页面 ---------------------------------------------------------------

export default function Home() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [serverCfg, setServerCfg] = useState<ServerConfig | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<(() => void) | null>(null);
  /** 服务端会话 id（按本地会话隔离，用于多轮上下文） */
  const serverSessionRef = useRef<Record<string, string>>({});

  // 启动时拉取配置，展示真实模型名
  useEffect(() => {
    void fetchConfig().then(setServerCfg);
  }, []);

  const active = useMemo(
    () => sessions.find((s) => s.id === activeId) ?? null,
    [sessions, activeId],
  );

  /** 修改当前会话的消息列表。 */
  const patchSession = useCallback(
    (sessionId: string, fn: (s: Session) => Session) => {
      setSessions((prev) => prev.map((s) => (s.id === sessionId ? fn(s) : s)));
    },
    [],
  );

  const patchMessage = useCallback(
    (sessionId: string, messageId: string, fn: (m: ChatMessage) => ChatMessage) => {
      patchSession(sessionId, (s) => ({
        ...s,
        messages: s.messages.map((m) => (m.id === messageId ? fn(m) : m)),
      }));
    },
    [patchSession],
  );

  /** 新建会话。 */
  const newSession = useCallback(() => {
    const s: Session = { id: nextId("s"), title: "新会话", messages: [] };
    setSessions((prev) => [s, ...prev]);
    setActiveId(s.id);
    setInput("");
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, []);

  /** 删除会话。 */
  const removeSession = useCallback(
    (id: string) => {
      setSessions((prev) => {
        const next = prev.filter((s) => s.id !== id);
        if (activeId === id) setActiveId(next[0]?.id ?? null);
        return next;
      });
    },
    [activeId],
  );

  // 自动滚动到底部（流式时跟随）
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom || (active?.messages.at(-1)?.streaming ?? false)) {
      el.scrollTop = el.scrollHeight;
    }
  }, [active?.messages]);

  // 输入框高度自适应
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  /** 发送消息。 */
  const send = useCallback(() => {
    const text = input.trim();
    if (!text || streaming) return;

    // 没有活动会话时自动创建一个
    let targetId = activeId;
    if (!targetId) {
      const s: Session = { id: nextId("s"), title: text.slice(0, 24) || "新会话", messages: [] };
      setSessions((prev) => [s, ...prev]);
      setActiveId(s.id);
      targetId = s.id;
    }
    const sessionId = targetId;

    const userMsg: ChatMessage = {
      id: nextId("m"),
      role: "user",
      content: text,
      toolCalls: [],
    };
    const assistantMsg: ChatMessage = {
      id: nextId("m"),
      role: "assistant",
      content: "",
      toolCalls: [],
      streaming: true,
    };

    patchSession(sessionId, (s) => ({
      ...s,
      title: s.messages.length === 0 ? text.slice(0, 24) : s.title,
      messages: [...s.messages, userMsg, assistantMsg],
    }));

    setInput("");
    setStreaming(true);

    // 文本增量缓冲，合并到一帧渲染，避免每个 token 触发全量重绘
    let pending = "";
    let flush: number | null = null;
    const flushNow = () => {
      flush = null;
      if (!pending) return;
      const chunk = pending;
      pending = "";
      patchMessage(sessionId, assistantMsg.id, (m) => ({ ...m, content: m.content + chunk }));
    };
    const cancelFlush = () => {
      if (flush !== null) {
        clearTimeout(flush);
        flush = null;
      }
      flushNow();
    };

    const handle = streamChat(text, serverSessionRef.current[sessionId] ?? null, {
      onText: (delta) => {
        pending += delta;
        if (flush === null) flush = window.setTimeout(flushNow, 16);
      },

      onEvent: (event: ToolStreamEvent) => {
        if (event.type === "session" && event.sessionId) {
          serverSessionRef.current[sessionId] = event.sessionId;
          return;
        }
        if (event.type === "tool_call") {
          const callId = event.callId ?? event.name ?? nextId("call");
          let args: Record<string, unknown> = {};
          try {
            args = event.argsJson ? (JSON.parse(event.argsJson) as Record<string, unknown>) : {};
          } catch {
            args = { _raw: event.argsJson };
          }
          patchMessage(sessionId, assistantMsg.id, (m) => ({
            ...m,
            toolCalls: [
              ...m.toolCalls,
              { id: callId, name: event.name ?? "tool", args, running: true },
            ],
          }));
          return;
        }
        if (event.type === "tool_result") {
          const callId = event.callId ?? event.name ?? "";
          patchMessage(sessionId, assistantMsg.id, (m) => ({
            ...m,
            toolCalls: m.toolCalls.map((c) =>
              c.id === callId
                ? { ...c, output: event.content ?? "", isError: event.isError, running: false }
                : c,
            ),
          }));
        }
      },

      onDone: (info) => {
        cancelFlush();
        patchMessage(sessionId, assistantMsg.id, (m) => ({
          ...m,
          streaming: false,
          toolCalls: m.toolCalls.map((c) =>
            c.running ? { ...c, running: false, output: c.output ?? "（未返回结果）" } : c,
          ),
          error: info.error ? `请求失败：${info.error}` : undefined,
        }));
        setStreaming(false);
        abortRef.current = null;
      },

      onError: (err) => {
        cancelFlush();
        patchMessage(sessionId, assistantMsg.id, (m) => ({
          ...m,
          streaming: false,
          error: `请求失败：${err.message}`,
        }));
        setStreaming(false);
        abortRef.current = null;
      },
    });

    abortRef.current = handle.abort;
  }, [input, streaming, activeId, patchSession, patchMessage]);

  /** 停止生成。 */
  const stop = useCallback(() => {
    abortRef.current?.();
    abortRef.current = null;
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const messages = active?.messages ?? [];

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-base">
      {/* ── 左侧栏 ── */}
      <aside className="hidden w-[260px] shrink-0 flex-col border-r border-line bg-sidebar md:flex">
        <div className="flex items-center gap-2 px-3 py-3">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand text-[13px] font-bold text-white">
            l
          </div>
          <span className="text-[13px] font-medium text-ink">lish</span>
        </div>

        <div className="px-3 pb-2">
          <button
            type="button"
            onClick={newSession}
            className="flex w-full items-center gap-2 rounded-lg border border-line-strong px-3 py-2 text-[13px] text-ink-2 transition-colors hover:bg-white/5 hover:text-ink"
          >
            <MessageSquarePlus size={14} />
            新会话
          </button>
        </div>

        {/* 会话列表 */}
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
          <div className="px-2 pb-1 text-[11px] text-ink-caption">lish</div>
          {sessions.length === 0 ? (
            <div className="px-2 py-3 text-[12px] text-ink-caption">暂无会话</div>
          ) : (
            sessions.map((s) => (
              <div
                key={s.id}
                onClick={() => setActiveId(s.id)}
                className={`group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] transition-colors ${
                  s.id === activeId
                    ? "bg-white/[0.08] text-ink"
                    : "text-ink-3 hover:bg-white/[0.04] hover:text-ink-2"
                }`}
              >
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeSession(s.id);
                  }}
                  className="hidden shrink-0 rounded p-0.5 text-ink-caption hover:text-red-400 group-hover:block"
                  aria-label="删除会话"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))
          )}
        </div>

        {/* 底部 */}
        <div className="border-t border-line p-2">
          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-[12.5px] text-ink-3 transition-colors hover:bg-white/5 hover:text-ink"
          >
            <Settings size={14} />
            设置
          </button>
        </div>
      </aside>

      {/* ── 中间：聊天区 ── */}
      <main className="flex min-w-0 flex-1 flex-col">
        {/* 顶栏 */}
        <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4">
          <span className="truncate text-[13px] text-ink-2">{active?.title ?? "lish"}</span>
          <span className="ml-auto truncate text-[11px] text-ink-caption">
            {serverCfg?.model ?? "…"}
          </span>
          <button
            type="button"
            onClick={() => setShowFiles((v) => !v)}
            className="rounded p-1 text-ink-caption transition-colors hover:bg-white/5 hover:text-ink lg:hidden"
            aria-label="文件"
          >
            <PanelRight size={15} />
          </button>
        </header>

        {/*
         * 关键布局（防重叠）：
         * 父级 flex-1 + min-h-0 给出确定高度，
         * 滚动层用 absolute inset-0 脱离文档流，
         * 因此无论消息多少都不会把底部输入条挤出视口。
         */}
        <div className="relative flex min-h-0 flex-1 flex-col">
          <div ref={scrollRef} className="absolute inset-0 overflow-y-auto">
            <div className="mx-auto flex min-h-full w-full max-w-[860px] flex-col gap-5 px-4 py-6">
              {messages.length === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand text-[17px] font-bold text-white">
                    l
                  </div>
                  <p className="mt-1 text-[15px] text-ink-2">有什么可以帮你？</p>
                  <p className="max-w-sm text-[12px] text-ink-caption">
                    可以让我读写工作区文件，例如「读取 package.json 并告诉我项目名字」
                  </p>
                </div>
              ) : (
                messages.map((m) => <MessageView key={m.id} message={m} />)
              )}
            </div>
          </div>
        </div>

        {/* 输入条：shrink-0 固定底部 */}
        <div className="shrink-0 px-3 pb-3 sm:px-4 sm:pb-4">
          <div className="mx-auto w-full max-w-[860px]">
            <div className="rounded-2xl border border-line-strong bg-layer1 shadow-[0_6px_28px_-6px_rgba(0,0,0,0.5)] transition-colors focus-within:border-brand">
              <textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={onKeyDown}
                rows={1}
                placeholder="给智能体发消息…（Enter 发送，Shift+Enter 换行）"
                className="max-h-40 w-full resize-none bg-transparent px-4 pb-1 pt-3 text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-caption"
              />
              <div className="flex items-center gap-2 px-3 pb-2.5">
                <button
                  type="button"
                  onClick={newSession}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-caption transition-colors hover:bg-white/5 hover:text-ink"
                  title="新建会话"
                  aria-label="新建会话"
                >
                  <span className="text-[15px] leading-none">+</span>
                </button>

                <span className="ml-auto min-w-0 truncate text-[11px] text-ink-caption">
                  {serverCfg?.model ?? ""}
                </span>

                {streaming ? (
                  <button
                    type="button"
                    onClick={stop}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-layer3 text-ink transition-colors hover:bg-white/15"
                    title="停止生成"
                    aria-label="停止生成"
                  >
                    <Square size={12} fill="currentColor" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={send}
                    disabled={!input.trim()}
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg transition-all ${
                      input.trim()
                        ? "bg-brand text-white hover:opacity-90 active:scale-95"
                        : "cursor-not-allowed bg-layer3 text-ink-caption"
                    }`}
                    title="发送"
                    aria-label="发送"
                  >
                    <ArrowUp size={14} />
                  </button>
                )}
              </div>
            </div>
            <p className="mt-2 text-center text-[10.5px] text-ink-caption">
              工具调用受工作区路径沙箱保护
            </p>
          </div>
        </div>
      </main>

      {/* ── 右侧：文件面板（窄屏隐藏，可由顶栏按钮唤出）── */}
      <aside
        className={`w-[240px] shrink-0 flex-col border-l border-line bg-sidebar lg:flex ${
          showFiles ? "flex" : "hidden"
        }`}
      >
        <div className="flex h-11 shrink-0 items-center border-b border-line px-3 text-[12px] text-ink-2">
          资源管理器
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto py-2 text-[12.5px]">
          <div className="flex items-center gap-1.5 px-2 py-1 text-ink-3">
            <ChevronDown size={13} />
            <FolderOpen size={13} />
            <span className="truncate">lish</span>
          </div>
          <div className="pl-5">
            <div className="flex items-center gap-1.5 px-2 py-1 text-ink-3">
              <ChevronRight size={13} />
              <FolderOpen size={13} />
              <span>src</span>
            </div>
            <div className="flex items-center gap-1.5 px-2 py-1 text-ink-3">
              <FileCode2 size={13} />
              <span>package.json</span>
            </div>
            <div className="flex items-center gap-1.5 px-2 py-1 text-ink-3">
              <FileText size={13} />
              <span>README.md</span>
            </div>
          </div>
        </div>
      </aside>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={setServerCfg}
      />
    </div>
  );
}
