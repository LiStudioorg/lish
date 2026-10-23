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
import { registerFsTools } from "./tools/fs.js";

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
export function createRuntime(config: RuntimeConfig): Runtime {
  const ctx = new Context();

  // 会话服务
  const sessions = new SessionService(ctx, {
    defaults: { strict: false },
    ...(config.sessionDir ? { dir: config.sessionDir } : {}),
  });
  ctx.provide(SessionService.KEY, sessions);

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

  // 工具：文件系统工具绑定到工作区，路径沙箱对三个前端一律生效
  const tools = new ToolRegistry(ctx);
  ctx.provide(ToolRegistry.KEY, tools);
  registerFsTools(tools, config.workspaceRoot);

  // MockProvider 默认会请求 echo 工具；仅在使用 Mock 时注册，
  // 避免真实模型看到这个无实际用途的工具。
  if (config.provider && config.provider.name === "mock") {
    tools.register({
      name: "echo",
      description: "原样返回输入文本（演示/自测用）",
      parameters: { type: "object", properties: { text: { type: "string" } } },
      handler: (args) => String(args.text ?? ""),
    });
  }

  // Agent 循环
  const agent = new AgentLoop(ctx, { maxSteps: config.maxSteps });
  ctx.provide(AgentLoop.KEY, agent);

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
    updateLlmConfig,
    async shutdown() {
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
