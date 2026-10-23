/**
 * OpenAIProvider 离线测试（不联网）。
 *
 * 通过注入 fetchImpl 模拟 OpenAI 兼容接口的响应，验证：
 *   - 统一 Message <-> OpenAI messages 的双向翻译；
 *   - tool_calls（JSON 字符串形式）的解析与容错；
 *   - 请求体构造（model / tools / 参数）；
 *   - HTTP 错误与超时的封装。
 * 运行方式：npm run test:openai
 */

import assert from "node:assert/strict";

import type { Message, ToolSchema } from "../llm.js";
import {
  fromOpenAIResponse,
  fromOpenAIFinishReason,
  OpenAIProvider,
  OpenAIProviderError,
  parseOpenAIToolCalls,
  toOpenAIMessages,
  toOpenAITools,
} from "./openai.js";

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) =>
  tests.push([name, fn]);

/** 构造一个返回固定响应的假 fetch。 */
function fakeFetch(
  body: unknown,
  init: { status?: number; delayMs?: number } = {},
): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, options?: RequestInit) => {
    calls.push({ url: String(url), init: options ?? {} });
    if (init.delayMs) {
      // 真实 fetch 会响应 AbortSignal，测试替身也必须如此，
      // 否则超时逻辑根本无法被验证。
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, init.delayMs);
        const onAbort = () => {
          clearTimeout(timer);
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        };
        if (options?.signal?.aborted) {
          onAbort();
        } else {
          options?.signal?.addEventListener("abort", onAbort, { once: true });
        }
      });
    }
    const status = init.status ?? 200;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const okBody = {
  id: "chatcmpl-1",
  model: "gpt-4o-mini",
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: "已完成",
        tool_calls: [
          {
            id: "call_abc",
            type: "function" as const,
            function: { name: "fs.read", arguments: '{"path":"a.txt"}' },
          },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
  usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
};

// --- 消息转换：统一 -> OpenAI ---------------------------------------------

test("system / user 消息直接映射", () => {
  const out = toOpenAIMessages([
    { role: "system", content: "你是助手" },
    { role: "user", content: "你好" },
  ]);
  assert.deepEqual(out, [
    { role: "system", content: "你是助手" },
    { role: "user", content: "你好" },
  ]);
});

test("assistant 纯文本消息 content 原样保留", () => {
  const [out] = toOpenAIMessages([{ role: "assistant", content: "好的" }]);
  assert.deepEqual(out, { role: "assistant", content: "好的" });
});

test("assistant 仅含 tool_calls 时 content 必须为 null", () => {
  const [out] = toOpenAIMessages([
    {
      role: "assistant",
      toolCalls: [{ id: "c1", name: "echo", arguments: { text: "hi" } }],
    },
  ]) as Array<Record<string, unknown>>;

  assert.equal(out.role, "assistant");
  assert.equal(out.content, null);
  const toolCalls = out.tool_calls as Array<Record<string, unknown>>;
  assert.equal(toolCalls.length, 1);
  assert.deepEqual(toolCalls[0], {
    id: "c1",
    type: "function",
    // 参数必须序列化成 JSON 字符串
    function: { name: "echo", arguments: '{"text":"hi"}' },
  });
});

test("tool 消息映射为 tool_call_id 引用", () => {
  const [out] = toOpenAIMessages([
    {
      role: "tool",
      tool: { toolCallId: "c1", name: "echo", content: "pong" },
    },
  ]);
  assert.deepEqual(out, { role: "tool", content: "pong", tool_call_id: "c1" });
});

test("tool 消息缺少载荷时报错", () => {
  assert.throws(
    () => toOpenAIMessages([{ role: "tool" }]),
    OpenAIProviderError,
  );
});

test("完整多轮对话（含工具往返）转换后可无损还原语义", () => {
  const messages: Message[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "读 a.txt" },
    {
      role: "assistant",
      toolCalls: [{ id: "c1", name: "fs.read", arguments: { path: "a.txt" } }],
    },
    { role: "tool", tool: { toolCallId: "c1", name: "fs.read", content: "内容" } },
    { role: "assistant", content: "文件内容是：内容" },
  ];

  const out = toOpenAIMessages(messages) as Array<Record<string, unknown>>;
  assert.deepEqual(
    out.map((m) => m.role),
    ["system", "user", "assistant", "tool", "assistant"],
  );
  assert.equal(out[3]?.tool_call_id, "c1");
  assert.equal(out[3]?.content, "内容");
});

// --- tools schema 转换 ----------------------------------------------------

test("ToolSchema 转换为 OpenAI tools 数组", () => {
  const tools: ToolSchema[] = [
    { name: "fs.read", description: "读文件", parameters: { type: "object" } },
  ];
  assert.deepEqual(toOpenAITools(tools), [
    { type: "function", function: { name: "fs.read", description: "读文件", parameters: { type: "object" } } },
  ]);
});

