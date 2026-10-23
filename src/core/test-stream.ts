/**
 * 流式事件与接口层测试（离线）。
 *
 * 覆盖：
 *   - AgentLoop 派发 agent:thinking / tool_call / tool_result / answer 的顺序与载荷；
 *   - OpenAIProvider 的 stream:true 解析（SSE 分片 + 工具调用碎片归并）；
 *   - Web 服务 POST /api/chat 的 SSE 输出格式与收尾事件。
 *
 * 全部使用 MockProvider / 假 fetch，不依赖网络。
 * 运行方式：npm run test:stream
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";

import { Context } from "../kernel/context.js";
import {
  AGENT_ANSWER,
  AGENT_STREAM_DELTA,
  AGENT_THINKING,
  AGENT_TOOL_CALL,
  AGENT_TOOL_RESULT,
  AgentLoop,
  type AgentAnswerPayload,
  type AgentThinkingPayload,
  type AgentToolCallPayload,
  type AgentToolResultPayload,
} from "./agent-loop.js";
import { LlmRuntime, MockProvider, type Message } from "./llm.js";
import { OpenAIProvider } from "./providers/openai.js";
import { SessionService } from "./sessions.js";
import { ToolRegistry } from "./tools.js";
import { createApp } from "../server.js";
import { createRuntime, type RuntimeConfig } from "../runtime.js";

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) =>
  tests.push([name, fn]);

/** 构造一个最小内核：MockProvider + echo 工具。 */
function makeLoop() {
  const ctx = new Context();
  const sessions = new SessionService(ctx);
  ctx.provide(SessionService.KEY, sessions);
  const llm = new LlmRuntime(ctx, { provider: new MockProvider() });
  ctx.provide(LlmRuntime.KEY, llm);
  const tools = new ToolRegistry(ctx);
  ctx.provide(ToolRegistry.KEY, tools);
  tools.register({ name: "echo", handler: (args) => String(args.text ?? "") });
  const agent = new AgentLoop(ctx, { maxSteps: 5 });
  ctx.provide(AgentLoop.KEY, agent);
  return { ctx, sessions, agent, tools, llm };
}

// --- AgentLoop 流式事件 ---------------------------------------------------

test("派发顺序：thinking -> tool_call -> tool_result -> ... -> answer", async () => {
  const { ctx, sessions, agent } = makeLoop();
  const order: string[] = [];

  ctx.on(AGENT_THINKING, () => void order.push("thinking"));
  ctx.on(AGENT_TOOL_CALL, () => void order.push("tool_call"));
  ctx.on(AGENT_TOOL_RESULT, () => void order.push("tool_result"));
  ctx.on(AGENT_ANSWER, () => void order.push("answer"));

  const session = sessions.create();
  await agent.run(session, "echo please");

  assert.deepEqual(order, [
    "thinking",     // 第 1 步
    "tool_call",
    "tool_result",
    "thinking",     // 第 2 步
    "answer",
  ]);

  await ctx.dispose();
});

test("thinking 事件在模型调用之前发出（前端可立即显示加载态）", async () => {
  const { ctx, sessions, agent } = makeLoop();
  const events: string[] = [];

  ctx.on(AGENT_THINKING, (p: AgentThinkingPayload) => {
    events.push(`thinking:${p.step}`);
  });
  ctx.on(AGENT_TOOL_CALL, () => void events.push("tool_call"));

  await agent.run(sessions.create(), "hi");
  assert.equal(events[0], "thinking:1", "第一个事件必须是 thinking");

  await ctx.dispose();
});

test("thinking 载荷包含 runId / sessionId / step / messageCount", async () => {
  const { ctx, sessions, agent } = makeLoop();
  const payloads: AgentThinkingPayload[] = [];
  ctx.on(AGENT_THINKING, (p: AgentThinkingPayload) => payloads.push(p));

  const session = sessions.create({ id: "sess-1" });
  const result = await agent.run(session, "hi");

  assert.ok(payloads.length >= 1);
  const first = payloads[0]!;
  assert.equal(first.sessionId, "sess-1");
  assert.equal(first.step, 1);
  assert.ok(first.runId.startsWith("run_"));
  assert.ok(first.messageCount >= 1, "上下文至少包含一条用户消息");
  // 同一轮 run 内 runId 保持一致
  assert.ok(payloads.every((p) => p.runId === first.runId));
  assert.equal(result.sessionId, "sess-1");

  await ctx.dispose();
});

