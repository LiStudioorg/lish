/**
 * 运行时装配：把内核、Provider、工具与 Agent 组装成一个可用的实例。
 *
 * CLI / TUI / Web Server 三个前端共用这一份装配逻辑，
 * 避免各自重复接线导致行为漂移（例如某个前端忘了注册文件工具）。
 */

import { homedir } from "node:os";
import { join } from "node:path";

import { Context } from "./kernel/context.js";
import { AgentLoop } from "./core/agent-loop.js";
import { LlmRuntime, MockProvider, type LlmProvider } from "./core/llm.js";
import { OpenAIProvider } from "./core/providers/openai.js";
import { SessionService } from "./core/sessions.js";
import { ToolRegistry } from "./core/tools.js";
import { createFsTools } from "./tools/fs.js";
import { createShellTool } from "./tools/shell.js";
import {
  loadSettings,
  saveSettings,
  mergeSettings,
  type AppSettings,
} from "./core/settings.js";
import { PluginLoader } from "./core/plugins/loader.js";
import { TraceStore, type TraceEvent } from "./core/trace.js";
import {
  createSpawnAgentTool,
  SubAgentRegistry,
  type SubAgentRecord,
} from "./core/sub-agent.js";
import { PluginHotReloader } from "./core/plugins/hot-reload.js";
import { discoverPlugins, ensurePluginDir } from "./core/plugins/discover.js";
import type { LoadedPluginInfo } from "./core/plugins/loader.js";
import { existsSync } from "node:fs";

/** 前端共享的运行时配置。 */
export interface RuntimeConfig {
  apiKey: string;
  baseURL: string;
  model: string;
  /** 单轮 Agent 循环的最大步数。 */
  maxSteps: number;
  /** 文件工具的路径沙箱根目录。 */
  workspaceRoot: string;
  /** 会话日志目录；null 表示纯内存，不落盘。 */
  sessionDir: string | null;
  /** 覆盖 Provider（测试用）。 */
  provider?: LlmProvider;
}

/** 默认值集中在此，便于前端与文档保持一致。 */
export const DEFAULTS = {
  baseURL: "https://api.deepseek.com",
  model: "deepseek-chat",
  maxSteps: 8,
} as const;

/** 用法/配置错误：调用方应打印友好提示并以非零码退出，而不是抛出堆栈。 */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * 从环境变量读取运行时配置。
 *
 * - LLM_API_KEY   必填
 * - LLM_BASE_URL  默认 https://api.deepseek.com
 * - LLM_MODEL     默认 deepseek-chat
 * - LLISH_MAX_STEPS 默认 8
 * - LLISH_NO_PERSIST 设置后会话不落盘
 * - LLISH_MOCK=1    使用 MockProvider，无需 API Key、不联网（用于演示与端到端自测）
 */
export function readConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<RuntimeConfig> = {},
): RuntimeConfig {
  const useMock = env.LLISH_MOCK === "1" && !overrides.provider;
  const apiKey = env.LLM_API_KEY?.trim() ?? "";
  if (!apiKey && !overrides.provider && !useMock) {
    throw new UsageError(
      "缺少环境变量 LLM_API_KEY。\n示例：LLM_API_KEY=sk-xxx lish web",
    );
  }

  const maxStepsRaw = env.LLISH_MAX_STEPS?.trim();
  const maxSteps = maxStepsRaw ? Number(maxStepsRaw) : DEFAULTS.maxSteps;
  if (!Number.isFinite(maxSteps) || maxSteps <= 0) {
    throw new UsageError(`LLISH_MAX_STEPS 必须是正整数，收到：${maxStepsRaw}`);
  }

  if (useMock) {
    // 动态引入，避免 CLI 启动时无谓加载 Mock 代码
    overrides = { ...overrides, provider: new MockProvider() };
  }

  return {
    apiKey,
    baseURL: env.LLM_BASE_URL?.trim() || DEFAULTS.baseURL,
    model: env.LLM_MODEL?.trim() || DEFAULTS.model,
    maxSteps: Math.floor(maxSteps),
    workspaceRoot: process.cwd(),
    sessionDir: env.LLISH_NO_PERSIST ? null : join(homedir(), ".lish", "sessions"),
    ...overrides,
  };
}

/** 装配完成后的运行时，前端直接使用即可。 */
export interface Runtime {
  ctx: Context;
  sessions: SessionService;
  llm: LlmRuntime;
  tools: ToolRegistry;
  agent: AgentLoop;
  config: RuntimeConfig;
  /**
   * 热更新 LLM 配置（API Key / Base URL / Model）。
   *
   * 重建一个 OpenAIProvider 并交给 LlmRuntime.setProvider 替换——
   * 这正是 LlmRuntime 热切换能力的设计用途，无需重启进程。
   * 返回更新后的配置快照。
   */
  updateLlmConfig(patch: LlmConfigPatch): RuntimeConfig;
  /** 当前应用配置（权限、插件开关、外观）。 */
  getSettings(): AppSettings;
  /** 合并并持久化应用配置，同时让工具注册即时生效。 */
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  /** 工作区根目录（文件树与终端的工作目录）。 */
  workspaceRoot: string;
  /** 当前已加载的插件列表。 */
  listPlugins(): LoadedPluginInfo[];
  /** 热重载指定插件（或全部）。 */
  reloadPlugins(id?: string): Promise<LoadedPluginInfo[]>;
  /** 读取某会话的轨迹事件。 */
  listTraceEvents(sessionId: string): TraceEvent[];
  /** 子代理运行记录（前端状态栏与轨迹分组用）。 */
  listSubAgents(): SubAgentRecord[];
  /** 拆除运行时：冲洗会话日志并销毁内核。 */
  shutdown(): Promise<void>;
}

