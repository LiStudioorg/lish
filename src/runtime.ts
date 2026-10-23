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
  /** 拆除运行时：冲洗会话日志并销毁内核。 */
  shutdown(): Promise<void>;
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

  return {
    ctx,
    sessions,
    llm,
    tools,
    agent,
    config,
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