test("tool_call 载荷包含 name / args / callId", async () => {
  const { ctx, sessions, agent } = makeLoop();
  const calls: AgentToolCallPayload[] = [];
  ctx.on(AGENT_TOOL_CALL, (p: AgentToolCallPayload) => calls.push(p));

  await agent.run(sessions.create(), "go");

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.name, "echo");
  assert.equal(calls[0]?.step, 1);
  assert.ok(calls[0]?.callId);
  assert.deepEqual(calls[0]?.args, { text: "hello from mock" });

  await ctx.dispose();
});

test("tool_result 载荷包含内容、错误标记与耗时", async () => {
  const { ctx, sessions, agent } = makeLoop();
  const results: AgentToolResultPayload[] = [];
  ctx.on(AGENT_TOOL_RESULT, (p: AgentToolResultPayload) => results.push(p));

  await agent.run(sessions.create(), "go");

  assert.equal(results.length, 1);
  const r = results[0]!;
  assert.equal(r.name, "echo");
  assert.equal(r.content, "hello from mock");
  assert.equal(r.isError, false);
  assert.equal(typeof r.durationMs, "number");
  assert.ok(r.durationMs >= 0);

  await ctx.dispose();
});

test("tool_call 与 tool_result 的 callId 可以配对", async () => {
  const { ctx, sessions, agent } = makeLoop();
  const callIds: string[] = [];
  const resultIds: string[] = [];
  ctx.on(AGENT_TOOL_CALL, (p: AgentToolCallPayload) => callIds.push(p.callId));
  ctx.on(AGENT_TOOL_RESULT, (p: AgentToolResultPayload) => resultIds.push(p.callId));

  await agent.run(sessions.create(), "go");
  assert.deepEqual(resultIds, callIds);

  await ctx.dispose();
});

test("answer 事件携带最终文本与结束原因", async () => {
  const { ctx, sessions, agent } = makeLoop();
  let answer: AgentAnswerPayload | undefined;
  ctx.on(AGENT_ANSWER, (p: AgentAnswerPayload) => (answer = p));

  await agent.run(sessions.create(), "go");

  assert.ok(answer);
  assert.equal(answer!.stopReason, "stop");
  assert.match(answer!.text, /Summary of tool results/);

  await ctx.dispose();
});

test("即使出错，answer 事件仍会发出（前端不会一直转圈）", async () => {
  const ctx = new Context();
  const sessions = new SessionService(ctx);
  ctx.provide(SessionService.KEY, sessions);
  const llm = new LlmRuntime(ctx, {
    provider: {
      name: "broken",
      generate: async () => {
        throw new Error("upstream down");
      },
    },
  });
  ctx.provide(LlmRuntime.KEY, llm);
  const tools = new ToolRegistry(ctx);
  ctx.provide(ToolRegistry.KEY, tools);
  const agent = new AgentLoop(ctx, { maxSteps: 3 });
  ctx.provide(AgentLoop.KEY, agent);

  let answer: AgentAnswerPayload | undefined;
  ctx.on(AGENT_ANSWER, (p: AgentAnswerPayload) => (answer = p));

  const result = await agent.run(sessions.create(), "hi");
  assert.equal(result.stopReason, "error");
  assert.ok(answer, "出错时也必须发出 answer");
  assert.equal(answer!.stopReason, "error");

  await ctx.dispose();
});

