"use client";

/**
 * lish 主界面。
 *
 * 结构：
 *   ┌─────────────┬───────────────────────────┬──────────────┐
 *   │ 左侧栏      │ 状态栏 + 消息列表          │ 右侧多功能面板 │
 *   │ 新会话/会话 │ 输入框（固定底部）         │ 文件/终端/任务 │
 *   └─────────────┴───────────────────────────┴──────────────┘
 *   左右两栏可拖拽调整宽度（Group / Panel / Separator）。
 *
 * 防重叠方案（参考 Vercel AI Chatbot）：
 *   消息区 = relative flex-1 min-h-0 + 内部 absolute inset-0 overflow-y-auto，
 *   滚动层脱离文档流，因此永远不会把底部输入框顶出视口。
 *
 * 纯客户端渲染（静态导出），所有数据来自后端 /api/*。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Lock,
  MessageSquarePlus,
  Settings,
  Square,
  Trash2,
  Users,
  Wrench,
} from "lucide-react";
import { Group, Panel, Separator } from "react-resizable-panels";

import {
  streamChat,
  fetchConfig,
  updateAppSettings,
  fetchTraceEvents,
  fetchSubAgents,
  type TraceEvent,
  type SubAgentRecord,
  type ServerConfig,
  type ToolStreamEvent,
  type AppSettings as ServerAppSettings,
} from "../lib/api";
import { RightPanel } from "../ui/RightPanel";
import { TracePanel } from "../ui/TracePanel";
import {
  SettingsModal,
  defaultSettings,
  type AppSettings,
} from "../ui/SettingsModal";

// --- 类型 -----------------------------------------------------------------

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
  role: "user" | "assistant";
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

/** 消息气泡：用户有气泡，AI 为纯文本流。 */
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

