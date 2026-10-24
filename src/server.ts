/**
 * Web 服务（express）。
 *
 * 接口：
 *   POST /api/chat   接收用户消息，以 AI SDK 数据流协议流式返回
 *   GET  /api/health 健康检查
 *   GET  /           静态页面（旧版 public/index.html；新版前端见 web/）
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
import type { Runtime, LlmConfigPatch, PublicConfig } from "./runtime.js";
import { maskApiKey } from "./runtime.js";
import { readFileTree } from "./tools/file-tree.js";
import { runShell } from "./tools/shell.js";
import type { AppSettings } from "./core/settings.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * 定位前端构建产物目录（web/dist）。
 *
 * 需要兼容两种运行位置：
 *   - 源码运行（tsx src/server.ts）：<root>/src       -> <root>/web/out
 *   - 编译运行（dist/src/server.js）：<root>/dist/src -> <root>/web/out
 * 因此逐级上溯查找，而不是写死相对层级。
 *
 * 前端已迁移到 Next.js 静态导出，产物目录固定为 web/out。
 * 同时保留对旧目录 web/dist 的兼容，避免升级期的混乱。
 */
export function resolveWebRoot(startDir: string = here): string | null {
  let dir = startDir;
  for (let depth = 0; depth < 5; depth++) {
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

  // CORS：显式允许 Vite 开发服务器。
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
           <p>开发模式下请改用 <code>npm run start:dev</code>（前端由 Vite 提供）。</p>
           <p>接口健康检查：<a style="color:#7aa2ff" href="/api/health">/api/health</a></p>
           </body>`,
        );
    });
  }

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      model: runtime.config.model,
      workspace: runtime.config.workspaceRoot,
      sessions: runtime.sessions.size,
      tools: runtime.tools.list(),
    });
  });

  /**
   * 会话轨迹事件。
   *
   * 返回完整事件数组，每条包含 traceId、毫秒时间戳、真实耗时与 tokenUsage，
   * 供前端轨迹面板渲染时间轴、条形图与详情。
   */
  app.get("/api/session/:id/events", (req, res) => {
    const sessionId = String(req.params.id ?? "");
    if (!sessionId) {
      res.status(400).json({ ok: false, error: "缺少会话 id" });
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
  app.get("/api/plugins", (_req, res) => {
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
  app.get("/api/files", async (_req, res) => {
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
  app.get("/api/files/content", async (req, res) => {
    const rel = typeof req.query.path === "string" ? req.query.path : "";
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
  app.get("/api/config", (_req, res) => {
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
    res.json({ ...view, settings: runtime.getSettings() });
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
      runtime.updateLlmConfig(patch);
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