test("空 tools 列表返回 undefined（不发送该字段）", () => {
  assert.equal(toOpenAITools([]), undefined);
  assert.equal(toOpenAITools(undefined), undefined);
});

// --- 响应解析：OpenAI -> 统一 ---------------------------------------------

test("解析带 tool_calls 的响应", () => {
  const result = fromOpenAIResponse(okBody, "openai");
  assert.equal(result.text, "已完成");
  assert.equal(result.finishReason, "tool_calls");
  assert.equal(result.provider, "openai");
  assert.deepEqual(result.toolCalls, [
    { id: "call_abc", name: "fs.read", arguments: { path: "a.txt" } },
  ]);
  assert.deepEqual(result.usage, { inputTokens: 12, outputTokens: 7 });
});

test("纯文本响应映射为 stop", () => {
  const result = fromOpenAIResponse(
    { choices: [{ message: { content: "只有文本" }, finish_reason: "stop" }] },
    "openai",
  );
  assert.equal(result.text, "只有文本");
  assert.equal(result.finishReason, "stop");
  assert.deepEqual(result.toolCalls, []);
});

test("finish_reason 映射表", () => {
  assert.equal(fromOpenAIFinishReason("stop"), "stop");
  assert.equal(fromOpenAIFinishReason("length"), "length");
  assert.equal(fromOpenAIFinishReason("tool_calls"), "tool_calls");
  assert.equal(fromOpenAIFinishReason("function_call"), "tool_calls");
  assert.equal(fromOpenAIFinishReason("content_filter"), "stop");
  assert.equal(fromOpenAIFinishReason(null), "stop");
  assert.equal(fromOpenAIFinishReason(undefined), "stop");
  assert.equal(fromOpenAIFinishReason("something_new"), "stop");
});

test("有 tool_calls 时即使 finish_reason 为 stop 也判为 tool_calls", () => {
  const result = fromOpenAIResponse(
    {
      choices: [
        {
          message: {
            content: "",
            tool_calls: [
              { id: "c9", type: "function", function: { name: "echo", arguments: "{}" } },
            ],
          },
          finish_reason: "stop",
        },
      ],
    },
    "openai",
  );
  assert.equal(result.finishReason, "tool_calls");
});

test("arguments 为非法 JSON 时不崩溃，保留原始串", () => {
  const calls = parseOpenAIToolCalls([
    { id: "c1", type: "function", function: { name: "echo", arguments: '{"path":' } },
  ]);
  assert.equal(calls[0]?.name, "echo");
  assert.equal(calls[0]?.arguments._parseError, true);
  assert.equal(calls[0]?.arguments._rawArguments, '{"path":');
});

test("arguments 为空字符串视为空对象", () => {
  const calls = parseOpenAIToolCalls([
    { id: "c1", type: "function", function: { name: "echo", arguments: "" } },
  ]);
  assert.deepEqual(calls[0]?.arguments, {});
});

test("arguments 为 JSON 数组时包装为 { value }", () => {
  const calls = parseOpenAIToolCalls([
    { id: "c1", type: "function", function: { name: "echo", arguments: "[1,2]" } },
  ]);
  assert.deepEqual(calls[0]?.arguments, { value: [1, 2] });
});

test("缺少 tool_calls 时返回空数组", () => {
  assert.deepEqual(parseOpenAIToolCalls(undefined), []);
  assert.deepEqual(parseOpenAIToolCalls([]), []);
});

test("响应没有 choices 时报错且标记可重试", () => {
  assert.throws(
    () => fromOpenAIResponse({}, "openai"),
    (err: unknown) => err instanceof OpenAIProviderError && err.retryable === true,
  );
});

// --- Provider 行为（注入 fetch）------------------------------------------

test("请求 URL、鉴权头与请求体正确", async () => {
  const { fetchImpl, calls } = fakeFetch(okBody);
  const provider = new OpenAIProvider({
    apiKey: "sk-test",
    baseURL: "https://api.deepseek.com/v1/",
    model: "deepseek-chat",
    fetchImpl,
  });

  await provider.generate([{ role: "user", content: "hi" }], {
    tools: [{ name: "fs.read", description: "读" }],
    temperature: 0.2,
    maxTokens: 100,
  });

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  // baseURL 末尾斜杠应被去掉
  assert.equal(call.url, "https://api.deepseek.com/v1/chat/completions");

  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers.authorization, "Bearer sk-test");
  assert.equal(headers["content-type"], "application/json");

  const body = JSON.parse(String(call.init.body));
  assert.equal(body.model, "deepseek-chat");
  assert.equal(body.temperature, 0.2);
  assert.equal(body.max_tokens, 100);
  assert.equal(body.tools[0].function.name, "fs.read");
  assert.deepEqual(body.messages, [{ role: "user", content: "hi" }]);
});

