/**
 * 运行时装配：把内核、Provider、工具与 Agent 组装成一个可用的实例。
 *
 * CLI / TUI / Web Server 三个前端共用这一份装配逻辑，
 * 避免各自重复接线导致行为漂移（例如某个前端忘了注册文件工具）。
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";

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
import { presetPromptOf } from "./core/presets.js";
import { PluginHotReloader } from "./core/plugins/hot-reload.js";
import { discoverPlugins, ensurePluginDir } from "./core/plugins/discover.js";
import type { LoadedPluginInfo } from "./core/plugins/loader.js";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";

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
 * 未配置 API Key 时的占位 Provider。
 *
 * 存在的意义：**Web / TUI 必须能在裸环境下启动**。
 * 真正的密钥缺失不应该变成「进程起不来」，而应该在用户发出第一条消息时
 * 给出可操作的指引（去设置里填 Key）。因此这里只在 `generate` 时报错。
 */
export class UnconfiguredProvider implements LlmProvider {
  readonly name = "unconfigured";

  generate(): Promise<never> {
    return Promise.reject(
      new UsageError(
        "尚未配置 API Key，请点击左下角【设置】填写您的 API Key 和模型后重试。",
      ),
    );
  }
}

/**
 * 一个「模型提供商」条目。
 *
 * 用户可以在设置里添加任意多个（DeepSeek / OpenAI / 本地 Ollama / 中转网关…），
 * 运行时始终只使用当前激活的那一个。
 */
export interface ProviderEntry {
  /** 稳定 id，创建后不变，用于选中与删除。 */
  id: string;
  /** 展示名，用户可改，例如「DeepSeek 官方」。 */
  name: string;
  baseURL: string;
  apiKey: string;
  /** 最近一次选择的模型；获取模型列表后会被写入。 */
  model: string;
}

/**
 * `~/.lish/config.json` 的持久化结构。
 *
 * 兼容早期扁平结构（顶层 `apiKey` / `baseURL` / `model`）：
 * 读取时若没有 `providers` 但存在顶层字段，会自动迁移成一条提供商记录。
 */
export interface FileConfig {
  providers?: ProviderEntry[];
  activeProviderId?: string;
  /** 以下为 v0.1 的扁平字段，仅用于向后兼容读取。 */
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

/** 配置文件路径：尊重 `LISH_CONFIG_FILE` 覆盖（测试用），否则 `~/.lish/config.json`。 */
export function configFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const custom = env.LISH_CONFIG_FILE?.trim();
  if (custom) return custom;
  return join(homedir(), ".lish", "config.json");
}