test("没有工具调用时只有 thinking + answer", async () => {
  const ctx = new Context();
  const sessions = new SessionService(ctx);
  ctx.provide(SessionService.KEY, sessions);
  const llm = new LlmRuntime(ctx, {
    provider: {
      name: "plain",
      generate: async () => ({
        text: "直接回答",
        toolCalls: [],
        finishReason: "stop" as const,
        provider: "plain",
      }),
    },
  });
  ctx.provide(LlmRuntime.KEY, llm);
  const tools = new ToolRegistry(ctx);
  ctx.provide(ToolRegistry.KEY, tools);
  const agent = new AgentLoop(ctx, {});
  ctx.provide(AgentLoop.KEY, agent);

  const order: string[] = [];
  ctx.on(AGENT_THINKING, () => void order.push("thinking"));
  ctx.on(AGENT_TOOL_CALL, () => void order.push("tool_call"));
  ctx.on(AGENT_ANSWER, () => void order.push("answer"));

  await agent.run(sessions.create(), "hi");
  assert.deepEqual(order, ["thinking", "answer"]);

  await ctx.dispose();
});

// --- OpenAIProvider 流式解析 ---------------------------------------------

/** 构造一个按 SSE 格式返回的假 fetch。 */
function sseFetch(chunks: string[]): { fetchImpl: typeof fetch } {
  const fetchImpl = (async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl };
}

const sseLine = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;

test("stream:true 聚合并返回完整文本", async () => {
  const { fetchImpl } = sseFetch([
    sseLine({ choices: [{ delta: { content: "你" } }] }),
    sseLine({ choices: [{ delta: { content: "好" } }] }),
    sseLine({ choices: [{ delta: {}, finish_reason: "stop" }] }),
    "data: [DONE]\n\n",
  ]);

  const provider = new OpenAIProvider({ apiKey: "k", fetchImpl, stream: true });
  const result = await provider.generate([{ role: "user", content: "hi" }]);

  assert.equal(result.text, "你好");
  assert.equal(result.finishReason, "stop");
  assert.deepEqual(result.toolCalls, []);
});

test("stream:true 触发 onTextDelta 增量回调", async () => {
  const { fetchImpl } = sseFetch([
    sseLine({ choices: [{ delta: { content: "A" } }] }),
    sseLine({ choices: [{ delta: { content: "B" } }] }),
    "data: [DONE]\n\n",
  ]);

  const deltas: string[] = [];
  const provider = new OpenAIProvider({
    apiKey: "k",
    fetchImpl,
    stream: true,
    onTextDelta: (d) => deltas.push(d),
  });
  await provider.generate([{ role: "user", content: "hi" }]);

  assert.deepEqual(deltas, ["A", "B"]);
});

test("stream:true 正确归并碎片化的工具调用参数", async () => {
  const { fetchImpl } = sseFetch([
    sseLine({
      choices: [
        { delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "fs.read", arguments: '{"pa' } }] } },
      ],
    }),
    sseLine({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } }],
    }),
    sseLine({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    "data: [DONE]\n\n",
  ]);

  const provider = new OpenAIProvider({ apiKey: "k", fetchImpl, stream: true });
  const result = await provider.generate([{ role: "user", content: "read" }]);

  assert.equal(result.finishReason, "tool_calls");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0]?.id, "call_1");
  assert.equal(result.toolCalls[0]?.name, "fs.read");
  assert.deepEqual(result.toolCalls[0]?.arguments, { path: "a.txt" });
});

test("stream:true 支持多个并行工具调用", async () => {
  const { fetchImpl } = sseFetch([
    sseLine({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "c0", function: { name: "echo", arguments: '{}' } },
              { index: 1, id: "c1", function: { name: "fs.read", arguments: '{"path":"x"}' } },
            ],
          },
        },
      ],
    }),
    "data: [DONE]\n\n",
  ]);

  const provider = new OpenAIProvider({ apiKey: "k", fetchImpl, stream: true });
  const result = await provider.generate([]);
  assert.deepEqual(
    result.toolCalls.map((c) => c.name),
    ["echo", "fs.read"],
  );
});

test("stream:true 解析 usage 与 finish_reason", async () => {
  const { fetchImpl } = sseFetch([
    sseLine({ choices: [{ delta: { content: "x" } }] }),
    sseLine({
      choices: [{ delta: {}, finish_reason: "length" }],
      usage: { prompt_tokens: 5, completion_tokens: 9 },
    }),
    "data: [DONE]\n\n",
  ]);

  const provider = new OpenAIProvider({ apiKey: "k", fetchImpl, stream: true });
  const result = await provider.generate([]);
  assert.equal(result.finishReason, "length");
  assert.deepEqual(result.usage, { inputTokens: 5, outputTokens: 9 });
});

