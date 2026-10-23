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
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import cors from "cors";
import express, { type Request, type Response } from "express";
import { createDataStreamResponse, type JSONValue } from "ai";

import {
  AGENT_ABORTED,
  AGENT_ANSWER,
  AGENT_THINKING,
  AGENT_TOOL_CALL,
  AGENT_TOOL_RESULT,
} from "./core/agent-loop.js";
import type { Runtime } from "./runtime.js";

const here = dirname(fileURLToPath(import.meta.url));
// 前端构建产物：`npm run build:web` 会输出到 web/dist。
// 开发期由 Vite dev server（5173）提供页面，这里的静态目录只用于生产单进程部署。
const publicDir = join(here, "..", "web", "dist");

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

/** 创建 express 应用（不监听端口，便于测试）。 */
export function createApp(runtime: Runtime): express.Express {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "1mb" }));

  if (existsSync(publicDir)) {
    app.use(express.static(publicDir));
  } else {
    // 开发期常见：尚未构建前端。给出可操作的指引而不是 404 空白页。
    app.get("/", (_req, res) => {
      res
        .status(200)
        .type("text/html; charset=utf-8")
        .send(
          `<meta charset="utf-8"><body style="font-family:system-ui;background:#0b0d12;color:#e6e8ee;padding:40px">
           <h2>前端尚未构建</h2>
           <p>开发模式请访问 Vite 服务器：<a style="color:#7aa2ff" href="http://localhost:5173">http://localhost:5173</a></p>
           <p>或执行 <code>npm run build:web</code> 生成 <code>web/dist</code> 后由本服务托管。</p>
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
        const handlers: Array<[string, (payload: any) => void]> = [];

        const cleanup = () => {
          for (const [name, handler] of handlers) runtime.ctx.off(name, handler);
          handlers.length = 0;
        };

        // 只转发本次 run 的事件，避免并发请求串台
        const track = (name: string, build: (payload: any) => ToolStreamEvent | null) => {
          const handler = (payload: any) => {
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

        track(AGENT_THINKING, (p) => ({
          type: "thinking",
          runId: p.runId,
          step: p.step,
          messageCount: p.messageCount,
        }));

        track(AGENT_TOOL_CALL, (p) => ({
          type: "tool_call",
          runId: p.runId,
          step: p.step,
          callId: p.callId,
          name: p.name,
          // 索引签名只允许标量，参数以 JSON 字符串传递，前端解析后渲染
          argsJson: JSON.stringify(p.args ?? {}),
        }));

        track(AGENT_TOOL_RESULT, (p) => ({
          type: "tool_result",
          runId: p.runId,
          step: p.step,
          callId: p.callId,
          name: p.name,
          content: p.content,
          isError: p.isError,
          durationMs: p.durationMs,
        }));

        track(AGENT_ABORTED, (p) => ({
          type: "aborted",
          runId: p.runId,
          stopReason: p.stopReason,
          error: p.error,
        }));

        try {
          const result = await runtime.agent.run(session, message);

          // 正文文本：AgentLoop 是「跑完再返回」的，因此这里一次性写入最终回答。
          // 工具调用过程已通过上面的 data 帧实时送达前端。
          const finalText =
            result.text && result.text.length > 0
              ? result.text
              : lastAssistantText(session);
          if (finalText.length > 0) {
            writer.write(`0:${JSON.stringify(finalText)}\n`);
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
        .map((p: any) => (p?.type === "text" ? String(p.text ?? "") : ""))
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
  const host = options.host ?? "127.0.0.1";

  const app = createApp(runtime);

  return new Promise<number>((resolve) => {
    const server = app.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      console.log(`lish web 后端已启动：http://${host}:${actualPort}`);
      console.log(`  模型：${runtime.config.model}`);
      console.log(`  工作区：${runtime.config.workspaceRoot}`);
      console.log("  前端开发服务器：http://localhost:5173");
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
    const runtime = createRuntime(readConfig());
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
