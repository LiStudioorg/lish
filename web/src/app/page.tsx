"use client";

/**
 * lish 主界面。
 *
 * 结构：
 *   ┌─────────────┬───────────────────────────┬──────────────┐
 *   │ 左侧栏      │ 状态栏 + 消息列表          │ 右侧多功能面板 │
 *   │ 会话/插件/任务│ 输入框（固定底部）        │ 文件/终端/任务 │
 *   └─────────────┴───────────────────────────┴──────────────┘
 *
 * 状态管理：全部经由 `lib/store.ts`（Zustand）。
 *   每个组件用 selector 只订阅自己需要的切片，高频流式打字时
 *   只有消息区重渲染，侧边栏 / 右侧面板 / 设置弹窗完全不受影响。
 *
 * 防重叠：消息区是 `relative flex-1 min-h-0` + 内部 `absolute inset-0 overflow-y-auto`，
 * 滚动层脱离文档流，因此永远不会把底部输入框顶出视口。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  Bot,
  Lock,
  MessageSquarePlus,
  Puzzle,
  Settings,
  Square,
  Trash2,
  Users,
  ChevronRight,
} from "lucide-react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { AnimatePresence, motion } from "framer-motion";

import {
  fetchConfig,
  fetchPlugins,
  fetchSubAgents,
  fetchHistory,
  fetchTraceEvents,
  reloadPlugins,
  updateAppSettings,
  activateProvider,
  saveProvider,
  type HistoryMessage,
  type PluginInfo,
  type AppSettings as ServerAppSettings,
} from "../lib/api";
import {
  sendMessage,
  serverSessionIdOf,
  type SendHandle,
} from "../lib/chat-stream";
import { PRESET_META, type AppSettings } from "../lib/settings";
import {
  useAppStore,
  useMessages,
  type ChatMessage,
  type SideView,
} from "../lib/store";
import { MessageView, Select } from "../ui/ChatParts";
import { RightPanel } from "../ui/RightPanel";
import { SettingsModal } from "../ui/SettingsModal";
import { TracePanel } from "../ui/TracePanel";

// --- 历史消息转换 ---------------------------------------------------------

/**
 * 把后端历史消息转成前端 ChatMessage。
 *
 * 后端只给出 seq，前端需要稳定的 React key，这里用 `seq` 拼出确定性 id，
 * 这样重复加载同一页时不会产生重复的 key。
 */
function toChatMessage(m: HistoryMessage): ChatMessage {
  return {
    id: `h-${m.seq}`,
    role: m.role,
    content: m.content,
    toolCalls: m.toolCalls.map((c) => ({
      id: c.id,
      name: c.name,
      argsJson: c.argsJson,
      content: c.content,
      isError: c.isError,
      status: c.content === undefined ? "done" : c.isError ? "error" : "done",
    })),
  };
}

// --- 侧边栏 ---------------------------------------------------------------

const SIDE_ITEMS: Array<{ id: SideView; label: string; icon: typeof Bot }> = [
  { id: "sessions", label: "会话", icon: MessageSquarePlus },
  { id: "plugins", label: "插件", icon: Puzzle },
  { id: "tasks", label: "自动化任务", icon: Bot },
];

