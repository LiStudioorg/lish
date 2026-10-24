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

/**
 * 统一的后端调用助手。
 *
 * 本项目所有 `/api/*` 端点都走 **POST + JSON body**（RPC 风格）：
 * 动作由路径表达，参数由请求体承载。网关/代理/前端封装只需处理一种方法，
 * 也避免了 GET 查询串的编码与长度限制。
 */
async function postJson<T>(
  path: string,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; data: T | null; status: number }> {
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
    const data = (await res.json().catch(() => null)) as T | null;
    return { ok: res.ok, data, status: res.status };
  } catch {
    return { ok: false, data: null, status: 0 };
  }
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

/** 提供商（密钥已脱敏）。 */
export interface ProviderInfo {
  id: string;
  name: string;
  baseURL: string;
  model: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
}

export interface ServerConfig {
  baseURL: string;
  model: string;
  maxSteps: number;
  workspaceRoot: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
  providerName: string;
  tools: string[];
  providers?: ProviderInfo[];
  activeProviderId?: string;
}

/** 提供商增删改的返回体（三个写接口结构一致）。 */
export interface ProvidersResult {
  ok: boolean;
  providers: ProviderInfo[];
  activeProviderId?: string;
  error?: string;
}

async function providerRequest(
  path: string,
  init?: RequestInit,
): Promise<ProvidersResult> {
  try {
    const res = await fetch(`${API_BASE}${path}`, init);
    const data = (await res.json().catch(() => ({}))) as Partial<ProvidersResult> & {
      error?: string;
    };
    if (!res.ok) {
      return {
        ok: false,
        providers: data.providers ?? [],
        activeProviderId: data.activeProviderId,
        error: data.error ?? `HTTP ${res.status}`,
      };
    }
    return {
      ok: true,
      providers: data.providers ?? [],
      activeProviderId: data.activeProviderId,
    };
  } catch (err) {
    return {
      ok: false,
      providers: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 新增或更新提供商；带 id 即更新，apiKey 为空表示不改密钥。 */
export function saveProvider(input: {
  id?: string;
  name?: string;
  baseURL?: string;
  apiKey?: string;
  model?: string;
}): Promise<ProvidersResult> {
  return providerRequest("/api/providers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
}

/** 删除提供商（写操作统一 POST）。 */
export function deleteProvider(id: string): Promise<ProvidersResult> {
  return providerRequest("/api/providers/delete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
}

/** 切换激活的提供商（热生效）。 */
export function activateProvider(id: string): Promise<ProvidersResult> {
  return providerRequest("/api/providers/activate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id }),
  });
}

export async function fetchConfig(): Promise<ServerConfig | null> {
  const r = await postJson<ServerConfig>("/api/config/get");
  return r.ok ? r.data : null;
}

/**
 * 拉取服务端可用模型列表。
 *
 * 失败时返回 `{ ok: false, error }`，调用方据此把模型输入框降级为手工输入，
 * 并提示「获取失败，请手动输入模型名」。
 */
export async function fetchModels(
  baseUrl?: string,
  apiKey?: string,
): Promise<{ ok: boolean; models: string[]; error?: string }> {
  const r = await postJson<{ models?: unknown; error?: string }>("/api/models", {
    ...(baseUrl?.trim() ? { baseUrl: baseUrl.trim() } : {}),
    ...(apiKey?.trim() ? { apiKey: apiKey.trim() } : {}),
  });
  if (!r.ok) {
    return {
      ok: false,
      models: [],
      error: r.data?.error ?? `HTTP ${r.status}`,
    };
  }
  const models = Array.isArray(r.data?.models)
    ? r.data.models.filter((m): m is string => typeof m === "string")
    : [];
  if (models.length === 0) {
    return { ok: false, models: [], error: "服务端未返回任何模型" };
  }
  return { ok: true, models };
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

// --- 应用配置（权限 / 插件 / 外观）----------------------------------------

/**
 * 设置类型统一来自 `lib/settings.ts`（单一真源）。
 * 这里只做再导出，方便 API 调用方就近引用。
 */
export type {
  AppSettings,
  PermissionMode,
  ThemeMode,
  FontSize,
  AgentPreset,
} from "./settings";

import type { AppSettings } from "./settings";

/** 可由设置面板切换的内置插件。 */
export type PluginId = "fs-tools" | "shell" | "echo-tool" | "session-log";

/** 提交应用配置（与 LLM 配置共用 /api/config）。 */
export async function updateAppSettings(
  settings: Partial<AppSettings>,
): Promise<{ ok: boolean; settings?: AppSettings; tools?: string[]; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/api/config`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      settings?: AppSettings;
      tools?: string[];
      error?: string;
    };
    if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` };
    return { ok: true, settings: data.settings, tools: data.tools };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// --- 文件树 ---------------------------------------------------------------

export interface FileNode {
  path: string;
  name: string;
  type: "file" | "dir";
  size?: number;
  children?: FileNode[];
}

export async function fetchFileTree(): Promise<{ ok: boolean; tree?: FileNode; root?: string }> {
  try {
    const res = await fetch(`${API_BASE}/api/files`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!res.ok) return { ok: false };
    const data = (await res.json()) as { ok: boolean; tree: FileNode; root: string };
    return { ok: data.ok, tree: data.tree, root: data.root };
  } catch {
    return { ok: false };
  }
}

export async function fetchFileContent(
  path: string,
): Promise<{ ok: boolean; content?: string; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/api/files/content`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      content?: string;
      error?: string;
    };
    if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` };
    return { ok: true, content: data.content };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// --- 终端执行 -------------------------------------------------------------

export interface ExecResult {
  ok: boolean;
  command?: string;
  stdout?: string;
  stderr?: string;
  code?: number | null;
  timedOut?: boolean;
  durationMs?: number;
  error?: string;
}

export async function execCommand(command: string): Promise<ExecResult> {
  try {
    const res = await fetch(`${API_BASE}/api/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command }),
    });
    const data = (await res.json().catch(() => ({}))) as ExecResult & { error?: string };
    if (!res.ok) return { ok: false, error: data.error ?? `HTTP ${res.status}` };
    return data;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// --- 插件管理 -------------------------------------------------------------

export type PluginStatus = "loaded" | "disabled" | "error";

export interface PluginInfo {
  id: string;
  name: string;
  version?: string;
  module: string;
  status: PluginStatus;
  error?: string;
  loadMs?: number;
  sourceDir?: string;
}

export async function fetchPlugins(): Promise<{ ok: boolean; plugins: PluginInfo[] }> {
  try {
    const res = await fetch(`${API_BASE}/api/plugins`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!res.ok) return { ok: false, plugins: [] };
    const data = (await res.json()) as { ok: boolean; plugins: PluginInfo[] };
    return { ok: data.ok, plugins: data.plugins ?? [] };
  } catch {
    return { ok: false, plugins: [] };
  }
}

export async function reloadPlugins(
  id?: string,
): Promise<{ ok: boolean; plugins: PluginInfo[]; error?: string }> {
  try {
    const res = await fetch(`${API_BASE}/api/plugins/reload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(id ? { id } : {}),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      plugins?: PluginInfo[];
      error?: string;
    };
    if (!res.ok) return { ok: false, plugins: [], error: data.error ?? `HTTP ${res.status}` };
    return { ok: true, plugins: data.plugins ?? [] };
  } catch (err) {
    return { ok: false, plugins: [], error: err instanceof Error ? err.message : String(err) };
  }
}

// --- 轨迹事件（Trace）-----------------------------------------------------

export type TraceEventType =
  | "run.start"
  | "step.thinking"
  | "stream.delta"
  | "tool.call"
  | "tool.result"
  | "answer"
  | "run.end"
  | "error";

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  firstTokenMs?: number;
  tokensPerSecond?: number;
}

export interface TraceEvent {
  id: string;
  traceId: string;
  sessionId: string;
  type: TraceEventType;
  step: number;
  timestamp: number;
  duration: number;
  title: string;
  toolName?: string;
  callId?: string;
  args?: Record<string, unknown>;
  result?: string;
  isError?: boolean;
  tokenUsage?: TokenUsage;
  schema?: Record<string, unknown>;
  rawPayload?: string;
  error?: string;
}

export async function fetchTraceEvents(sessionId: string): Promise<{
  ok: boolean;
  events: TraceEvent[];
  error?: string;
}> {
  if (!sessionId) return { ok: false, events: [] };
  try {
    const res = await fetch(`${API_BASE}/api/session/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      events?: TraceEvent[];
      error?: string;
    };
    if (!res.ok) return { ok: false, events: [], error: data.error ?? `HTTP ${res.status}` };
    return { ok: true, events: data.events ?? [] };
  } catch (err) {
    return { ok: false, events: [], error: err instanceof Error ? err.message : String(err) };
  }
}

// --- 子代理 ---------------------------------------------------------------

export interface SubAgentRecord {
  id: string;
  role: string;
  task: string;
  status: "running" | "done" | "error";
  startedAt: number;
  finishedAt?: number;
  sessionId: string;
  result?: string;
  error?: string;
}

export async function fetchSubAgents(): Promise<{
  ok: boolean;
  running: number;
  total: number;
  agents: SubAgentRecord[];
}> {
  try {
    const res = await fetch(`${API_BASE}/api/subagents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    if (!res.ok) return { ok: false, running: 0, total: 0, agents: [] };
    const d = (await res.json()) as {
      ok: boolean;
      running?: number;
      total?: number;
      agents?: SubAgentRecord[];
    };
    return {
      ok: d.ok,
      running: d.running ?? 0,
      total: d.total ?? 0,
      agents: d.agents ?? [],
    };
  } catch {
    return { ok: false, running: 0, total: 0, agents: [] };
  }
}