test("流式请求体包含 stream: true", async () => {
  let captured: Record<string, unknown> = {};
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    captured = JSON.parse(String(init.body));
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;

  const provider = new OpenAIProvider({ apiKey: "k", fetchImpl, stream: true });
  await provider.generate([{ role: "user", content: "hi" }]);
  assert.equal(captured.stream, true);
});

test("流式请求失败时自动回退为非流式", async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    if (calls === 1) {
      // 第一次：模拟不支持流式的服务端（返回 400）
      return new Response("stream not supported", { status: 400 });
    }
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "回退成功" }, finish_reason: "stop" }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;

  const provider = new OpenAIProvider({ apiKey: "k", fetchImpl, stream: true });
  const result = await provider.generate([{ role: "user", content: "hi" }]);

  assert.equal(calls, 2, "应当发起第二次（非流式）请求");
  assert.equal(result.text, "回退成功");
});

// --- Web 服务 SSE --------------------------------------------------------

/** 用 mock provider 构造一个可测试的 runtime。 */
function makeRuntime(): RuntimeConfig {
  return {
    apiKey: "test",
    baseURL: "http://localhost",
    model: "mock-model",
    maxSteps: 4,
    workspaceRoot: process.cwd(),
    sessionDir: null,
    provider: new MockProvider(),
  };
}

/** 装配 runtime 并注册 echo 工具（MockProvider 默认调用它）。 */
function makeWebRuntime() {
  const runtime = createRuntime(makeRuntime());
  runtime.tools.register({ name: "echo", handler: (args: Record<string, unknown>) => String(args.text ?? "") });
  return runtime;
}

/** 解析 AI SDK 数据流协议：`0:` 文本帧、`2:` 数据帧、`d:` 结束帧。 */
function parseAiSdkStream(raw: string): {
  texts: string[];
  data: any[];
  finished: boolean;
} {
  const texts: string[] = [];
  const data: any[] = [];
  let finished = false;

  for (const line of raw.split("\n")) {
    if (line.startsWith("0:")) {
      try {
        texts.push(JSON.parse(line.slice(2)));
      } catch {
        texts.push(line.slice(2));
      }
    } else if (line.startsWith("2:")) {
      try {
        const parts = JSON.parse(line.slice(2));
        for (const part of Array.isArray(parts) ? parts : [parts]) data.push(part);
      } catch {
        /* 忽略非法帧 */
      }
    } else if (line.startsWith("d:")) {
      finished = true;
    }
  }
  return { texts, data, finished };
}

test("POST /api/chat 返回 AI SDK 数据流，含工具事件与最终文本", async () => {
  const runtime = makeWebRuntime();
  const app = createApp(runtime);
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // useChat 发送的格式
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });

    assert.equal(res.status, 200);

    const { texts, data, finished } = parseAiSdkStream(await res.text());
    const types = data.map((d) => d.type);

    assert.ok(types.includes("session"), "必须下发 session");
    assert.ok(types.includes("thinking"), "必须下发 thinking");
    assert.ok(types.includes("tool_call"), "必须下发 tool_call");
    assert.ok(types.includes("tool_result"), "必须下发 tool_result");
    assert.equal(types.at(-1), "done", "done 必须最后");

    const call = data.find((d) => d.type === "tool_call");
    assert.equal(call.name, "echo");
    assert.equal(typeof call.argsJson, "string", "args 以 JSON 字符串传输");
    assert.deepEqual(JSON.parse(call.argsJson), { text: "hello from mock" });

    const toolResult = data.find((d) => d.type === "tool_result");
    assert.equal(toolResult.content, "hello from mock");
    assert.equal(toolResult.isError, false);

    assert.ok(texts.join("").includes("Summary of tool results"), "必须包含最终文本");
    // 关键：文本必须以**多个** `0:` 帧增量送达，而不是一个整段帧。
    // 这是打字机效果的数据前提（本测试跑的是 MockProvider 的 50ms 分块流）。
    assert.ok(texts.length > 1, `文本应为多帧增量，实际 ${texts.length} 帧`);
    assert.ok(
      texts.length > 5,
      `帧数偏少（${texts.length}），可能退回一次性推送`,
    );
    // AI SDK v4 不发送 v3 时代的 `d:` 结束帧；连接关闭即流结束，
    // 前端 useChat 通过 reader 收到 done 判定完成。
    void finished;

    const done = data.find((d) => d.type === "done");
    assert.equal(done.stopReason, "stop");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await runtime.shutdown();
  }
});

