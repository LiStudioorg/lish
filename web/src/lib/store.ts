"use client";

/**
 * 全局状态（Zustand）。
 *
 * 设计要点：
 *   1. **按切片订阅**：组件用 `useAppStore(s => s.xxx)` 只订阅自己需要的字段，
 *      流式打字时高频变化的 `messages` 不会波及其他组件（侧栏、设置、右侧面板）。
 *   2. **流式增量就地合并**：`appendDelta` 只修改当前会话最后一条助手消息的内容，
 *      并按 16ms 合帧（由 `chat-stream.ts` 负责节流），避免每帧重建整棵树。
 *   3. **单一写入口**：所有状态变更都通过 action，不在组件里散落 setState。
 */

import { create } from "zustand";

import type { ServerConfig, SubAgentRecord, TraceEvent } from "./api";
import { defaultSettings, type AppSettings } from "./settings";

// --- 类型 -----------------------------------------------------------------

export interface ToolCall {
  id: string;
  name: string;
  argsJson?: string;
  content?: string;
  isError?: boolean;
  durationMs?: number;
  status: "running" | "done" | "error";
}

export type MessageRole = "user" | "assistant";

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  toolCalls: ToolCall[];
  /** 是否仍在流式生成 */
  streaming?: boolean;
  error?: string;
}

export interface Session {
  id: string;
  title: string;
  messages: ChatMessage[];
}

/** 侧边栏视图。 */
export type SideView = "sessions" | "plugins" | "tasks";
/** 中间区 Tab。 */
export type MainTab = "chat" | "trace";

export interface AppState {
  sessions: Session[];
  activeId: string | null;
  input: string;
  streaming: boolean;
  serverCfg: ServerConfig | null;
  settings: AppSettings;
  mainTab: MainTab;
  sideView: SideView;
  settingsOpen: boolean;
  traceEvents: TraceEvent[];
  subAgents: SubAgentRecord[];

  newSession: () => string;
  selectSession: (id: string) => void;
  removeSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;

  setInput: (v: string) => void;
  addUserMessage: (content: string) => ChatMessage | undefined;
  startAssistant: () => void;
  appendDelta: (delta: string) => void;
  finishAssistant: (info: { stopReason?: string; error?: string }) => void;
  upsertToolCall: (call: Partial<ToolCall> & { id: string }) => void;
  setStreaming: (v: boolean) => void;

  setServerCfg: (cfg: ServerConfig | null) => void;
  setSettings: (patch: Partial<AppSettings>) => void;

  setMainTab: (t: MainTab) => void;
  setSideView: (v: SideView) => void;
  setSettingsOpen: (v: boolean) => void;

  setTraceEvents: (e: TraceEvent[]) => void;
  setSubAgents: (a: SubAgentRecord[]) => void;
}

// --- 工具函数 -------------------------------------------------------------