/** 侧边栏：会话 / 插件 / 自动化任务 三个视图。 */
function Sidebar() {
  const sessions = useAppStore((s) => s.sessions);
  const activeId = useAppStore((s) => s.activeId);
  const sideView = useAppStore((s) => s.sideView);
  const setSideView = useAppStore((s) => s.setSideView);
  const newSession = useAppStore((s) => s.newSession);
  const selectSession = useAppStore((s) => s.selectSession);
  const removeSession = useAppStore((s) => s.removeSession);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);

  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [pluginsLoading, setPluginsLoading] = useState(false);

  useEffect(() => {
    if (sideView !== "plugins") return;
    let alive = true;
    void fetchPlugins().then((r) => {
      if (!alive) return;
      setPlugins(r.plugins);
      setPluginsLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [sideView]);

  const refreshPlugins = useCallback(() => {
    setPluginsLoading(true);
    void reloadPlugins().then((r) => {
      setPlugins(r.plugins);
      setPluginsLoading(false);
    });
  }, []);

  return (
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
          onClick={() => newSession()}
          className="flex w-full items-center gap-2 rounded-lg border border-line-strong px-3 py-2 text-[13px] text-ink-2 transition-colors hover:bg-white/5 hover:text-ink"
        >
          <MessageSquarePlus size={14} />
          新会话
        </button>
      </div>

      <nav className="space-y-0.5 px-2 pb-1">
        {SIDE_ITEMS.map((item) => {
          const Icon = item.icon;
          const on = sideView === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setSideView(item.id)}
              aria-current={on ? "page" : undefined}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] transition-colors ${
                on
                  ? "bg-white/[0.08] text-ink"
                  : "text-ink-3 hover:bg-white/[0.04] hover:text-ink-2"
              }`}
            >
              <Icon size={13} />
              {item.label}
            </button>
          );
        })}
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={sideView}
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 6 }}
            transition={{ duration: 0.14, ease: "easeOut" }}
          >
            {sideView === "sessions" ? (
              <>
                <div className="px-2 pb-1 text-[11px] text-ink-caption">
                  最近会话
                </div>
                {sessions.length === 0 ? (
                  <div className="px-2 py-3 text-[12px] text-ink-caption">
                    暂无会话
                  </div>
                ) : (
                  sessions.map((s) => (
                    <div
                      key={s.id}
                      onClick={() => selectSession(s.id)}
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
              </>
            ) : null}

            {sideView === "plugins" ? (
              <>
                <div className="flex items-center justify-between px-2 pb-1">
                  <span className="text-[11px] text-ink-caption">
                    已加载 {plugins.length} 个
                  </span>
                  <button
                    type="button"
                    onClick={refreshPlugins}
                    className="rounded p-0.5 text-ink-caption transition-colors hover:text-brand"
                    aria-label="重新加载插件"
                  >
                    <ChevronRight
                      size={12}
                      className={pluginsLoading ? "animate-pulse" : ""}
                    />
                  </button>
                </div>
                {plugins.length === 0 ? (
                  <div className="px-2 py-3 text-[12px] leading-relaxed text-ink-caption">
                    {pluginsLoading ? "加载中…" : "暂无插件"}
                    <br />
                    把 `.ts` 插件放进 `~/.lish/plugins/` 即会自动加载。
                  </div>
                ) : (
                  plugins.map((p) => (
                    <div
                      key={p.id}
                      className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] text-ink-3"
                      title={p.error ?? p.module}
                    >
                      <span
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                          p.status === "loaded"
                            ? "bg-emerald-500"
                            : p.status === "error"
                              ? "bg-red-500"
                              : "bg-ink-caption"
                        }`}
                      />
                      <span className="min-w-0 flex-1 truncate text-ink-2">
                        {p.name}
                      </span>
                      {p.version ? (
                        <span className="shrink-0 text-[10px] text-ink-caption">
                          v{p.version}
                        </span>
                      ) : null}
                    </div>
                  ))
                )}
              </>
            ) : null}

            {sideView === "tasks" ? (
              <div className="px-2 py-3 text-[12px] leading-relaxed text-ink-caption">
                当前版本尚未内置定时/触发式任务调度。
                <br />
                需要按计划自动执行时，请用系统 cron 调用
                <code className="mx-1 rounded bg-white/5 px-1 text-ink-3">
                  lish web
                </code>
                提供的 HTTP 接口。
              </div>
            ) : null}
          </motion.div>
        </AnimatePresence>
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
  );
}

// --- 状态栏 ---------------------------------------------------------------

/** Agent 预设选择器：切换即落库，真正影响后端注入的 System Prompt。 */
function AgentPresetSelect({ value }: { value: AppSettings["agentPreset"] }) {
  const setSettings = useAppStore((s) => s.setSettings);
  const setServerCfg = useAppStore((s) => s.setServerCfg);

  return (
    <Select
      value={value}
      onChange={(v) => {
        setSettings({ agentPreset: v });
        void updateAppSettings({ agentPreset: v }).then(async () => {
          const cfg = await fetchConfig();
          if (cfg) setServerCfg(cfg);
        });
      }}
      title="Agent 预设"
      options={PRESET_META.map((p) => ({ value: p.id, label: p.name }))}
    />
  );
}

