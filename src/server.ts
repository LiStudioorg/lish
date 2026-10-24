/**
 * Web 服务（express）。
 *
 * 接口约定：所有 `/api/*` 端点统一使用 **POST + JSON 请求体**（RPC 风格），
 * 动作由路径表达、参数由 body 承载；只有 `/` 静态页面走 GET。
 *
 *   POST /api/chat            接收用户消息，以 AI SDK 数据流协议流式返回
 *   POST /api/health          健康检查
 *   POST /api/config/get      读取配置
 *   POST /api/config          更新配置
 *   POST /api/providers/list  列出提供商
 *   POST /api/providers       新增 / 更新提供商
 *   POST /api/providers/delete    删除提供商
 *   POST /api/providers/activate  切换激活提供商
 *   POST /api/models          拉取上游模型列表
 *   POST /api/session/events  会话轨迹
 *   POST /api/files           文件树
 *   POST /api/files/content   读取文件
 *   POST /api/exec            执行命令
 *   POST /api/plugins         插件列表
 *   POST /api/plugins/reload  热重载插件
 *   POST /api/subagents       子智能体列表
 *   GET  /                    静态页面（打包后的前端见 web/）
 *
 * 说明：
 *   后端依赖 Vercel AI SDK v4 的 `StreamData` / `toDataStreamResponse()`，
 *   前端 @ai-sdk/react 的 `useChat` 可直接消费该协议。
 *   工具中间状态通过 `dataStream.append({type, ...})` 推给前端，
 *   前端在 message.data 中读取并渲染成卡片。
 */

import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import cors from "cors";
import express, { type Request, type Response } from "express";
import { createDataStreamResponse, type JSONValue } from "ai";

import {
  AGENT_ABORTED,
  AGENT_STREAM_DELTA,
  AGENT_THINKING,
  AGENT_TOOL_CALL,
  AGENT_TOOL_RESULT,
} from "./core/agent-loop.js";
import type {
  Runtime,
  LlmConfigPatch,
  PublicConfig,
  PublicProvider,
} from "./runtime.js";
import { maskApiKey } from "./runtime.js";
import { readFileTree } from "./tools/file-tree.js";
import { runShell } from "./tools/shell.js";
import type { AppSettings } from "./core/settings.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 定位前端构建产物目录（web/out）。
 *
 * 必须以 `import.meta.url` 为锚点解析，**不能依赖 process.cwd()**：
 * 全局安装后用户可能在任意目录执行 `lish web`，
 * 相对路径查找会全部落空，导致前端 404 白屏。
 *
 * 支持的运行形态：
 *   1. 全局安装：<prefix>/lib/node_modules/lish/dist/server.js
 *      → 前端在 <prefix>/lib/node_modules/lish/web/out
 *   2. 源码运行：<repo>/src/server.ts → <repo>/web/out
 *   3. 编译后本地运行：<repo>/dist/server.js → <repo>/web/out
 *
 * 做法：从本文件所在目录逐级上溯，每级都检查 `web/out` 与 `web/dist`，
 * 命中第一个含 index.html 的目录即可。
 */
/**
 * 从上游 `/models` 响应中提取模型 id 列表。
 *
 * 兼容三种常见形态（OpenAI / DeepSeek / 部分兼容网关）：
 *   1. `{ data: [{ id: "..." }] }`
 *   2. `[{ id: "..." }]`
 *   3. `{ models: [{ name: "..." }] }`（Ollama 风格）
 * 任何无法识别的结构都返回空数组，由前端提示「获取失败，请手动输入模型名」。
 */
export function extractModelIds(payload: unknown): string[] {
  const collect = (list: unknown): string[] => {
    if (!Array.isArray(list)) return [];
    const ids: string[] = [];
    for (const item of list) {
      if (typeof item === "string" && item.trim()) {
        ids.push(item.trim());
        continue;
      }
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        for (const key of ["id", "name", "model"]) {
          const value = record[key];
          if (typeof value === "string" && value.trim()) {
            ids.push(value.trim());
            break;
          }
        }
      }
    }
    return ids;
  };

  const fromObject = (value: unknown): string[] => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return collect(value);
    }
    const record = value as Record<string, unknown>;
    for (const key of ["data", "models", "items"]) {
      const ids = collect(record[key]);
      if (ids.length > 0) return ids;
    }
    return [];
  };

  return [...new Set(fromObject(payload))].sort((a, b) => a.localeCompare(b));
}