let seq = 0;
/** 生成客户端局部 id（仅用于 React key，不参与后端协议）。 */
function localId(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}${seq}`;
}

/** 从首条用户消息推导会话标题。 */
function titleFrom(text: string): string {
  const single = text.replace(/\s+/g, " ").trim();
  if (!single) return "新会话";
  return single.length <= 24 ? single : `${single.slice(0, 24)}…`;
}

/**
 * 只更新当前会话，并原样保留其它会话的引用。
 *
 * 这是避免整树重渲染的关键：未变化的会话对象引用不变，
 * 订阅它们的组件不会因为别的会话打字而重渲染。
 */
function patchActive(
  state: AppState,
  patch: (s: Session) => Session,
): Partial<AppState> {
  if (!state.activeId) return {};
  return {
    sessions: state.sessions.map((s) => (s.id === state.activeId ? patch(s) : s)),
  };
}

// --- Store ----------------------------------------------------------------

export const useAppStore = create<AppState>((set) => ({
  sessions: [],
  activeId: null,
  input: "",
  streaming: false,
  serverCfg: null,
  settings: defaultSettings,
  mainTab: "chat",
  sideView: "sessions",
  settingsOpen: false,
  traceEvents: [],
  subAgents: [],

  newSession: () => {
    const id = localId("s");
    set((state) => ({
      sessions: [{ id, title: "新会话", messages: [] }, ...state.sessions],
      activeId: id,
      mainTab: "chat",
      traceEvents: [],
    }));
    return id;
  },

  selectSession: (id) => set({ activeId: id, mainTab: "chat", traceEvents: [] }),

  removeSession: (id) =>
    set((state) => {
      const sessions = state.sessions.filter((s) => s.id !== id);
      const activeId =
        state.activeId === id ? (sessions[0]?.id ?? null) : state.activeId;
      return { sessions, activeId };
    }),

  renameSession: (id, title) =>
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, title } : s)),
    })),

  setInput: (v) => set({ input: v }),

  addUserMessage: (content) => {
    const message: ChatMessage = {
      id: localId("m"),
      role: "user",
      content,
      toolCalls: [],
    };
    set((state) => {
      if (!state.activeId) {
        const id = localId("s");
        return {
          sessions: [{ id, title: titleFrom(content), messages: [message] }, ...state.sessions],
          activeId: id,
        };
      }
      return patchActive(state, (s) => ({
        ...s,
        title: s.messages.length === 0 ? titleFrom(content) : s.title,
        messages: [...s.messages, message],
      }));
    });
    return message;
  },

  startAssistant: () => {
    const message: ChatMessage = {
      id: localId("m"),
      role: "assistant",
      content: "",
      toolCalls: [],
      streaming: true,
    };
    set((state) =>
      patchActive(state, (s) => ({ ...s, messages: [...s.messages, message] })),
    );
  },

  appendDelta: (delta) =>
    set((state) =>
      patchActive(state, (s) => {
        const last = s.messages[s.messages.length - 1];
        if (!last || last.role !== "assistant") return s;
        const messages = s.messages.slice(0, -1);
        messages.push({ ...last, content: last.content + delta });
        return { ...s, messages };
      }),
    ),

  finishAssistant: ({ stopReason, error }) =>
    set((state) =>
      patchActive(state, (s) => {
        const last = s.messages[s.messages.length - 1];
        if (!last || last.role !== "assistant") return s;
        const messages = s.messages.slice(0, -1);
        messages.push({
          ...last,
          streaming: false,
          error: error ?? last.error,
          content:
            !last.content && !last.toolCalls.length
              ? error
                ? `请求失败：${error}`
                : stopReason === "aborted"
                  ? "（已停止）"
                  : "（模型未返回内容）"
              : last.content,
        });
        return { ...s, messages };
      }),
    ),

  upsertToolCall: (call) =>
    set((state) =>
      patchActive(state, (s) => {
        const last = s.messages[s.messages.length - 1];
        if (!last || last.role !== "assistant") return s;
        const idx = last.toolCalls.findIndex((c) => c.id === call.id);
        const toolCalls = [...last.toolCalls];
        if (idx >= 0) {
          toolCalls[idx] = { ...toolCalls[idx], ...call };
        } else {
          toolCalls.push({ status: "running", ...call } as ToolCall);
        }
        const messages = s.messages.slice(0, -1);
        messages.push({ ...last, toolCalls });
        return { ...s, messages };
      }),
    ),

  setStreaming: (v) => set({ streaming: v }),
  setServerCfg: (cfg) => set({ serverCfg: cfg }),
  setSettings: (patch) =>
    set((state) => ({ settings: { ...state.settings, ...patch } })),

  setMainTab: (t) => set({ mainTab: t }),
  setSideView: (v) => set({ sideView: v }),
  setSettingsOpen: (v) => set({ settingsOpen: v }),

  setTraceEvents: (e) => set({ traceEvents: e }),
  setSubAgents: (a) => set({ subAgents: a }),
}));

// --- 选择器 ---------------------------------------------------------------

export const selectActiveSession = (s: AppState): Session | undefined =>
  s.sessions.find((x) => x.id === s.activeId);

const EMPTY_MESSAGES: ChatMessage[] = [];

/** 只取当前会话的消息数组；引用变化即内容变化。 */
export const selectMessages = (s: AppState): ChatMessage[] =>
  selectActiveSession(s)?.messages ?? EMPTY_MESSAGES;

/** 便捷 hook：当前会话消息。 */
export function useMessages(): ChatMessage[] {
  return useAppStore(selectMessages);
}

/** 当前会话 id。 */
export const useActiveId = (): string | null => useAppStore((s) => s.activeId);

/** 直接读 store（非 React 环境，如事件回调）。 */
export const getStore = () => useAppStore.getState();

/** 测试辅助：把 store 重置到初始态。 */
export function resetStoreForTests(): void {
  useAppStore.setState({
    sessions: [],
    activeId: null,
    input: "",
    streaming: false,
    serverCfg: null,
    settings: defaultSettings,
    mainTab: "chat",
    sideView: "sessions",
    settingsOpen: false,
    traceEvents: [],
    subAgents: [],
  });
}