test("generate 返回统一结果", async () => {
  const { fetchImpl } = fakeFetch(okBody);
  const provider = new OpenAIProvider({ apiKey: "k", fetchImpl, model: "m1" });
  const result = await provider.generate([{ role: "user", content: "hi" }]);

  assert.equal(result.text, "已完成");
  assert.equal(result.toolCalls[0]?.name, "fs.read");
  assert.equal(result.finishReason, "tool_calls");
  assert.equal(result.provider, "openai");
});

test("options.model 覆盖构造时的默认模型", async () => {
  const { fetchImpl, calls } = fakeFetch(okBody);
  const provider = new OpenAIProvider({ apiKey: "k", fetchImpl, model: "default-model" });
  await provider.generate([{ role: "user", content: "hi" }], { model: "override" });
  const body = JSON.parse(String(calls[0]!.init.body));
  assert.equal(body.model, "override");
});

test("HTTP 401 抛出不可重试的错误", async () => {
  const { fetchImpl } = fakeFetch(
    { error: { message: "invalid api key" } },
    { status: 401 },
  );
  const provider = new OpenAIProvider({ apiKey: "bad", fetchImpl });

  await assert.rejects(
    () => provider.generate([{ role: "user", content: "hi" }]),
    (err: unknown) =>
      err instanceof OpenAIProviderError &&
      err.status === 401 &&
      err.retryable === false &&
      /invalid api key/.test(err.message),
  );
});

test("HTTP 429 与 5xx 标记为可重试", async () => {
  for (const status of [429, 500, 503]) {
    const { fetchImpl } = fakeFetch({ error: { message: "busy" } }, { status });
    const provider = new OpenAIProvider({ apiKey: "k", fetchImpl });
    await assert.rejects(
      () => provider.generate([{ role: "user", content: "hi" }]),
      (err: unknown) => err instanceof OpenAIProviderError && err.retryable === true,
    );
  }
});

test("非 JSON 响应被包装为错误", async () => {
  const { fetchImpl } = fakeFetch("<html>gateway error</html>", { status: 502 });
  const provider = new OpenAIProvider({ apiKey: "k", fetchImpl });
  await assert.rejects(
    () => provider.generate([{ role: "user", content: "hi" }]),
    (err: unknown) =>
      err instanceof OpenAIProviderError && /Malformed JSON/.test(err.message),
  );
});

test("超时被转换为可重试错误", async () => {
  const { fetchImpl } = fakeFetch(okBody, { delayMs: 50 });
  const provider = new OpenAIProvider({ apiKey: "k", fetchImpl, timeoutMs: 5 });
  await assert.rejects(
    () => provider.generate([{ role: "user", content: "hi" }]),
    (err: unknown) =>
      err instanceof OpenAIProviderError && err.retryable === true && /timed out/.test(err.message),
  );
});

test("构造时缺少 apiKey 直接报错", () => {
  assert.throws(() => new OpenAIProvider({ apiKey: "" }), OpenAIProviderError);
});

test("buildRequestBody 可单独断言（无需发请求）", () => {
  const provider = new OpenAIProvider({ apiKey: "k", model: "m" });
  const body = provider.buildRequestBody(
    [{ role: "user", content: "hi" }],
    { temperature: 1 },
  );
  assert.equal(body.model, "m");
  assert.equal(body.temperature, 1);
  assert.equal(body.tools, undefined); // 未传 tools 时不应出现该字段
});

// --- 与 Kernel 集成 -------------------------------------------------------

test("OpenAIProvider 可作为 LlmRuntime 的 Provider 挂载", async () => {
  const { Context } = await import("../../kernel/context.js");
  const { LlmRuntime } = await import("../llm.js");
  const { fetchImpl } = fakeFetch(okBody);

  const ctx = new Context();
  const provider = new OpenAIProvider({ apiKey: "k", fetchImpl });
  const llm = new LlmRuntime(ctx, { provider });

  const result = await llm.generate([{ role: "user", content: "hi" }]);
  assert.equal(result.toolCalls[0]?.name, "fs.read");
  assert.equal(llm.providerName, "openai");

  await ctx.dispose();
});

// --- 测试运行器 --------

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
      console.error(
        `    ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
      );
    }
  }

  console.log(`\n${passed}/${tests.length} tests passed`);
  if (failures.length > 0) {
    console.error(`Failed: ${failures.join(", ")}`);
    process.exitCode = 1;
  }
}

void main();