/** 轻量下拉选择器（无需额外依赖）。 */
function Select<T extends string>({
  value,
  options,
  onChange,
  icon,
  title,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  icon?: React.ReactNode;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value) ?? options[0];

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={title}
        className="flex items-center gap-1.5 rounded-lg border border-line-strong px-2 py-1 text-[11.5px] text-ink-3 transition-colors hover:bg-white/[0.04] hover:text-ink-2"
      >
        {icon}
        <span className="whitespace-nowrap">{current?.label ?? ""}</span>
        <ChevronDown size={11} />
      </button>
      {open ? (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-0 z-20 mb-1 min-w-[160px] overflow-hidden rounded-lg border border-line-strong bg-layer1 py-1 shadow-xl">
            {options.map((o) => (
              <button
                key={o.value}
                type="button"
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] text-ink-3 transition-colors hover:bg-white/[0.06] hover:text-ink"
              >
                <span className="w-3 shrink-0">
                  {value === o.value ? <Check size={11} className="text-brand-soft" /> : null}
                </span>
                {o.label}
              </button>
            ))}
          </div>
        </>
      ) : null}
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
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [serverCfg, setServerCfg] = useState<ServerConfig | null>(null);
  /** 中间区 Tab：对话 / 轨迹 */
  const [mainTab, setMainTab] = useState<"chat" | "trace">("chat");
  /** 轨迹事件（与对话状态隔离，避免流式增量污染轨迹列表） */
  const [traceEvents, setTraceEvents] = useState<TraceEvent[]>([]);
  /** 子代理记录（状态栏计数 + 轨迹分组） */
  const [subAgents, setSubAgents] = useState<SubAgentRecord[]>([]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<(() => void) | null>(null);
  const serverSessionRef = useRef<Record<string, string>>({});

  useEffect(() => {
    void fetchConfig().then((cfg) => {
      if (!cfg) return;
      setServerCfg(cfg);
      // 用服务端持久化的设置覆盖本地默认值，保证刷新后状态一致
      const s = (cfg as unknown as { settings?: ServerAppSettings }).settings;
      if (s) setSettings((prev) => ({ ...prev, ...s }));
    });
  }, []);

  // 字号：作用到根元素
  useEffect(() => {
    const px =
      settings.fontSize === "small" ? "13px" : settings.fontSize === "large" ? "16px" : "14px";
    document.documentElement.style.fontSize = px;
  }, [settings.fontSize]);

  // 主题标记（当前视觉以深色为主，保留标记供后续扩展）
  useEffect(() => {
    const resolved =
      settings.theme === "system"
        ? window.matchMedia("(prefers-color-scheme: light)").matches
          ? "light"
          : "dark"
        : settings.theme;
    document.documentElement.dataset.theme = resolved;
  }, [settings.theme]);

  const active = useMemo(
    () => sessions.find((s) => s.id === activeId) ?? null,
    [sessions, activeId],
  );

  /**
   * 更新设置：先更新本地状态（界面即时响应），再异步落到后端。
   * 后端会同时调整工具注册表（插件开关）与 fs 工具权限。
   */
  /** 拉取子代理列表。 */
  const loadSubAgents = useCallback(async () => {
    const r = await fetchSubAgents();
    if (r.ok) setSubAgents(r.agents);
  }, []);

  /** 拉取当前会话的轨迹事件。 */
  const loadTrace = useCallback(async (serverSessionId: string | undefined) => {
    if (!serverSessionId) return;
    const r = await fetchTraceEvents(serverSessionId);
    if (r.ok) setTraceEvents(r.events);
  }, []);

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    setSettings((prev) => ({ ...prev, ...patch }));
    void updateAppSettings(patch);
  }, []);

  const patchSession = useCallback((sessionId: string, fn: (s: Session) => Session) => {
    setSessions((prev) => prev.map((s) => (s.id === sessionId ? fn(s) : s)));
  }, []);

  const patchMessage = useCallback(
    (sessionId: string, messageId: string, fn: (m: ChatMessage) => ChatMessage) => {
      patchSession(sessionId, (s) => ({
        ...s,
        messages: s.messages.map((m) => (m.id === messageId ? fn(m) : m)),
      }));
    },
    [patchSession],
  );

  const newSession = useCallback(() => {
    const s: Session = { id: nextId("s"), title: "新会话", messages: [] };
    setSessions((prev) => [s, ...prev]);
    setActiveId(s.id);
    setInput("");
    setTimeout(() => textareaRef.current?.focus(), 0);
  }, []);

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

  // 切换会话：同步该会话的轨迹
  useEffect(() => {
    const sid = activeId ? serverSessionRef.current[activeId] : undefined;
    if (sid) void loadTrace(sid);
    else setTraceEvents([]);
  }, [activeId, loadTrace]);

  // 自动滚动到底部
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom || (active?.messages.at(-1)?.streaming ?? false)) {
      el.scrollTop = el.scrollHeight;
    }
  }, [active?.messages]);

  // 全局快捷键：Ctrl/Cmd + K 聚焦输入框
  useEffect(() => {
    const onGlobalKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        textareaRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onGlobalKey);
    return () => window.removeEventListener("keydown", onGlobalKey);
  }, []);

  // 输入框高度自适应
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  const send = useCallback(() => {
    const text = input.trim();
    if (!text || streaming) return;

    let targetId = activeId;
    if (!targetId) {
      const s: Session = { id: nextId("s"), title: text.slice(0, 24) || "新会话", messages: [] };
      setSessions((prev) => [s, ...prev]);
      setActiveId(s.id);
      targetId = s.id;
    }
    const sessionId = targetId;

    const userMsg: ChatMessage = { id: nextId("m"), role: "user", content: text, toolCalls: [] };
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
        // 轨迹只在事件边界刷新，避免与流式文本竞争渲染（状态隔离）
        void loadTrace(serverSessionRef.current[sessionId]);
        void loadSubAgents();
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
  }, [input, streaming, activeId, patchSession, patchMessage, loadTrace, loadSubAgents]);

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
  const modelName = serverCfg?.model ?? "deepseek-chat";
  const presetLabel =
    settings.agentPreset === "standard"
      ? "标准模式"
      : settings.agentPreset === "minimal"
        ? "极简模式"
        : "创造模式";

  // 模型下拉选项：当前模型置顶，其余为常见备选
  const modelOptions = [
    { value: modelName, label: modelName },
    { value: "deepseek-reasoner", label: "deepseek-reasoner" },
    { value: "deepseek-chat", label: "deepseek-chat" },
  ].filter((o, i, arr) => arr.findIndex((x) => x.value === o.value) === i);

  return (
    <div className="h-dvh w-full overflow-hidden bg-base">
      <Group orientation="horizontal" className="h-full">
        {/* ── 左侧栏（可拖拽，窄屏隐藏）── */}
        <Panel defaultSize="18%" minSize="12%" maxSize="30%" className="hidden md:block">
          <aside className="flex h-full flex-col border-r border-line bg-sidebar">
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
        </Panel>

        {/* 左侧拖拽线 */}
        <Separator className="hidden w-px bg-line transition-colors hover:bg-brand md:block" />

        {/* ── 中间：对话区 ── */}
        <Panel minSize="40%">
          <main className="flex h-full min-w-0 flex-col">
            {/* 状态栏 */}
            <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line px-4">
              <span className="min-w-0 truncate text-[13px] text-ink-2">
                {active?.title ?? "新会话"}
              </span>
              <span className="flex shrink-0 items-center gap-1 rounded border border-line-strong px-1.5 py-0.5 text-[11px] text-ink-caption">
                <Users size={11} />
                子智能体 {subAgents.length} 个
                {subAgents.filter((a) => a.status === "running").length > 0 ? (
                  <span className="ml-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
                ) : null}
              </span>
              {/* 预设与设置双向绑定：点击切换，设置里改动也会同步到这里 */}
              <Select
                value={settings.agentPreset}
                onChange={(v) => updateSettings({ agentPreset: v })}
                title="Agent 预设"
                options={[
                  { value: "standard", label: "标准模式" },
                  { value: "minimal", label: "极简模式" },
                  { value: "creative", label: "创造模式" },
                ]}
              />
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                className="ml-auto shrink-0 rounded p-1 text-ink-caption transition-colors hover:bg-white/5 hover:text-ink md:hidden"
                aria-label="设置"
              >
                <Settings size={15} />
              </button>
            </div>

            {/* 对话 / 轨迹 双 Tab */}
            <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-line px-3">
              {(["chat", "trace"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setMainTab(t)}
                  className={`rounded px-2.5 py-0.5 text-[12px] transition-colors ${
                    mainTab === t
                      ? "bg-white/[0.08] text-ink"
                      : "text-ink-caption hover:bg-white/[0.04] hover:text-ink-2"
                  }`}
                >
                  {t === "chat" ? "对话" : "轨迹"}
                  {t === "trace" && traceEvents.length > 0 ? (
                    <span className="ml-1 text-[10px] text-ink-caption">{traceEvents.length}</span>
                  ) : null}
                </button>
              ))}
            </div>

            {/* 轨迹面板 */}
            {mainTab === "trace" ? (
              <div className="min-h-0 flex-1 overflow-hidden">
                <TracePanel events={traceEvents} />
              </div>
            ) : null}

            {/* 消息区：绝对定位滚动层，杜绝与输入框重叠 */}
            <div
              className={`relative min-h-0 flex-1 flex-col ${mainTab === "chat" ? "flex" : "hidden"}`}
            >
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

            {/* 输入区 */}
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
                    {/* 左：+ */}
                    <button
                      type="button"
                      onClick={newSession}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-caption transition-colors hover:bg-white/5 hover:text-ink"
                      title="新建会话"
                      aria-label="新建会话"
                    >
                      <span className="text-[15px] leading-none">+</span>
                    </button>

                    {/* 中：权限选择器 */}
                    <Select
                      value={settings.permission}
                      onChange={(v) => updateSettings({ permission: v })}
                      icon={<Lock size={11} />}
                      title="权限模式"
                      options={[
                        { value: "workspace", label: "Workspace Write" },
                        { value: "full", label: "完全权限" },
                      ]}
                    />

                    {/* 右：模型选择器 + 发送 */}
                    <div className="ml-auto flex items-center gap-2">
                      <Select
                        value={modelName}
                        onChange={(v) =>
                          setServerCfg((prev) => (prev ? { ...prev, model: v } : prev))
                        }
                        title="模型"
                        options={modelOptions}
                      />

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
                </div>
                <p className="mt-2 text-center text-[10.5px] text-ink-caption">
                  工具调用受工作区路径沙箱保护
                </p>
              </div>
            </div>
          </main>
        </Panel>

        {/* 右侧拖拽线 */}
        <Separator className="hidden w-px bg-line transition-colors hover:bg-brand lg:block" />

        {/* ── 右侧面板 ── */}
        <Panel defaultSize="22%" minSize="14%" maxSize="32%" className="hidden lg:block">
          <RightPanel />
        </Panel>
      </Group>

      <SettingsModal
        open={settingsOpen}
        settings={settings}
        onChange={updateSettings}
        onClose={() => setSettingsOpen(false)}
        onSaved={setServerCfg}
      />
    </div>
  );
}