/** 可由设置面板修改的字段。 */
export interface LlmConfigPatch {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  maxSteps?: number;
}

/** 对外暴露的配置视图（apiKey 脱敏）。 */
export interface PublicConfig {
  baseURL: string;
  model: string;
  maxSteps: number;
  workspaceRoot: string;
  /** 已脱敏的密钥，例如 `sk-…abcd`；未配置时为空串。 */
  apiKeyMasked: string;
  hasApiKey: boolean;
  /** 当前 Provider 名称（如 openai / mock）。 */
  providerName: string;
  /** 前端不应拿到完整密钥。 */
  tools: string[];
}

/** 脱敏 API Key：仅保留前 3 位与后 4 位。 */
export function maskApiKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return "*".repeat(key.length);
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

/** 装配一个完整的运行时。 */
export async function createRuntime(config: RuntimeConfig): Promise<Runtime> {
  const ctx = new Context();

  // 会话服务
  const sessions = new SessionService(ctx, {
    defaults: { strict: false },
    ...(config.sessionDir ? { dir: config.sessionDir } : {}),
  });
  ctx.provide(SessionService.KEY, sessions);
  // 事件溯源：启动时恢复磁盘上的历史会话
  const restored = await sessions.loadFromDisk();
  if (restored > 0) {
    console.log(`  已恢复 ${restored} 个历史会话`);
  }

  // LLM 运行时
  const provider =
    config.provider ??
    new OpenAIProvider({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      model: config.model,
    });
  const llm = new LlmRuntime(ctx, { provider });
  ctx.provide(LlmRuntime.KEY, llm);

  // 工具注册表
  const tools = new ToolRegistry(ctx);
  ctx.provide(ToolRegistry.KEY, tools);

  // --- 应用配置（权限 / 插件开关），从磁盘加载 ---
  let appSettings: AppSettings = await loadSettings();

  const fsTools = createFsTools(config.workspaceRoot, {
    // 传入 getter：用户在设置里改权限后，工具行为立即变化，无需重启
    permission: () => appSettings.permission,
  });

  const shellTool = createShellTool(config.workspaceRoot);

  const echoTool = {
    name: "echo",
    description: "原样返回输入文本（演示/自测用）",
    parameters: { type: "object", properties: { text: { type: "string" } } },
    handler: (args: Record<string, unknown>) => String(args.text ?? ""),
  };

  /**
   * 依据插件开关同步工具注册表。
   *
   * 关掉某个插件 = 从注册表移除对应工具，
   * 模型的 tools 列表随之缩小，因此**物理上无法调用**。
   */
  const syncTools = () => {
    const want = {
      "fs.read": appSettings.plugins["fs-tools"],
      "fs.write": appSettings.plugins["fs-tools"],
      "shell.run": appSettings.plugins.shell,
      echo: appSettings.plugins["echo-tool"] && config.provider?.name === "mock",
    } as const;

    const register = {
      "fs.read": () => fsTools.read,
      "fs.write": () => fsTools.write,
      "shell.run": () => shellTool,
      echo: () => echoTool,
    } as const;

    for (const [name, enabled] of Object.entries(want)) {
      const key = name as keyof typeof register;
      if (enabled) {
        if (!tools.has(name)) tools.register(register[key]());
      } else if (tools.has(name)) {
        tools.unregister(name);
      }
    }
  };

  syncTools();

  // 轨迹存储：注入给 AgentLoop，核心只负责写事件
  const traceStore = new TraceStore(2000);

  /*
   * 轨迹持久化：同步写入该会话的 append-only JSONL。
   *
   * 事件溯源要求轨迹不丢失，因此不能只存内存。
   * 记录 type 前缀 `trace.` 以便与对话事件区分，并按原字段展开存储。
   */
  traceStore.setPersist((event) => {
    const session = sessions.get(event.sessionId);
    if (!session) return;
    session.append({
      type: "trace.event",
      trace: event,
    });
  });

  // Agent 循环
  const agent = new AgentLoop(ctx, { maxSteps: config.maxSteps, traceStore });
  ctx.provide(AgentLoop.KEY, agent);

  /*
   * 子智能体：通过 spawn_agent 工具暴露。
   * 采用工具而非核心分支，符合开闭原则；子代理继承同一 ctx / tools / traceStore。
   */
  const subAgents = new SubAgentRegistry();
  const spawnTool = createSpawnAgentTool({
    ctx,
    sessions,
    agent,
    tools,
    registry: subAgents,
    maxDepth: 2,
    maxSteps: 6,
  });
  // 子代理能力独立于其它插件开关：即使只保留对话能力也可派生
  tools.register(spawnTool);

  // --- 插件系统（Bundle / Patch / Loader + HMR）---
  const pluginDir = process.env.LISH_PLUGINS_DIR ?? join(homedir(), ".lish", "plugins");
  const patchFiles: string[] = [];
  // 约定：~/.lish/plugins/*/patch.json 会被自动应用
  if (existsSync(pluginDir)) {
    try {
      const { readdirSync } = await import("node:fs");
      for (const entry of readdirSync(pluginDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const candidate = join(pluginDir, entry.name, "patch.json");
        if (existsSync(candidate)) patchFiles.push(candidate);
      }
    } catch {
      // 目录不可读时跳过
    }
  }
  // 仓库内置示例（便于本地验证整套链路）
  const bundledPatch = join(config.workspaceRoot, "examples", "plugins", "hello-world", "patch.json");
  if (process.env.LISH_LOAD_EXAMPLE_PLUGIN === "1" && existsSync(bundledPatch)) {
    patchFiles.push(bundledPatch);
  }

  // 确保插件目录存在（不存在则创建，便于用户直接投放插件）
  await ensurePluginDir(pluginDir);

  // 扫描单文件插件（.ts/.js 直投即生效）
  const discovered = await discoverPlugins(pluginDir);

  const loader = await PluginLoader.create({
    ctx,
    baseRows: discovered,
    patchFiles,
    resolveBase: config.workspaceRoot,
  });

  const hotReloader = new PluginHotReloader({
    loader,
    dirs: [pluginDir],
  });

  // 可变配置：设置面板通过 updateLlmConfig 热更新
  let currentConfig: RuntimeConfig = { ...config };

  const updateLlmConfig = (patch: LlmConfigPatch): RuntimeConfig => {
    const next: RuntimeConfig = {
      ...currentConfig,
      ...(patch.baseURL !== undefined && patch.baseURL.trim().length > 0
        ? { baseURL: patch.baseURL.trim() }
        : {}),
      ...(patch.model !== undefined && patch.model.trim().length > 0
        ? { model: patch.model.trim() }
        : {}),
      ...(patch.apiKey !== undefined && patch.apiKey.trim().length > 0
        ? { apiKey: patch.apiKey.trim() }
        : {}),
      ...(patch.maxSteps !== undefined && Number.isFinite(patch.maxSteps)
        ? { maxSteps: Math.max(1, Math.floor(patch.maxSteps)) }
        : {}),
    };

    currentConfig = next;

    // 若是 Mock 模式，保持 Mock，不因设置面板改动而切到真实网络。
    if (!(currentConfig.provider && currentConfig.provider.name === "mock")) {
      llm.setProvider(
        new OpenAIProvider({
          apiKey: next.apiKey,
          baseURL: next.baseURL,
          model: next.model,
        }),
      );
    }
    return currentConfig;
  };

  return {
    ctx,
    sessions,
    llm,
    tools,
    agent,
    // 用 getter 保证外部读到的是最新配置（设置面板热更新后仍准确）
    get config() {
      return currentConfig;
    },
    workspaceRoot: config.workspaceRoot,
    listPlugins() {
      return loader.list();
    },
    listSubAgents() {
      return subAgents.list();
    },
    listTraceEvents(sessionId: string) {
      // 内存为空时尝试从会话日志回放（进程重启后的历史轨迹）
      if (!traceStore.has(sessionId)) {
        const session = sessions.get(sessionId);
        if (session) {
          const persisted: TraceEvent[] = [];
          for (const e of session.log) {
            if (e.type === "trace.event" && e.trace) {
              persisted.push(e.trace as TraceEvent);
            }
          }
          traceStore.hydrate(sessionId, persisted);
        }
      }
      return traceStore.list(sessionId);
    },
    async reloadPlugins(id?: string) {
      if (id) {
        await loader.update(id, {});
      } else {
        for (const p of loader.list()) {
          await loader.update(p.id, {});
        }
      }
      return loader.list();
    },
    getSettings() {
      return appSettings;
    },
    async updateSettings(patch: Partial<AppSettings>) {
      appSettings = mergeSettings(appSettings, patch);
      syncTools();
      try {
        await saveSettings(appSettings);
      } catch {
        // 写入失败不应阻断本次会话，内存中的配置仍然生效
      }
      return appSettings;
    },
    updateLlmConfig,
    async shutdown() {
      hotReloader.dispose();
      try {
        await loader.disposeAll();
      } catch {
        // 插件清理失败不应阻断拆除
      }
      try {
        await sessions.flushAll();
      } catch {
        // 日志写入失败不应阻断拆除流程。
      }
      try {
        await ctx.dispose();
      } catch {
        // 拆除阶段的错误同样不应外溢。
      }
    },
  };
}