/** 状态栏：标题、子智能体计数、Agent 预设。 */
function StatusBar() {
  const title = useAppStore(
    (s) => s.sessions.find((x) => x.id === s.activeId)?.title ?? "新会话",
  );
  const subAgents = useAppStore((s) => s.subAgents);
  const preset = useAppStore((s) => s.settings.agentPreset);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);

  const running = subAgents.filter((a) => a.status === "running").length;

  return (
    <div className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-2 sm:gap-3 sm:px-4">
      <span className="min-w-0 truncate text-[13px] text-ink-2">{title}</span>
      <span className="hidden shrink-0 items-center gap-1 rounded border border-line-strong px-1.5 py-0.5 text-[11px] text-ink-caption sm:flex">
        <Users size={11} />
        子智能体 {subAgents.length} 个
        {running > 0 ? (
          <span className="ml-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400" />
        ) : null}
      </span>
      <AgentPresetSelect value={preset} />
      <button
        type="button"
        onClick={() => setSettingsOpen(true)}
        className="ml-auto shrink-0 rounded p-1 text-ink-caption transition-colors hover:bg-white/5 hover:text-ink md:hidden"
        aria-label="设置"
      >
        <Settings size={15} />
      </button>
    </div>
  );
}

// --- 消息区 ---------------------------------------------------------------

/** 消息列表 + 空态欢迎语 + 历史分页。 */
function MessageList() {
  const messages = useMessages();
  const activeId = useAppStore((s) => s.activeId);
  const hasMore = useAppStore(
    (s) => s.sessions.find((x) => x.id === s.activeId)?.hasMore ?? false,
  );
  const loadingMore = useAppStore(
    (s) => s.sessions.find((x) => x.id === s.activeId)?.loadingMore ?? false,
  );
  const nextBefore = useAppStore(
    (s) => s.sessions.find((x) => x.id === s.activeId)?.nextBefore,
  );
  const total = useAppStore(
    (s) => s.sessions.find((x) => x.id === s.activeId)?.total ?? 0,
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);

  /**
   * 加载更早的历史。
   *
   * 关键：必须在插入新消息**之前**记录 scrollHeight，
   * 插入后按差值补偿 scrollTop，否则页面会「唰」地跳回顶部。
   */
  const loadEarlier = useCallback(async () => {
    const state = useAppStore.getState();
    const sid = state.activeId;
    if (!sid || state.sessions.find((s) => s.id === sid)?.loadingMore) return;
    const before = state.sessions.find((s) => s.id === sid)?.nextBefore;
    if (before === undefined) return;

    const el = scrollRef.current;
    const prevHeight = el?.scrollHeight ?? 0;

    state.setLoadingMore(sid, true);
    const page = await fetchHistory(sid, { limit: 20, before });
    if (!page.ok) {
      state.setLoadingMore(sid, false);
      return;
    }

    state.prependMessages(sid, {
      messages: page.messages.map(toChatMessage),
      hasMore: page.hasMore,
      nextBefore: page.nextBefore,
      total: page.total,
    });

    // 等 React 完成这次插入再补偿滚动位置
    requestAnimationFrame(() => {
      const node = scrollRef.current;
      if (!node) return;
      node.scrollTop += node.scrollHeight - prevHeight;
    });
  }, []);

  // 自动滚底：仅当用户本来贴近底部，或正在流式输出
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom || messages.at(-1)?.streaming) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  // 顶部哨兵：滚到顶自动加载更早（比必须点按钮更顺手）
  useEffect(() => {
    const sentinel = topRef.current;
    if (!sentinel || !hasMore || !activeId) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadEarlier();
      },
      { root: scrollRef.current, rootMargin: "80px 0px 0px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, activeId, loadEarlier, nextBefore]);

  return (
    <div ref={scrollRef} className="absolute inset-0 overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-[860px] flex-col gap-5 px-4 py-6">
        {messages.length > 0 && (hasMore || loadingMore) ? (
          <div ref={topRef} className="flex justify-center">
            <button
              type="button"
              onClick={() => void loadEarlier()}
              disabled={loadingMore}
              className="rounded-full border border-line-strong px-3 py-1 text-[11.5px] text-ink-3 transition-colors hover:border-brand hover:text-brand disabled:opacity-50"
            >
              {loadingMore
                ? "加载中…"
                : `加载更早${total > messages.length ? `（共 ${total} 条）` : ""}`}
            </button>
          </div>
        ) : null}
        {messages.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-brand text-[17px] font-bold text-white">
              l
            </div>
            <p className="mt-1 text-[15px] text-ink-2">
              你好，我是 lish —— 你的本地智能体内核。
            </p>
            <p className="max-w-md text-[12px] leading-relaxed text-ink-caption">
              我直接在你的工作区里读写文件、执行命令，所有步骤都会记录成可回放的轨迹。
              <br />
              试试：「读一下 package.json，告诉我这个项目是做什么的」
            </p>
          </div>
        ) : (
          messages.map((m) => <MessageView key={m.id} message={m} />)
        )}
      </div>
    </div>
  );
}