/** 生成一个稳定且可读的提供商 id（无需外部依赖）。 */
export function makeProviderId(): string {
  return `p_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** 规范化单条提供商记录；字段类型不对或缺少 id 时返回 null。 */
function normalizeProvider(raw: unknown): ProviderEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const str = (key: string): string =>
    typeof r[key] === "string" ? (r[key] as string).trim() : "";
  const id = str("id");
  if (!id) return null;
  const baseURL = str("baseURL") || str("baseUrl") || DEFAULTS.baseURL;
  return {
    id,
    name: str("name") || baseURL,
    baseURL,
    apiKey: str("apiKey"),
    model: str("model"),
  };
}

/**
 * 读取 `~/.lish/config.json`。
 *
 * 任何异常（文件不存在、JSON 损坏、字段类型不对）都降级为空配置，
 * 绝不因为配置文件问题阻断启动。
 */
export function readFileConfig(
  env: NodeJS.ProcessEnv = process.env,
): FileConfig {
  const file = configFilePath(env);
  try {
    if (!existsSync(file)) return {};
    const raw = readFileSync(file, "utf8");
    if (!raw.trim()) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const record = parsed as Record<string, unknown>;
    const pick = (key: string): string | undefined => {
      const value = record[key];
      return typeof value === "string" && value.trim() ? value.trim() : undefined;
    };

    const legacy = {
      apiKey: pick("apiKey"),
      baseURL: pick("baseURL") ?? pick("baseUrl"),
      model: pick("model"),
    };

    const providers = Array.isArray(record.providers)
      ? record.providers
          .map(normalizeProvider)
          .filter((p): p is ProviderEntry => p !== null)
      : [];

    // 向后兼容：老版本只有扁平字段 → 自动迁移成一条提供商
    if (providers.length === 0 && (legacy.apiKey || legacy.baseURL || legacy.model)) {
      const migrated: ProviderEntry = {
        id: makeProviderId(),
        name: legacy.baseURL ?? DEFAULTS.baseURL,
        baseURL: legacy.baseURL ?? DEFAULTS.baseURL,
        apiKey: legacy.apiKey ?? "",
        model: legacy.model ?? "",
      };
      return {
        providers: [migrated],
        activeProviderId: migrated.id,
        ...legacy,
      };
    }

    const activeId = pick("activeProviderId");
    return {
      providers,
      activeProviderId:
        activeId && providers.some((p) => p.id === activeId)
          ? activeId
          : providers[0]?.id,
      ...legacy,
    };
  } catch {
    return {};
  }
}

/** 取当前激活的提供商；没有则返回 undefined。 */
export function activeProvider(
  config: FileConfig,
): ProviderEntry | undefined {
  const list = config.providers ?? [];
  if (list.length === 0) return undefined;
  return list.find((p) => p.id === config.activeProviderId) ?? list[0];
}

/**
 * 把提供商表写回 `~/.lish/config.json`。
 *
 * 采用「整表覆盖」而不是增量合并：提供商可能被新增、改名、删除，
 * 增量语义无法表达删除。写失败不抛错（只读文件系统、权限不足等），
 * 仅返回 false 交由调用方告警——绝不因落盘失败阻断交互。
 *
 * 文件权限固定 0600，因为它包含明文密钥。
 */
export async function saveProviders(
  providers: ProviderEntry[],
  activeProviderId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const file = configFilePath(env);
  try {
    await mkdir(dirname(file), { recursive: true });
    const body: FileConfig = {
      providers,
      ...(activeProviderId ? { activeProviderId } : {}),
    };
    await writeFile(file, JSON.stringify(body, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 把若干字段写入「当前激活的提供商」，必要时自动补建一条。
 *
 * 保留该函数是为了让单字段更新（如只改 maxSteps 之外的模型参数）
 * 仍然只影响激活项，而不是另起一条记录。
 */
export async function writeFileConfig(
  patch: FileConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  const current = readFileConfig(env);
  const list = [...(current.providers ?? [])];
  const active = activeProvider(current);
  let activeId = current.activeProviderId;

  if (active) {
    const idx = list.findIndex((p) => p.id === active.id);
    list[idx] = {
      ...active,
      ...(patch.apiKey ? { apiKey: patch.apiKey } : {}),
      ...(patch.baseURL ? { baseURL: patch.baseURL } : {}),
      ...(patch.model ? { model: patch.model } : {}),
    };
  } else {
    const created: ProviderEntry = {
      id: makeProviderId(),
      name: patch.baseURL ?? DEFAULTS.baseURL,
      baseURL: patch.baseURL ?? DEFAULTS.baseURL,
      apiKey: patch.apiKey ?? "",
      model: patch.model ?? "",
    };
    list.push(created);
    activeId = created.id;
  }
  return saveProviders(list, activeId ?? list[0]?.id, env);
}

/**
 * 从环境变量 + `~/.lish/config.json` 读取运行时配置。
 *
 * 优先级：**环境变量 > `~/.lish/config.json` > 空配置**。
 * 没有 API Key 时不再抛错——Web 与 TUI 必须能在裸环境下启动，
 * 由前端引导用户在设置里填写。
 *
 * - LLM_API_KEY / LLM_BASE_URL / LLM_MODEL  覆盖配置文件
 * - LLISH_MAX_STEPS 默认 8
 * - LLISH_NO_PERSIST 设置后会话不落盘
 * - LLISH_MOCK=1    使用 MockProvider，无需 API Key、不联网（用于演示与端到端自测）
 */
export function readConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<RuntimeConfig> = {},
): RuntimeConfig {
  const useMock = env.LLISH_MOCK === "1" && !overrides.provider;
  const fileConfig = readFileConfig(env);
  const active = activeProvider(fileConfig);

  // 优先级：环境变量 > 当前激活的提供商 > 空配置
  const apiKey = env.LLM_API_KEY?.trim() || active?.apiKey || "";
  const fileBaseURL = active?.baseURL || fileConfig.baseURL;
  const fileModel = active?.model || fileConfig.model;

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
    baseURL: env.LLM_BASE_URL?.trim() || fileBaseURL || DEFAULTS.baseURL,
    model: env.LLM_MODEL?.trim() || fileModel || DEFAULTS.model,
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
  /** 热更新模型连接配置，并持久化到 ~/.lish/config.json。 */
  updateLlmConfig(patch: LlmConfigPatch): Promise<RuntimeConfig>;
  /** 全部已保存的提供商（含明文密钥，仅供后端内部使用）。 */
  listProviders(): ProviderEntry[];
  /** 当前激活的提供商 id。 */
  activeProviderId(): string | undefined;
  /** 新增或就地更新一个提供商（按 id 匹配），必要时切换激活项。 */
  upsertProvider(entry: Partial<ProviderEntry>): Promise<ProviderEntry[]>;
  /** 删除一个提供商；删掉激活项时自动回落到第一条。 */
  removeProvider(id: string): Promise<ProviderEntry[]>;
  /** 切换激活的提供商，并立即热切换底层 Provider。 */
  activateProvider(id: string): Promise<RuntimeConfig>;
  /** 当前应用配置（权限、插件开关、外观）。 */
  getSettings(): AppSettings;
  /** 合并并持久化应用配置，同时让工具注册即时生效。 */
  updateSettings(patch: Partial<AppSettings>): Promise<AppSettings>;
  /** 把当前 Agent 预设注入指定会话的 system prompt。 */
  applyPreset(sessionId: string): void;
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
  /** 提供商列表（密钥已脱敏），供设置面板管理多个来源。 */
  providers?: PublicProvider[];
  activeProviderId?: string;
}

/** 对外暴露的提供商视图（apiKey 永久脱敏）。 */
export interface PublicProvider {
  id: string;
  name: string;
  baseURL: string;
  model: string;
  apiKeyMasked: string;
  hasApiKey: boolean;
}

/** 脱敏 API Key：仅保留前 3 位与后 4 位。 */
export function maskApiKey(key: string): string {
  if (!key) return "";
  // 短密钥固定输出，避免通过 "*" 的数量反推真实长度
  if (key.length <= 8) return "sk-…****";
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
    (config.apiKey
      ? new OpenAIProvider({
          apiKey: config.apiKey,
          baseURL: config.baseURL,
          model: config.model,
        })
      : new UnconfiguredProvider());

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

  /**
   * 把当前预设注入到会话的 system prompt。
   *
   * 实现要点：
   *   - 预设作为一条带标记的 `message.system` 消息追加到会话；
   *   - 切换预设时先删掉旧的预设消息再追加新的，避免多条预设叠加；
   *   - 会话是 append-only 的，因此"删除"表现为追加一条覆盖指令之外的
   *     一次性重建（见下面的 rebuildPresetMessages）。
   *
   * 之所以在会话级别而不是全局变量里保存：并发的多个会话可能用不同预设，
   * 必须互不干扰。
   */
  const presetPromptCache = new Map<string, string>();

  /** 计算当前应注入的预设文本。 */
  const currentPresetPrompt = (): string => presetPromptOf(appSettings.agentPreset);

  /**
   * 确保会话的 system 消息与当前预设一致。
   *
   * 会话日志是 append-only 的，所以这里采取"追加 + 去重"策略：
   * 若已存在标记消息且内容相同则不做事；否则追加新的一条，
   * 并在构建消息数组时由 `hoistSystemPrompt` 合并（后者会保留全部正文）。
   * 为避免重复内容膨胀，追加前会记录本会话当前生效的预设文本。
   */
  const applyPresetToSession = (sessionId: string): void => {
    const session = sessions.get(sessionId);
    if (!session) return;
    const wanted = currentPresetPrompt();
    const previous = presetPromptCache.get(sessionId) ?? "";

    // 预设没变 → 不重复写日志
    if (wanted === previous) return;
    presetPromptCache.set(sessionId, wanted);

    // 无预设（理论上不会发生，standard 也有正文）→ 只清缓存
    if (!wanted) return;

    // 已有同内容的标记消息 → 不重复追加
    const exists = session.log.some(
      (e) =>
        e.type === "message.system" &&
        typeof e.content === "string" &&
        e.content === wanted,
    );
    if (!exists) session.appendSystemMessage(wanted);
  };

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
  /*
   * 插件目录。
   *
   * 命名统一为 LLISH_ 前缀（与其它变量一致）。
   * 早期版本误用 LISH_PLUGINS_DIR（单 L），这里保留作为兼容回退。
   */
  const pluginDir =
    process.env.LLISH_PLUGINS_DIR ??
    process.env.LISH_PLUGINS_DIR ??
    join(homedir(), ".lish", "plugins");
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

  const updateLlmConfig = async (
    patch: LlmConfigPatch,
  ): Promise<RuntimeConfig> => {
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
        next.apiKey
          ? new OpenAIProvider({
              apiKey: next.apiKey,
              baseURL: next.baseURL,
              model: next.model,
            })
          : new UnconfiguredProvider(),
      );
    }
    // 落盘：把这几个字段写回「当前激活的提供商」，而不是另起一条记录。
    // 若此刻还没有任何提供商（首次使用），自动补建一条，保证配置可回放。
    const target = providers.find((p) => p.id === currentProviderId);
    if (target) {
      providers = providers.map((p) =>
        p.id === target.id
          ? {
              ...p,
              ...(patch.apiKey ? { apiKey: patch.apiKey.trim() } : {}),
              ...(patch.baseURL?.trim() ? { baseURL: patch.baseURL.trim() } : {}),
              ...(patch.model?.trim() ? { model: patch.model.trim() } : {}),
            }
          : p,
      );
    } else {
      const created: ProviderEntry = {
        id: makeProviderId(),
        name: next.baseURL,
        baseURL: next.baseURL,
        apiKey: next.apiKey,
        model: next.model,
      };
      providers = [...providers, created];
      currentProviderId = created.id;
    }
    await persistProviders();

    return currentConfig;
  };

  // --- 多提供商管理 ------------------------------------------------------
  // 内存里保存完整列表（含明文 Key），只在后端使用；接口层负责脱敏。

  const initialFileConfig = readFileConfig();
  let providers: ProviderEntry[] = [...(initialFileConfig.providers ?? [])];
  let currentProviderId: string | undefined = initialFileConfig.activeProviderId;

  /** 把指定提供商装载到底层 LlmRuntime（Mock 模式除外）。 */
  const applyProvider = (entry: ProviderEntry | undefined): void => {
    if (currentConfig.provider && currentConfig.provider.name === "mock") return;
    if (!entry || !entry.apiKey) {
      llm.setProvider(new UnconfiguredProvider());
      return;
    }
    llm.setProvider(
      new OpenAIProvider({
        apiKey: entry.apiKey,
        baseURL: entry.baseURL || DEFAULTS.baseURL,
        model: entry.model || DEFAULTS.model,
      }),
    );
  };

  /** 由提供商条目推导出运行时配置快照。 */
  const configFromProvider = (base: RuntimeConfig): RuntimeConfig => {
    const entry = providers.find((p) => p.id === currentProviderId);
    if (!entry) return base;
    return {
      ...base,
      apiKey: entry.apiKey,
      baseURL: entry.baseURL || DEFAULTS.baseURL,
      model: entry.model || DEFAULTS.model,
    };
  };

  const persistProviders = async (): Promise<void> => {
    await saveProviders(providers, currentProviderId);
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
    listProviders() {
      return providers.map((p) => ({ ...p }));
    },
    activeProviderId() {
      return currentProviderId;
    },
    async upsertProvider(entry) {
      const id = entry.id?.trim();
      const existing = id ? providers.find((p) => p.id === id) : undefined;
      if (existing) {
        const merged: ProviderEntry = {
          ...existing,
          ...(entry.name !== undefined ? { name: entry.name.trim() || existing.name } : {}),
          ...(entry.baseURL !== undefined
            ? { baseURL: entry.baseURL.trim() || existing.baseURL }
            : {}),
          // 空字符串视为「不修改密钥」，避免前端把脱敏值回写
          ...(entry.apiKey ? { apiKey: entry.apiKey.trim() } : {}),
          ...(entry.model !== undefined ? { model: entry.model.trim() } : {}),
        };
        providers = providers.map((p) => (p.id === existing.id ? merged : p));
        if (currentProviderId === merged.id) {
          currentConfig = configFromProvider(currentConfig);
          applyProvider(merged);
        }
      } else {
        const created: ProviderEntry = {
          id: makeProviderId(),
          name: entry.name?.trim() || entry.baseURL?.trim() || "新提供商",
          baseURL: entry.baseURL?.trim() || DEFAULTS.baseURL,
          apiKey: entry.apiKey?.trim() ?? "",
          model: entry.model?.trim() || DEFAULTS.model,
        };
        providers = [...providers, created];
        // 第一条自动激活，省掉用户再点一次
        if (!currentProviderId) {
          currentProviderId = created.id;
          currentConfig = configFromProvider(currentConfig);
          applyProvider(created);
        }
      }
      await persistProviders();
      return providers.map((p) => ({ ...p }));
    },
    async removeProvider(id) {
      providers = providers.filter((p) => p.id !== id);
      if (currentProviderId === id) {
        currentProviderId = providers[0]?.id;
        currentConfig = configFromProvider(currentConfig);
        applyProvider(providers[0]);
      }
      await persistProviders();
      return providers.map((p) => ({ ...p }));
    },
    async activateProvider(id) {
      const entry = providers.find((p) => p.id === id);
      if (!entry) {
        throw new UsageError(`提供商不存在：${id}`);
      }
      currentProviderId = entry.id;
      currentConfig = configFromProvider(currentConfig);
      applyProvider(entry);
      await persistProviders();
      return currentConfig;
    },
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
    /** 在会话开跑前把当前预设注入 system prompt（由 server / TUI 调用）。 */
    applyPreset(sessionId: string) {
      applyPresetToSession(sessionId);
    },
    async updateSettings(patch: Partial<AppSettings>) {
      appSettings = mergeSettings(appSettings, patch);
      syncTools();
      // 预设切换：让所有已有会话在下一轮重新同步
      presetPromptCache.clear();
      for (const sessionId of sessions.list()) {
        applyPresetToSession(sessionId);
      }
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