test("兼容手写的 { message } 请求格式", async () => {
  const runtime = makeWebRuntime();
  const app = createApp(runtime);
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
    });
    assert.equal(res.status, 200);
    const { texts } = parseAiSdkStream(await res.text());
    assert.ok(texts.length > 0);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await runtime.shutdown();
  }
});

test("POST /api/chat 空消息返回 400", async () => {
  const runtime = createRuntime(makeRuntime());
  const app = createApp(runtime);
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "   " }),
    });
    assert.equal(res.status, 400);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await runtime.shutdown();
  }
});

test("GET /api/health 返回模型与工具信息", async () => {
  const runtime = createRuntime(makeRuntime());
  const app = createApp(runtime);
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;

  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.model, "mock-model");
    assert.ok(body.tools.includes("fs.read"));
    assert.ok(body.tools.includes("fs.write"));
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await runtime.shutdown();
  }
});

test("多轮对话：复用同一 sessionId 可延续上下文", async () => {
  const runtime = makeWebRuntime();
  const app = createApp(runtime);
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;

  try {
    const first = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "第一轮" }),
    });
    const firstParsed = parseAiSdkStream(await first.text());
    const sessionId = firstParsed.data.find((d) => d.type === "session")?.sessionId as string;
    assert.ok(sessionId, "第一轮必须返回 sessionId");

    const second = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "第二轮", sessionId }),
    });
    const secondParsed = parseAiSdkStream(await second.text());
    const secondSession = secondParsed.data.find((d) => d.type === "session")?.sessionId;

    assert.equal(secondSession, sessionId, "第二轮必须复用同一会话");
    // 第二轮上下文应包含第一轮留下的消息
    const session = runtime.sessions.get(sessionId);
    assert.ok(session && session.deriveMessages().length > 3, "上下文应累积");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await runtime.shutdown();
  }
});

test("客户端断开后不留事件监听器（无内存泄漏）", async () => {
  const runtime = createRuntime(makeRuntime());
  const app = createApp(runtime);
  const server = app.listen(0);
  const port = (server.address() as { port: number }).port;

  try {
    const before = runtime.ctx.events.listenerCount(AGENT_THINKING);

    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "hi" }),
      signal: controller.signal,
    });
    // 读取一点内容后立即中止
    const reader = res.body!.getReader();
    await reader.read();
    controller.abort();
    try {
      await reader.cancel();
    } catch {
      /* 忽略 */
    }

    // 给服务端一点时间清理
    await new Promise((r) => setTimeout(r, 300));

    const after = runtime.ctx.events.listenerCount(AGENT_THINKING);
    assert.equal(after, before, "断开的请求不应残留监听器");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await runtime.shutdown();
  }
});

// --- Token 级真流式 -------------------------------------------------------

test("AgentLoop 派发 agent:stream_delta 增量事件", async () => {
  const ctx = new Context();
  const sessions = new SessionService(ctx);
  ctx.provide(SessionService.KEY, sessions);
  const llm = new LlmRuntime(ctx, { provider: new MockProvider() });
  ctx.provide(LlmRuntime.KEY, llm);
  const tools = new ToolRegistry(ctx);
  ctx.provide(ToolRegistry.KEY, tools);
  tools.register({ name: "echo", handler: (a) => String(a.text ?? "") });
  const agent = new AgentLoop(ctx, { maxSteps: 4 });
  ctx.provide(AgentLoop.KEY, agent);

  const deltas: string[] = [];
  ctx.on(AGENT_STREAM_DELTA, (p: { delta: string }) => deltas.push(p.delta));

  await agent.run(sessions.create(), "hi");

  assert.ok(deltas.length > 1, `应收到多个增量，实际 ${deltas.length}`);
  const joined = deltas.join("");
  assert.match(joined, /Summary of tool results/);
  assert.equal(joined, deltas.reduce((a, b) => a + b, ""));

  await ctx.dispose();
});