// --- 输入区 ---------------------------------------------------------------

/** 输入区：文本域 + 权限/模型选择 + 发送/停止。 */
function Composer() {
  const input = useAppStore((s) => s.input);
  const setInput = useAppStore((s) => s.setInput);
  const streaming = useAppStore((s) => s.streaming);
  const permission = useAppStore((s) => s.settings.permission);
  const setSettings = useAppStore((s) => s.setSettings);
  const serverCfg = useAppStore((s) => s.serverCfg);
  const setServerCfg = useAppStore((s) => s.setServerCfg);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<SendHandle | null>(null);

  // 输入框高度自适应
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  // 全局快捷键：Ctrl/Cmd + K 聚焦输入框
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        textareaRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /** 结束后刷新轨迹与子代理（只在事件边界拉取，避免与流式竞争）。 */
  const refreshTraceAndAgents = useCallback(async () => {
    const { activeId, setTraceEvents, setSubAgents } = useAppStore.getState();
    const sid = serverSessionIdOf(activeId);
    if (sid) {
      const r = await fetchTraceEvents(sid);
      if (r.ok) setTraceEvents(r.events);
    }
    const agents = await fetchSubAgents();
    if (agents.ok) setSubAgents(agents.agents);
  }, []);

  const submit = useCallback(() => {
    const text = useAppStore.getState().input;
    if (!text.trim() || useAppStore.getState().streaming) return;
    abortRef.current = sendMessage(text, () => {
      abortRef.current = null;
      void refreshTraceAndAgents();
    });
  }, [refreshTraceAndAgents]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  /**
   * 切换模型。
   *
   * 若目标模型在另一个渠道下，先激活那个渠道再设置模型；
   * 同渠道内则直接改当前模型。两步都有失败兜底，绝不静默吞错。
   */
  const switchModel = useCallback(async (model: string) => {
    const cfg = useAppStore.getState().serverCfg;
    if (!cfg) return;
    const target = cfg.allModels?.find((m) => m.model === model);
    if (!target) return;

    if (target.providerId !== cfg.activeProviderId) {
      const act = await activateProvider(target.providerId);
      if (!act.ok) return;
    }
    const saved = await saveProvider({ id: target.providerId, model });
    const fresh = await fetchConfig();
    if (fresh) setServerCfg(fresh);
    if (!saved.ok) return;
  }, [setServerCfg]);

  /**
   * 模型选择器数据：列出**所有渠道**保存的模型，而不是写死几个。
   *
   * 选中某个模型时，若它属于非激活渠道，会先把那个渠道切为激活，
   * 再设置模型——否则模型与渠道会对不上，调用必然失败。
   */
  const modelName = serverCfg?.model ?? "deepseek-chat";
  const modelOptions = (() => {
    const all = serverCfg?.allModels ?? [];
    if (all.length === 0) return [{ value: modelName, label: modelName }];
    return all.map((m) => ({
      value: m.model,
      // 同名模型跨渠道时附上渠道名，避免歧义
      label:
        all.filter((x) => x.model === m.model).length > 1
          ? `${m.model} · ${m.providerName}`
          : m.model,
    }));
  })();

  const noKey = serverCfg !== null && !serverCfg.hasApiKey;

  return (
    <div className="shrink-0 px-3 pb-3 sm:px-4 sm:pb-4">
      <div className="mx-auto w-full max-w-[860px]">
        <AnimatePresence>
          {noKey ? (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.16 }}
              role="alert"
              className="mb-2 flex items-start gap-2 overflow-hidden rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-[12px] leading-relaxed text-red-400"
            >
              <span aria-hidden className="mt-[1px]">
                ⚠️
              </span>
              <span className="min-w-0 flex-1">
                未检测到 API Key，对话将无法工作。请点击左下角【设置】填写您的 API Key
                和模型。
              </span>
            </motion.div>
          ) : null}
        </AnimatePresence>

        <div className="rounded-2xl border border-line-strong bg-layer1 shadow-[0_6px_28px_-6px_rgba(0,0,0,0.5)] transition-colors focus-within:border-brand">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder="给智能体发消息…（Enter 发送，Shift+Enter 换行）"
            className="max-h-40 w-full resize-none bg-transparent px-4 pb-1 pt-3 text-[13px] leading-relaxed text-ink outline-none placeholder:text-ink-caption"
          />
          <div className="flex flex-wrap items-center gap-1.5 px-2 pb-2.5 sm:gap-2 sm:px-3">
            <button
              type="button"
              onClick={() => useAppStore.getState().newSession()}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-ink-caption transition-colors hover:bg-white/5 hover:text-ink"
              title="新建会话"
              aria-label="新建会话"
            >
              <span className="text-[15px] leading-none">+</span>
            </button>

            <Select
              value={permission}
              onChange={(v) => {
                setSettings({ permission: v });
                void updateAppSettings({ permission: v });
              }}
              icon={<Lock size={11} />}
              title="权限模式"
              options={[
                { value: "workspace", label: "Workspace Write" },
                { value: "full", label: "完全权限" },
              ]}
            />

            <div className="ml-auto flex min-w-0 items-center gap-1.5 sm:gap-2">
              <Select
                value={modelName}
                onChange={(v) => void switchModel(v)}
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
                  onClick={submit}
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
  );
}