export function resolveWebRoot(startDir: string = here): string | null {
  /*
   * 以 import.meta.url 为锚点逐级上溯。
   *
   * 注意 Node 会解析软链：`npm link` 时 import.meta.url 指向真实源码路径，
   * 因此该方式天然兼容 link 场景；而 pnpm 的全局 store 路径较深
   * （.../pnpm/global/<ver>/node_modules/lish/dist），故上溯到 12 级。
   */
  let dir = startDir;
  for (let depth = 0; depth < 12; depth++) {
    // 1) 发布包内布局：<pkg>/dist/web/index.html（build:assets 生成）
    const packaged = join(dir, "web");
    if (existsSync(join(packaged, "index.html"))) return packaged;

    // 2) 开发仓库布局：<repo>/web/out 或 <repo>/web/dist
    for (const sub of ["out", "dist"]) {
      const candidate = join(dir, "web", sub);
      if (existsSync(join(candidate, "index.html"))) return candidate;
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export interface ServerOptions {
  port?: number;
  host?: string;
  /** 请求体大小上限，默认 1mb。 */
  limit?: string;
}

/**
 * 推给前端的工具事件统一结构（会出现在 useChat 的 message.data 里）。
 * 仅用于描述与前端共享的字段；写入时统一断言为 AI SDK 的 JSONValue。
 */
export interface ToolStreamEvent {
  type: "thinking" | "tool_call" | "tool_result" | "aborted" | "done";
  runId: string;
  step?: number;
  callId?: string;
  name?: string;
  argsJson?: string;
  content?: string;
  isError?: boolean;
  durationMs?: number;
  messageCount?: number;
  stopReason?: string;
  error?: string;
}

/**
 * 事件载荷的最小可用字段。
 *
 * 事件总线是异构载荷，这里用 unknown 接收后统一收窄，
 * 避免在业务层散落 any（AGENTS.md 第 6 条）。
 */
interface EventPayloadShape {
  runId?: string;
  sessionId?: string;
  step?: number;
  callId?: string;
  name?: string;
  argsJson?: string;
  args?: Record<string, unknown>;
  content?: string;
  isError?: boolean;
  durationMs?: number;
  messageCount?: number;
  stopReason?: string;
  error?: string;
  delta?: string;
}

/** 把 unknown 收窄为可读取的事件载荷；非对象返回 null。 */
function asEventPayload(value: unknown): EventPayloadShape | null {
  if (!value || typeof value !== "object") return null;
  return value as EventPayloadShape;
}

/** 创建 express 应用（不监听端口，便于测试）。 */
export function createApp(runtime: Runtime): express.Express {
  const app = express();

  // CORS：显式允许 Next.js 开发服务器。
  // 开发期也可能用到 3081（上游复刻项目的默认端口）与 127.0.0.1 变体。
  // 允许的来源：
  //   - 本机各端口（localhost / 127.0.0.1）
  //   - 局域网任意 IP 的 3081 / 5173 端口（手机、平板访问）
  // 不写死具体 IP，因为开发机的局域网地址会变化。
  const allowedPorts = new Set(["3081", "5173", "3000"]);
  const isAllowedOrigin = (origin: string): boolean => {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const port = url.port || (url.protocol === "https:" ? "443" : "80");
    if (!allowedPorts.has(port)) return false;
    const host = url.hostname;
    const isLocal =
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "[::1]";
    const isPrivate =
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host);
    return isLocal || isPrivate;
  };
  const allowedOrigins = {
    has: (origin: string) => isAllowedOrigin(origin),
  };
  app.use(
    cors({
      origin(origin, callback) {
        // 无 Origin（同源请求、curl、健康检查）直接放行
        if (!origin || allowedOrigins.has(origin)) {
          callback(null, true);
          return;
        }
        // 其余来源一律拒绝，避免任意站点驱动本机的文件读写工具。
        // 传 null + false 让 cors 中间件直接不发 CORS 头（浏览器即拦截），
        // 而不是抛错——抛错会被 express 当成 500，掩盖真实语义。
        callback(null, false);
      },
      methods: ["GET", "POST", "OPTIONS"],
      credentials: false,
    }),
  );
  app.use(express.json({ limit: "1mb" }));

  const webRoot = resolveWebRoot();
  if (webRoot) {
    // 生产模式：直接托管前端构建产物（单进程部署）
    app.use(
      express.static(webRoot, {
        setHeaders(res, filePath) {
          // 带哈希的静态资源可长缓存；index.html 必须每次校验
          if (filePath.endsWith("index.html")) {
            res.setHeader("cache-control", "no-cache");
          }
        },
      }),
    );
  } else {
    // 开发期常见：尚未构建前端。给出可操作的指引而不是 404 空白页。
    app.get("/", (_req, res) => {
      res
        .status(200)
        .type("text/html; charset=utf-8")
        .send(
          `<meta charset="utf-8"><body style="font-family:system-ui;background:#0b0d12;color:#e6e8ee;padding:40px">
           <h2>前端尚未构建</h2>
           <p>请先执行 <code>npm run build</code> 打包前端（生成 <code>web/dist</code>），再重新启动。</p>
           <p>开发模式下请改用 <code>npm run start:dev</code>（前端由 Next.js 开发服务器提供）。</p>
           <p>接口健康检查：<a style="color:#7aa2ff" href="/api/health">/api/health</a></p>
           </body>`,
        );
    });
  }

  app.post("/api/health", (_req, res) => {
    res.json({
      ok: true,
      model: runtime.config.model,
      workspace: runtime.config.workspaceRoot,
      sessions: runtime.sessions.size,
      tools: runtime.tools.list(),
    });
  });

  /**
   * 子代理列表。
   *
   * 前端用它展示「子智能体 N 个」以及轨迹面板中的独立子代理分组。
   */
  app.post("/api/subagents", (_req, res) => {
    try {
      const agents = runtime.listSubAgents();
      res.json({
        ok: true,
        running: agents.filter((a) => a.status === "running").length,
        total: agents.length,
        agents,
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * 会话轨迹事件。
   *
   * 返回完整事件数组，每条包含 traceId、毫秒时间戳、真实耗时与 tokenUsage，
   * 供前端轨迹面板渲染时间轴、条形图与详情。
   */
  app.post("/api/session/events", (req, res) => {
    const sessionId =
      typeof req.body?.sessionId === "string" ? req.body.sessionId.trim() : "";
    if (!sessionId) {
      res.status(400).json({ ok: false, error: "缺少 sessionId" });
      return;
    }
    try {
      const events = runtime.listTraceEvents(sessionId);
      res.json({
        ok: true,
        sessionId,
        count: events.length,
        events,
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * 插件列表。
   *
   * 返回每个插件的 id、名称、版本、状态（loaded/disabled/error）
   * 以及加载耗时与错误信息，供设置面板展示。
   */
  app.post("/api/plugins", (_req, res) => {
    try {
      res.json({ ok: true, plugins: runtime.listPlugins() });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * 热重载插件。
   *
   * body.id 指定单个插件；省略则重载全部。
   */
  app.post("/api/plugins/reload", async (req: Request, res: Response) => {
    const id = typeof req.body?.id === "string" ? req.body.id : undefined;
    try {
      const plugins = await runtime.reloadPlugins(id);
      res.json({ ok: true, plugins });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * 工作区文件树。
   *
   * 只读、限定 3 层深度、跳过 node_modules/.git 等重量级目录，
   * 因此在大仓库里也不会卡住。
   */
  app.post("/api/files", async (_req, res) => {
    try {
      const tree = await readFileTree(runtime.workspaceRoot, 3);
      res.json({ ok: true, root: runtime.workspaceRoot, tree });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * 读取单个文件内容（供预览面板使用）。
   *
   * 复用文件系统工具的权限判定：workspace 模式下禁止越界读取。
   */
  app.post("/api/files/content", async (req, res) => {
    const rel = typeof req.body?.path === "string" ? req.body.path : "";
    if (!rel) {
      res.status(400).json({ ok: false, error: "缺少 path 参数" });
      return;
    }
    try {
      const tool = runtime.tools.get("fs.read");
      if (!tool) {
        res.status(403).json({ ok: false, error: "文件系统工具已被禁用" });
        return;
      }
      const outcome = await runtime.tools.executeTool("fs.read", { path: rel });
      if (outcome.isError) {
        res.status(400).json({ ok: false, error: outcome.content });
        return;
      }
      res.json({ ok: true, path: rel, content: outcome.content });
    } catch (err) {
      res.status(400).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * 执行一条 shell 命令（终端面板）。
   *
   * 5 秒超时强制终止，输出长度受限。
   */
  app.post("/api/exec", async (req: Request, res: Response) => {
    const command = typeof req.body?.command === "string" ? req.body.command.trim() : "";
    if (!command) {
      res.status(400).json({ ok: false, error: "命令不能为空" });
      return;
    }
    const settings = runtime.getSettings();
    if (!settings.plugins.shell) {
      res.status(403).json({ ok: false, error: "终端插件已在设置中关闭" });
      return;
    }

    try {
      const result = await runShell(command, { cwd: runtime.workspaceRoot, timeoutMs: 5000 });
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  /**
   * 读取当前 LLM 配置。
   * API Key 一律脱敏后返回——前端只需要知道「有没有配」，
   * 绝不下发完整密钥（避免出现在浏览器历史、日志、截图中）。
   */
  /** 把运行时里的提供商列表脱敏成可下发视图。 */
  const publicProviders = (): PublicProvider[] =>
    runtime.listProviders().map((p) => ({
      id: p.id,
      name: p.name,
      baseURL: p.baseURL,
      model: p.model,
      apiKeyMasked: maskApiKey(p.apiKey),
      hasApiKey: p.apiKey.length > 0,
    }));

  /**
   * 列出全部模型提供商（密钥已脱敏）。
   *
   * 与 `POST /api/config/get` 的 `providers` 字段同源，单独提供是为了让
   * 设置面板可以只刷新提供商列表而不重取整份配置。
   */
  app.post("/api/providers/list", (_req, res) => {
    res.json({
      ok: true,
      providers: publicProviders(),
      activeProviderId: runtime.activeProviderId(),
    });
  });

  /**
   * 新增或更新一个模型提供商。
   *
   * 幂等约定：带 `id` 即更新该条（`apiKey` 为空表示不修改密钥）；
   * 不带 `id` 即新建。返回全量脱敏列表，前端直接整体替换，避免状态漂移。
   */
  app.post("/api/providers", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const str = (key: string): string | undefined =>
      typeof body[key] === "string" ? (body[key] as string) : undefined;

    const baseURL = str("baseURL")?.trim();
    if (baseURL !== undefined && baseURL.length > 0 && !/^https?:\/\//i.test(baseURL)) {
      res.status(400).json({ error: `baseURL 必须是 http(s) 地址：${baseURL}` });
      return;
    }

    try {
      await runtime.upsertProvider({
        id: str("id"),
        name: str("name"),
        baseURL,
        model: str("model"),
        apiKey: str("apiKey"),
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    res.json({
      ok: true,
      providers: publicProviders(),
      activeProviderId: runtime.activeProviderId(),
      config: {
        baseURL: runtime.config.baseURL,
        model: runtime.config.model,
        apiKeyMasked: maskApiKey(runtime.config.apiKey),
        hasApiKey: runtime.config.apiKey.length > 0,
        providerName: runtime.llm.providerName ?? "none",
      },
    });
  });

  /**
   * 删除一个提供商。
   *
   * 删掉激活项时自动回落到列表第一条；删除不存在的 id 视为幂等成功。
   * 写操作统一走 POST（本项目只保留 GET=查询 / POST=写入 两类语义）。
   */
  app.post("/api/providers/delete", async (req: Request, res: Response) => {
    const id = typeof req.body?.id === "string" ? req.body.id.trim() : "";
    if (!id) {
      res.status(400).json({ ok: false, error: "缺少 id" });
      return;
    }
    await runtime.removeProvider(id);
    res.json({
      ok: true,
      providers: publicProviders(),
      activeProviderId: runtime.activeProviderId(),
      config: {
        baseURL: runtime.config.baseURL,
        model: runtime.config.model,
        apiKeyMasked: maskApiKey(runtime.config.apiKey),
        hasApiKey: runtime.config.apiKey.length > 0,
        providerName: runtime.llm.providerName ?? "none",
      },
    });
  });

  /** 切换激活的提供商，立即热生效（无需重启）。 */
  app.post("/api/providers/activate", async (req: Request, res: Response) => {
    const id = typeof req.body?.id === "string" ? req.body.id.trim() : "";
    if (!id) {
      res.status(400).json({ ok: false, error: "缺少 id" });
      return;
    }
    try {
      await runtime.activateProvider(id);
    } catch (err) {
      res.status(404).json({
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    res.json({
      ok: true,
      providers: publicProviders(),
      activeProviderId: runtime.activeProviderId(),
      config: {
        baseURL: runtime.config.baseURL,
        model: runtime.config.model,
        apiKeyMasked: maskApiKey(runtime.config.apiKey),
        hasApiKey: runtime.config.apiKey.length > 0,
        providerName: runtime.llm.providerName ?? "none",
      },
    });
  });

  app.post("/api/config/get", (_req, res) => {
    const cfg = runtime.config;
    const view: PublicConfig = {
      baseURL: cfg.baseURL,
      model: cfg.model,
      maxSteps: cfg.maxSteps,
      workspaceRoot: cfg.workspaceRoot,
      apiKeyMasked: maskApiKey(cfg.apiKey),
      hasApiKey: cfg.apiKey.length > 0,
      providerName: runtime.llm.providerName ?? "none",
      tools: runtime.tools.list(),
    };
    // 同时下发应用配置（权限 / 插件 / 外观），前端据此渲染并保持双向一致
    res.json({
      ...view,
      providers: publicProviders(),
      activeProviderId: runtime.activeProviderId(),
      settings: runtime.getSettings(),
    });
  });

  /**
   * 更新 LLM 配置（热生效，无需重启）。
   *
   * 安全约束：
   *   - 只接受白名单字段，未知字段忽略；
   *   - apiKey 传空串表示「不修改」，避免前端把脱敏值回写导致密钥被覆盖；
   *   - 请求体大小已由 express.json 限制。
   */
  app.post("/api/config", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;

    // --- 应用配置（权限 / 插件开关 / 外观）---
    const settingsPatch = body.settings as Partial<AppSettings> | undefined;
    if (settingsPatch && typeof settingsPatch === "object") {
      await runtime.updateSettings(settingsPatch);
    }

    const patch: LlmConfigPatch = {};
    if (typeof body.apiKey === "string" && body.apiKey.trim().length > 0) {
      patch.apiKey = body.apiKey.trim();
    }
    if (typeof body.baseURL === "string") patch.baseURL = body.baseURL;
    if (typeof body.model === "string") patch.model = body.model;
    if (typeof body.maxSteps === "number") patch.maxSteps = body.maxSteps;

    if (Object.keys(patch).length === 0) {
      if (settingsPatch) {
        // 仅更新了应用配置，直接返回最新状态
        res.json({ ok: true, settings: runtime.getSettings(), tools: runtime.tools.list() });
        return;
      }
      res.status(400).json({
        error: "没有可更新的字段（apiKey / baseURL / model / maxSteps / settings）",
      });
      return;
    }

    try {
      await runtime.updateLlmConfig(patch);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const cfg = runtime.config;
    console.log(
      `  配置已更新: model=${cfg.model} baseURL=${cfg.baseURL} key=${maskApiKey(cfg.apiKey) || "(未设置)"}`,
    );
    res.json({
      ok: true,
      config: {
        baseURL: cfg.baseURL,
        model: cfg.model,
        maxSteps: cfg.maxSteps,
        apiKeyMasked: maskApiKey(cfg.apiKey),
        hasApiKey: cfg.apiKey.length > 0,
        providerName: runtime.llm.providerName ?? "none",
      } satisfies Partial<PublicConfig>,
      settings: runtime.getSettings(),
      tools: runtime.tools.list(),
    });
  });

  /**
   * 拉取服务端可用模型列表。
   *
   * 查询参数 `baseUrl` / `apiKey` 可选：
   *   - 不传时使用当前运行时配置（用户在设置里已保存的地址与 Key）；
   *   - 传入时用于「刚填完还没保存」的前端预览。
   *
   * 兼容 OpenAI 的 `/models` 协议与 DeepSeek 的 `data[].id` 结构；
   * 上游任何异常都转成 502 + 结构化 error，由前端降级为手填输入框。
   */
  app.post("/api/models", async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const pickString = (value: unknown): string =>
      typeof value === "string" ? value.trim() : "";

    const baseURL = pickString(body.baseUrl) || runtime.config.baseURL;
    const apiKey = pickString(body.apiKey) || runtime.config.apiKey;

    if (!apiKey) {
      res.status(400).json({ error: "缺少 API Key，请先在设置中填写" });
      return;
    }
    if (!/^https?:\/\//i.test(baseURL)) {
      res.status(400).json({ error: `baseURL 不合法：${baseURL}` });
      return;
    }

    const endpoint = `${baseURL.replace(/\/+$/, "")}/models`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const upstream = await fetch(endpoint, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      });

      if (!upstream.ok) {
        const detail = await upstream.text().catch(() => "");
        res.status(502).json({
          error: `上游返回 ${upstream.status}`,
          detail: detail.slice(0, 300),
        });
        return;
      }

      const payload: unknown = await upstream.json().catch(() => null);
      res.json({ models: extractModelIds(payload), endpoint });
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      res.status(502).json({
        error: aborted ? "请求超时（10s）" : "无法连接模型服务",
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      clearTimeout(timer);
    }
  });

  app.post("/api/chat", async (req: Request, res: Response) => {
    const message = extractUserMessage(req.body);
    if (message.length === 0) {
      res.status(400).json({ error: "message 不能为空" });
      return;
    }

    const requestedSessionId =
      typeof req.body?.sessionId === "string" ? req.body.sessionId : "";

    const session = requestedSessionId
      ? runtime.sessions.get(requestedSessionId) ??
        runtime.sessions.create({ id: requestedSessionId, title: "web session" })
      : runtime.sessions.create({ title: "web session" });

    // AI SDK v4：在 execute 中拿到 writer，工具事件走侧通道（data: 帧），
    // 正文走 pipe 的文本流，前端 useChat 可直接消费。
    const response = createDataStreamResponse({
      onError: (err) => (err instanceof Error ? err.message : String(err)),
      execute: async (writer) => {
        // 先告知会话 id（前端据此做多轮复用）
        writer.writeData({ type: "session", sessionId: session.id });

        let runId: string | undefined;
        /** 是否收到过任何文本增量（决定是否需要兜底一次性写入）。 */
        let sawDelta = false;
        const handlers: Array<[string, (payload: unknown) => void]> = [];

        const cleanup = () => {
          for (const [name, handler] of handlers) runtime.ctx.off(name, handler);
          handlers.length = 0;
        };

        // 客户端一旦断开就立刻解绑，不必等本轮 Agent 跑完。
        // 否则断开的瞬间监听器仍挂着，既延迟释放，也会继续向已关闭的流写入。
        res.once("close", cleanup);

        // 只转发本次 run 的事件，避免并发请求串台
        const track = (name: string, build: (payload: EventPayloadShape) => ToolStreamEvent | null) => {
          const handler = (raw: unknown) => {
            const payload = asEventPayload(raw);
            if (!payload?.runId) return;
            if (runId === undefined) runId = payload.runId;
            if (payload.runId !== runId) return;
            const event = build(payload);
            // 转成 plain object 再写，避免 interface 与 JSONValue 的类型摩擦
            if (event) writer.writeData(asJson(event));
          };
          handlers.push([name, handler]);
          runtime.ctx.on(name, handler);
        };

        // 文本增量：直接写 `0:` 文本帧，前端据此逐字渲染。
        // 注意这里**不经过** writeData（data 帧），因为 useChat/我们的解析器
        // 把 `0:` 当作正文流，才是打字机效果的正确通道。
        const onDelta = (raw: unknown) => {
          const payload = asEventPayload(raw);
          if (!payload?.runId) return;
          if (runId === undefined) runId = payload.runId;
          if (payload.runId !== runId) return;
          if (typeof payload.delta === "string" && payload.delta.length > 0) {
            sawDelta = true;
            writer.write(`0:${JSON.stringify(payload.delta)}\n`);
          }
        };
        handlers.push([AGENT_STREAM_DELTA, onDelta]);
        runtime.ctx.on(AGENT_STREAM_DELTA, onDelta);

        track(AGENT_THINKING, (p) => ({
          type: "thinking",
          runId: p.runId ?? "",
          step: p.step,
          messageCount: p.messageCount,
        }));

        track(AGENT_TOOL_CALL, (p) => ({
          type: "tool_call",
          runId: p.runId ?? "",
          step: p.step,
          callId: p.callId,
          name: p.name,
          // 索引签名只允许标量，参数以 JSON 字符串传递，前端解析后渲染
          argsJson: JSON.stringify(p.args ?? {}),
        }));

        track(AGENT_TOOL_RESULT, (p) => ({
          type: "tool_result",
          runId: p.runId ?? "",
          step: p.step,
          callId: p.callId,
          name: p.name,
          content: p.content,
          isError: p.isError,
          durationMs: p.durationMs,
        }));

        track(AGENT_ABORTED, (p) => ({
          type: "aborted",
          runId: p.runId ?? "",
          stopReason: p.stopReason,
          error: p.error,
        }));

        try {
          const result = await runtime.agent.run(session, message);

          // 正文已通过 agent:stream_delta 逐段写入，这里不再重复推送。
          // 若模型未走流式（例如 Provider 不支持），回退为一次性写入，避免空回复。
          if (!sawDelta) {
            const fallback =
              result.text && result.text.length > 0 ? result.text : lastAssistantText(session);
            if (fallback.length > 0) {
              writer.write(`0:${JSON.stringify(fallback)}\n`);
            }
          }

          writer.writeData({
            type: "done",
            runId: runId ?? "",
            stopReason: result.stopReason,
            ...(result.error ? { error: result.error } : {}),
          });
        } catch (err) {
          writer.writeData({
            type: "aborted",
            runId: runId ?? "",
            stopReason: "error",
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          cleanup();
        }
      },
    });

    // 流式回传：把 Response 的 body 逐块写入 express 的 res
    res.status(response.status);
    for (const [key, value] of response.headers.entries()) {
      res.setHeader(key, value);
    }
    if (!response.body) {
      res.end();
      return;
    }

    const reader = response.body.getReader();
    // 客户端断开时取消上游读取，避免 goroutine/监听器泄漏
    res.on("close", () => {
      void reader.cancel().catch(() => {});
    });

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (res.writableEnded) break;
        res.write(Buffer.from(value));
      }
    } catch {
      // 客户端断开或上游取消，静默收尾
    } finally {
      if (!res.writableEnded) res.end();
    }
  });

  return app;
}

/**
 * 把事件对象断言为 AI SDK 的 JSONValue。
 *
 * ToolStreamEvent 只含标量字段，运行时天然满足 JSONValue；
 * 但 TypeScript 无法在 interface 无索引签名时自动确认，故集中在此断言，
 * 避免每处 writeData 都要写一遍。writeData 内部会做 JSON 序列化。
 */
function asJson(event: ToolStreamEvent): JSONValue {
  return event as unknown as JSONValue;
}

/** 从会话日志中取最后一条非空 assistant 文本。 */
function lastAssistantText(session: { deriveMessages(): Array<{ role: string; content?: string }> }): string {
  const messages = session.deriveMessages();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "assistant" && m.content && m.content.length > 0) return m.content;
  }
  return "";
}

/** 从多种请求体格式中提取用户文本（兼容 useChat 与手写 fetch）。 */
function extractUserMessage(body: unknown): string {
  if (!body || typeof body !== "object") return "";
  const record = body as Record<string, unknown>;

  // 手写格式：{ message: "..." }
  if (typeof record.message === "string") return record.message.trim();

  // useChat 格式：{ messages: [{ role, content, parts }] }
  const messages = record.messages;
  if (Array.isArray(messages)) {
    const last = messages.at(-1) as Record<string, unknown> | undefined;
    if (!last) return "";
    if (typeof last.content === "string") return last.content.trim();
    const parts = last.parts;
    if (Array.isArray(parts)) {
      const text = parts
        .map((p: unknown) => {
          if (!p || typeof p !== "object") return "";
          const part = p as { type?: string; text?: unknown };
          return part.type === "text" ? String(part.text ?? "") : "";
        })
        .join("")
        .trim();
      if (text.length > 0) return text;
    }
  }
  return "";
}

/**
 * 启动 HTTP 服务，返回退出码。
 * 服务会一直运行，直到收到 SIGINT/SIGTERM。
 */
export async function startServer(
  runtime: Runtime,
  options: ServerOptions = {},
): Promise<number> {
  const port = options.port ?? 3000;
  // 监听 0.0.0.0：允许局域网内其它设备（手机/平板）访问开发服务。
  // 仅本机使用时可用 HOST=127.0.0.1 收窄。
  const host = options.host ?? process.env.HOST ?? "0.0.0.0";

  const app = createApp(runtime);

  return new Promise<number>((resolve) => {
    const server = app.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;

      const isWildcard = host === "0.0.0.0" || host === "::";
      const shownHost = isWildcard ? "localhost" : host;

      console.log("");
      console.log(`  lish web 已启动`);
      console.log(`  本机访问:   http://${shownHost}:${actualPort}`);
      console.log(`  健康检查:   http://${shownHost}:${actualPort}/api/health`);
      console.log(`  模型:       ${runtime.config.model}`);
      if (!runtime.config.apiKey) {
        console.log("");
        console.log(
          "  ⚠️ 未检测到 API Key，请在浏览器界面的【设置】中配置",
        );
      }

      if (isWildcard) {
        const nets = networkInterfaces();
        const lanUrls: string[] = [];
        for (const [, addrs] of Object.entries(nets)) {
          for (const addr of addrs ?? []) {
            if (addr.family === "IPv4" && !addr.internal) {
              lanUrls.push(`http://${addr.address}:${actualPort}`);
            }
          }
        }
        if (lanUrls.length > 0) {
          console.log(`  局域网访问: ${lanUrls.join("  ")}`);
        }
      } else {
        console.log(`  监听地址:   ${host}:${actualPort}`);
      }

      const webRoot = resolveWebRoot();
      console.log(`  静态资源:   ${webRoot ?? "(未找到 web/dist，请先 npm run build)"}`);
      console.log("");
      console.log("  按 Ctrl+C 停止");
      console.log("");
    });

    server.on("error", (err) => {
      console.error(`服务启动失败：${err.message}`);
      resolve(1);
    });

    const shutdown = () => {
      console.log("\n正在关闭…");
      server.close(() => resolve(0));
      setTimeout(() => resolve(0), 10_000).unref();
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

// 直接运行（tsx src/server.ts）时自动启动
const entry = process.argv[1] ?? "";
if (/[\\/]server\.(ts|js)$/.test(entry)) {
  const { createRuntime, readConfig, UsageError } = await import("./runtime.js");
  try {
    const runtime = await createRuntime(readConfig());
    const port = Number(process.env.PORT ?? 3000);
    const code = await startServer(runtime, {
      port: Number.isInteger(port) ? port : 3000,
    });
    await runtime.shutdown();
    process.exitCode = code;
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`配置错误：${err.message}`);
      process.exitCode = 2;
    } else {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  }
}