test("增量事件确实发生在 generate 返回之前（真流式而非一次性）", async () => {
  const ctx = new Context();
  const sessions = new SessionService(ctx);
  ctx.provide(SessionService.KEY, sessions);

  // 可控 Provider：手动控制何时吐增量、何时返回
  const llm = new LlmRuntime(ctx, {
    provider: {
      name: "controlled",
      async generate(_m, options) {
        options.onTextDelta?.("第一段");
        await new Promise((r) => setTimeout(r, 30));
        options.onTextDelta?.("第二段");
        return {
          text: "第一段第二段",
          toolCalls: [],
          finishReason: "stop" as const,
          provider: "controlled",
        };
      },
    },
  });
  ctx.provide(LlmRuntime.KEY, llm);
  const tools = new ToolRegistry(ctx);
  ctx.provide(ToolRegistry.KEY, tools);
  const agent = new AgentLoop(ctx, {});
  ctx.provide(AgentLoop.KEY, agent);

  const timeline: string[] = [];
  ctx.on(AGENT_STREAM_DELTA, (p: { delta: string }) => timeline.push(`delta:${p.delta}`));
  ctx.on(AGENT_ANSWER, () => timeline.push("answer"));

  await agent.run(sessions.create(), "hi");

  // 两个增量必须都排在 answer 之前
  assert.deepEqual(timeline, ["delta:第一段", "delta:第二段", "answer"]);

  await ctx.dispose();
});

test("MockProvider 支持 onTextDelta，并按块吐出", async () => {
  const provider = new MockProvider({ chunkSize: 2, chunkDelayMs: 5 });
  const deltas: string[] = [];
  const result = await provider.generate(
    [
      { role: "user", content: "hi" },
      { role: "tool", tool: { toolCallId: "c1", name: "echo", content: "pong" } },
    ],
    { onTextDelta: (d) => deltas.push(d) },
  );

  assert.ok(deltas.length > 1, `应分多块吐出，实际 ${deltas.length}`);
  assert.ok(deltas.every((d) => d.length <= 2), "每块不应超过 chunkSize");
  assert.equal(deltas.join(""), result.text);
});

test("OpenAIProvider 优先使用本次调用传入的 onTextDelta", async () => {
  const sse = (obj: unknown) => `data: ${JSON.stringify(obj)}\n\n`;
  const fetchImpl = (async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        c.enqueue(enc.encode(sse({ choices: [{ delta: { content: "A" } }] })));
        c.enqueue(enc.encode(sse({ choices: [{ delta: { content: "B" } }] })));
        c.enqueue(enc.encode("data: [DONE]\n\n"));
        c.close();
      },
    });
    return new Response(body, { status: 200 });
  }) as unknown as typeof fetch;

  const perCall: string[] = [];
  const provider = new OpenAIProvider({ apiKey: "k", fetchImpl });
  // 不设 stream:true，仅靠传入 onTextDelta 也应触发流式
  const result = await provider.generate([{ role: "user", content: "hi" }], {
    onTextDelta: (d) => perCall.push(d),
  });

  assert.deepEqual(perCall, ["A", "B"]);
  assert.equal(result.text, "AB");
});

// --- Runner ---------------------------------------------------------------

async function main(): Promise<void> {
  let passed = 0;
  const failures: string[] = [];

  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failures.push(name);
      console.error(`  ✗ ${name}`);
      console.error(`    ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
  }

  console.log(`\n${passed}/${tests.length} tests passed`);
  if (failures.length > 0) {
    console.error(`Failed: ${failures.join(", ")}`);
    process.exitCode = 1;
  }
}

void main();