// --- Tab ------------------------------------------------------------------

/** 中间区 Tab：对话 / 轨迹。 */
function MainTabs() {
  const mainTab = useAppStore((s) => s.mainTab);
  const setMainTab = useAppStore((s) => s.setMainTab);
  const traceCount = useAppStore((s) => s.traceEvents.length);

  return (
    <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-line px-3">
      {(["chat", "trace"] as const).map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => setMainTab(t)}
          aria-selected={mainTab === t}
          role="tab"
          className={`rounded px-2.5 py-0.5 text-[12px] transition-colors ${
            mainTab === t
              ? "bg-white/[0.08] text-ink"
              : "text-ink-caption hover:bg-white/[0.04] hover:text-ink-2"
          }`}
        >
          {t === "chat" ? "对话" : "轨迹"}
          {t === "trace" && traceCount > 0 ? (
            <span className="ml-1 text-[10px] text-ink-caption">{traceCount}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

// --- 页面 -----------------------------------------------------------------

export default function Page() {
  const mainTab = useAppStore((s) => s.mainTab);
  const settingsOpen = useAppStore((s) => s.settingsOpen);
  const settings = useAppStore((s) => s.settings);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const setSettings = useAppStore((s) => s.setSettings);
  const setServerCfg = useAppStore((s) => s.setServerCfg);
  const setSubAgents = useAppStore((s) => s.setSubAgents);

  // 首屏：拉取配置并同步设置
  useEffect(() => {
    void fetchConfig().then((cfg) => {
      if (!cfg) return;
      setServerCfg(cfg);
      const s = (cfg as unknown as { settings?: ServerAppSettings }).settings;
      if (s) setSettings(s);
    });
  }, [setServerCfg, setSettings]);

  // 字号
  useEffect(() => {
    const px =
      settings.fontSize === "small"
        ? "13px"
        : settings.fontSize === "large"
          ? "16px"
          : "14px";
    document.documentElement.style.fontSize = px;
  }, [settings.fontSize]);

  // 主题：切换 `<html>` 上的 dark 类，跟随系统时监听变化
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const dark =
        settings.theme === "system" ? media.matches : settings.theme === "dark";
      document.documentElement.classList.toggle("dark", dark);
      document.documentElement.style.colorScheme = dark ? "dark" : "light";
    };
    apply();
    if (settings.theme !== "system") return;
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [settings.theme]);

  /**
   * 切换会话时同步轨迹，并按需分页拉取历史消息。
   *
   * 只在「本地还没有消息」时拉取，避免用户在本会话里已经聊了几句后
   * 又被服务端历史覆盖。
   */
  useEffect(() => {
    return useAppStore.subscribe((state, prev) => {
      if (state.activeId === prev.activeId) return;
      const sid = serverSessionIdOf(state.activeId);
      if (!sid) {
        state.setTraceEvents([]);
        return;
      }

      void fetchTraceEvents(sid).then((r) => {
        if (r.ok) useAppStore.getState().setTraceEvents(r.events);
      });

      const local = useAppStore
        .getState()
        .sessions.find((s) => s.id === state.activeId);
      if (!local || local.messages.length > 0) return;

      void fetchHistory(sid, { limit: 20 }).then((page) => {
        if (!page.ok) return;
        useAppStore.getState().replaceMessages(state.activeId!, {
          messages: page.messages.map(toChatMessage),
          hasMore: page.hasMore,
          nextBefore: page.nextBefore,
          total: page.total,
        });
      });
    });
  }, []);

  // 挂载时拉一次子代理
  useEffect(() => {
    void fetchSubAgents().then((r) => {
      if (r.ok) setSubAgents(r.agents);
    });
  }, [setSubAgents]);

  // 轨迹面板可见时轻量轮询（10s），不在后台空转
  useEffect(() => {
    if (mainTab !== "trace") return;
    const id = window.setInterval(() => {
      const state = useAppStore.getState();
      const sid = serverSessionIdOf(state.activeId);
      if (sid) {
        void fetchTraceEvents(sid).then((r) => {
          if (r.ok) useAppStore.getState().setTraceEvents(r.events);
        });
      }
      void fetchSubAgents().then((r) => {
        if (r.ok) useAppStore.getState().setSubAgents(r.agents);
      });
    }, 10_000);
    return () => window.clearInterval(id);
  }, [mainTab]);

  return (
    <div className="h-dvh w-full overflow-hidden bg-base">
      <Group orientation="horizontal" className="h-full">
        <Panel
          defaultSize="18%"
          minSize="12%"
          maxSize="30%"
          className="hidden md:block"
        >
          <Sidebar />
        </Panel>

        <Separator className="hidden w-px bg-line transition-colors hover:bg-brand md:block" />

        <Panel minSize="40%">
          <main className="flex h-full min-w-0 flex-col">
            <StatusBar />
            <MainTabs />

            {mainTab === "trace" ? (
              <div className="relative min-h-0 flex-1">
                <TracePanel />
              </div>
            ) : (
              <>
                <div className="relative min-h-0 flex-1">
                  <MessageList />
                </div>
                <Composer />
              </>
            )}
          </main>
        </Panel>

        <Separator className="hidden w-px bg-line transition-colors hover:bg-brand lg:block" />

        <Panel
          defaultSize="22%"
          minSize="14%"
          maxSize="32%"
          className="hidden lg:block"
        >
          <RightPanel />
        </Panel>
      </Group>

      <SettingsModal
        open={settingsOpen}
        settings={settings}
        onChange={(patch) => {
          setSettings(patch);
          void updateAppSettings(patch);
        }}
        onClose={() => setSettingsOpen(false)}
        onSaved={(cfg) => {
          if (cfg) setServerCfg(cfg);
        }}
      />
    </div>
  );
}
