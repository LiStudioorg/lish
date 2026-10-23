/**
 * M1 测试：会话事件日志（只追加 JSONL + 折叠投影）与 LLM 接缝
 * （MockProvider、LlmRuntime、Provider 热切换）。
 * 运行方式：npm run test:core
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "../kernel/context.js";
import { loadPlugin } from "../kernel/plugin.js";
import { Session } from "./session.js";
import {
  assistantMessageFrom,
  LlmRuntime,
  MockProvider,
  NoProviderError,
  toolResultMessage,
  type GenerateOptions,
  type GenerateResult,
  type LlmProvider,
  type Message,
} from "./llm.js";

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) =>
  tests.push([name, fn]);

const tmp = () => mkdtemp(join(tmpdir(), "lish-m1-"));

// --- Session：只追加日志 --------

test("append stamps seq and ts, and keeps insertion order", () => {
  let clock = 1000;
  const session = new Session({ id: "s1", now: () => clock++ });
  session.appendUserMessage("hi");
  session.appendUserMessage("there");

  assert.equal(session.length, 3); // session.created + 2 messages
  assert.deepEqual(
    session.log.map((e) => e.seq),
    [0, 1, 2],
  );
  assert.deepEqual(
    session.log.map((e) => e.ts),
    [1000, 1001, 1002],
  );
});

test("append records a session.created event by default", () => {
  const session = new Session({ id: "abc", title: "T" });
  const first = session.log[0];
  assert.equal(first?.type, "session.created");
  assert.equal(first?.sessionId, "abc");
  assert.equal(first?.title, "T");
});

test("append refuses events without a type", () => {
  const session = new Session();
  assert.throws(
    () => session.append({} as { type: string }),
    /non-empty `type`/,
  );
});

test("append returns the stored event with seq/ts", () => {
  const session = new Session({ now: () => 42 });
  const stored = session.append({ type: "custom.thing", payload: 1 });
  assert.equal(stored.seq, 1);
  assert.equal(stored.ts, 42);
  assert.equal(stored.type, "custom.thing");
});

test("caller-supplied seq/ts are overwritten by the session", () => {
  const session = new Session({ now: () => 7 });
  const stored = session.append({ type: "x", seq: 999, ts: 999 });
  assert.equal(stored.seq, 1);
  assert.equal(stored.ts, 7);
});

// --- Session：deriveMessages 投影 --------

test("deriveMessages projects user/assistant/tool events", () => {
  const session = new Session({ id: "s", emitCreated: false });
  session.appendSystemMessage("you are helpful");
  session.appendUserMessage("ping");

  const call = { id: "c1", name: "echo", arguments: { text: "ping" } };
  session.appendAssistantMessage(undefined, [call]);
  session.appendToolResult({ toolCallId: "c1", name: "echo", content: "ping" });

  const messages = session.deriveMessages();
  assert.equal(messages.length, 4);
  assert.deepEqual(messages[0], { role: "system", content: "you are helpful" });
  assert.deepEqual(messages[1], { role: "user", content: "ping" });
  assert.equal(messages[2]?.role, "assistant");
  assert.deepEqual(messages[2]?.toolCalls, [call]);
  assert.equal(messages[2]?.content, undefined);
  assert.deepEqual(messages[3], {
    role: "tool",
    tool: { toolCallId: "c1", name: "echo", content: "ping" },
  });
});

test("deriveMessages ignores non-message events", () => {
  const session = new Session({ id: "s" }); // emits session.created
  session.appendUserMessage("a");
  session.append({ type: "llm.provider-changed", provider: "mock" });
  session.append({ type: "custom.metric", value: 1 });
  session.appendUserMessage("b");

  const messages = session.deriveMessages();
  assert.deepEqual(
    messages.map((m) => m.content),
    ["a", "b"],
  );
});

test("deriveMessages keeps assistant text alongside tool calls", () => {
  const session = new Session({ emitCreated: false });
  session.appendAssistantMessage("let me check", [
    { id: "c1", name: "echo", arguments: {} },
  ]);
  const [message] = session.deriveMessages();
  assert.equal(message?.content, "let me check");
  assert.equal(message?.toolCalls?.length, 1);
});

test("deriveMessages is recomputed from the log, not cached", () => {
  const session = new Session({ emitCreated: false });
  assert.equal(session.deriveMessages().length, 0);
  session.appendUserMessage("new turn");
  assert.equal(session.deriveMessages().length, 1);
});

test("deriveMessages returns a fresh array each call (no shared state)", () => {
  const session = new Session({ emitCreated: false });
  session.appendUserMessage("a");
  const first = session.deriveMessages();
  first.push({ role: "user", content: "injected" });
  assert.equal(session.deriveMessages().length, 1);
});

// --- Session：JSONL 持久化 --------

test("toJSONL emits one JSON object per line", () => {
  const session = new Session({ id: "s", emitCreated: false });
  session.appendUserMessage("line one");
  session.appendUserMessage("line two");

  const lines = session.toJSONL().trimEnd().split("\n");
  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.doesNotThrow(() => JSON.parse(line));
  }
  assert.equal(JSON.parse(lines[0] as string).content, "line one");
});

test("appends are mirrored to the JSONL file", async () => {
  const dir = await tmp();
  const file = join(dir, "session.jsonl");
  const session = new Session({ id: "s", file, emitCreated: false });

  session.appendUserMessage("persisted");
  await session.flush();

  const raw = await readFile(file, "utf8");
  assert.equal(raw.trim().split("\n").length, 1);
  assert.equal(JSON.parse(raw.trim()).content, "persisted");
});

test("many concurrent appends keep the file line-ordered", async () => {
  const dir = await tmp();
  const file = join(dir, "many.jsonl");
  const session = new Session({ file, emitCreated: false });

  for (let i = 0; i < 50; i++) session.appendUserMessage(`m${i}`);
  await session.flush();

  const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
  assert.equal(lines.length, 50);
  const seqs = lines.map((l) => JSON.parse(l).seq);
  assert.deepEqual(seqs, Array.from({ length: 50 }, (_, i) => i));
});

test("Session.load round-trips the log and continues the sequence", async () => {
  const dir = await tmp();
  const file = join(dir, "rt.jsonl");

  const original = new Session({ id: "orig", title: "Round trip", file });
  original.appendUserMessage("first");
  await original.flush();

  const loaded = await Session.load(file);
  assert.equal(loaded.id, "orig");
  assert.equal(loaded.length, original.length);
  assert.deepEqual(loaded.toJSONL(), original.toJSONL());

  const next = loaded.appendUserMessage("second");
  assert.equal(next.seq, original.length); // continues, no duplicate seq
});

test("Session.load tolerates a torn trailing line", async () => {
  const dir = await tmp();
  const file = join(dir, "torn.jsonl");
  const session = new Session({ file, emitCreated: false });
  session.appendUserMessage("complete");
  await session.flush();

  // 模拟写入过程中崩溃：一段没有换行符的残缺 JSON 片段。
  const { appendFile } = await import("node:fs/promises");
  await appendFile(file, '{"type":"message.user","content":"part', "utf8");

  const loaded = await Session.load(file);
  assert.equal(loaded.length, 1);
  assert.equal(loaded.deriveMessages()[0]?.content, "complete");
});

// --- Context：把会话作为服务 --------

test("a session can be provided to the kernel", async () => {
  const ctx = new Context();
  const session = new Session({ emitCreated: false });
  ctx.provide("session", session);
  ctx.on("message.user", (content: string) => session.appendUserMessage(content));

  ctx.emit("message.user", "via bus");
  assert.equal(session.deriveMessages()[0]?.content, "via bus");

  await ctx.dispose();
});

// --- MockProvider 模拟 Provider ---

test("MockProvider requests a tool call when there are no tool results", async () => {
  const provider = new MockProvider();
  const result = await provider.generate([{ role: "user", content: "hi" }]);

  assert.equal(result.finishReason, "tool_calls");
  assert.equal(result.toolCalls.length, 1);
  assert.equal(result.toolCalls[0]?.name, "echo");
  assert.equal(result.toolCalls[0]?.id, "call_mock_1");
  assert.equal(result.provider, "mock");
});

test("MockProvider summarises once tool results are present", async () => {
  const provider = new MockProvider();
  const history: Message[] = [
    { role: "user", content: "hi" },
    { role: "assistant", toolCalls: [{ id: "c1", name: "echo", arguments: {} }] },
    toolResultMessage({ id: "c1", name: "echo", arguments: {} }, "pong"),
  ];

  const result = await provider.generate(history);
  assert.equal(result.finishReason, "stop");
  assert.equal(result.toolCalls.length, 0);
  assert.match(result.text, /Summary of tool results \(1\)/);
  assert.match(result.text, /echo: pong/);
});

test("MockProvider is deterministic and counts calls", async () => {
  const provider = new MockProvider();
  assert.equal(provider.callCount, 0);
  const a = await provider.generate([]);
  const b = await provider.generate([]);
  assert.equal(provider.callCount, 2);
  assert.notEqual(a.toolCalls[0]?.id, b.toolCalls[0]?.id); // unique ids
});

test("MockProvider honours custom tool configuration", async () => {
  const provider = new MockProvider({
    toolName: "read_file",
    toolArguments: { path: "/etc/hosts" },
    summaryPrefix: "Done",
  });
  const result = await provider.generate([]);
  assert.equal(result.toolCalls[0]?.name, "read_file");
  assert.deepEqual(result.toolCalls[0]?.arguments, { path: "/etc/hosts" });
});

// --- LlmRuntime 运行时 ---

test("LlmRuntime mounts as ctx.llm via the plugin loader", async () => {
  const ctx = new Context();
  await loadPlugin(ctx, {
    name: "llm-runtime",
    apply(c) {
      c.provide(LlmRuntime.KEY, new LlmRuntime(c, { provider: new MockProvider() }));
    },
  });

  const llm = ctx.resolve<LlmRuntime>("llm");
  assert.ok(llm instanceof LlmRuntime);
  assert.equal(llm.providerName, "mock");
  await ctx.dispose();
});

test("ctx.llm.generate produces a response through MockProvider", async () => {
  const ctx = new Context();
  const llm = new LlmRuntime(ctx, { provider: new MockProvider() });

  const result = await llm.generate([{ role: "user", content: "hello" }]);
  assert.equal(result.finishReason, "tool_calls");
  assert.equal(result.toolCalls[0]?.name, "echo");
  assert.equal(llm.results.length, 1);

  await ctx.dispose();
});

test("generate rejects when no provider is configured", async () => {
  const ctx = new Context();
  const llm = new LlmRuntime(ctx);
  assert.equal(llm.currentProvider, undefined);
  await assert.rejects(() => llm.generate([]), NoProviderError);
  await ctx.dispose();
});

test("setProvider hot-swaps the provider for subsequent calls", async () => {
  const ctx = new Context();
  const llm = new LlmRuntime(ctx, { provider: new MockProvider({}, "mock-a") });

  const first = await llm.generate([{ role: "user", content: "hi" }]);
  assert.equal(first.provider, "mock-a");

  llm.setProvider(new MockProvider({}, "mock-b"));
  assert.equal(llm.providerName, "mock-b");

  const second = await llm.generate([{ role: "user", content: "hi" }]);
  assert.equal(second.provider, "mock-b");
  assert.equal(llm.results.length, 2);

  await ctx.dispose();
});

test("setProvider emits llm:provider-changed on the kernel bus", async () => {
  const ctx = new Context();
  const llm = new LlmRuntime(ctx, { provider: new MockProvider({}, "first") });

  const seen: Array<{ previous?: string; current?: string }> = [];
  ctx.on(LlmRuntime.PROVIDER_CHANGED, (payload) => seen.push(payload));

  llm.setProvider(new MockProvider({}, "second"));
  assert.deepEqual(
    seen.map((s) => [s.previous, s.current]),
    [["first", "second"]],
  );

  await ctx.dispose();
});

test("a custom provider can be plugged in without touching the runtime", async () => {
  const ctx = new Context();
  const fixed: LlmProvider = {
    name: "fixed",
    async generate(_messages: Message[], _options: GenerateOptions): Promise<GenerateResult> {
      return {
        text: "canned",
        toolCalls: [],
        finishReason: "stop",
        provider: "fixed",
      };
    },
  };

  const llm = new LlmRuntime(ctx, { provider: fixed });
  const result = await llm.generate([{ role: "user", content: "x" }]);
  assert.equal(result.text, "canned");
  await ctx.dispose();
});

test("ask() is a stateless convenience alias of generate()", async () => {
  const ctx = new Context();
  const llm = new LlmRuntime(ctx, { provider: new MockProvider() });

  const first = await llm.ask([{ role: "user", content: "echo please" }]);
  assert.equal(first.finishReason, "tool_calls");

  // 运行时不再累积历史：第二次调用必须由调用方完整给出消息列表。
  const call = first.toolCalls[0]!;
  const history: Message[] = [
    { role: "user", content: "echo please" },
    assistantMessageFrom(first),
    toolResultMessage(call, "echoed!"),
  ];
  const second = await llm.ask(history);
  assert.equal(second.finishReason, "stop");
  assert.match(second.text, /echo: echoed!/);

  // 两次调用都会被记入结果流水（用于审计），但它不是对话状态。
  assert.equal(llm.results.length, 2);

  await ctx.dispose();
});

test("LlmRuntime no longer accumulates conversation history", async () => {
  const ctx = new Context();
  const llm = new LlmRuntime(ctx, { provider: new MockProvider() });

  await llm.generate([{ role: "user", content: "hi" }]);
  await llm.generate([{ role: "user", content: "hi again" }]);

  // 旧 API 已移除：不存在 history / messages / resetHistory。
  assert.equal("messages" in llm, false);
  assert.equal("resetHistory" in llm, false);
  assert.equal(llm.results.length, 2);

  await ctx.dispose();
});

// --- 端到端：日志驱动模型 --------

test("end to end: session log folds into a conversation the model completes", async () => {
  const dir = await tmp();
  const ctx = new Context();
  const session = new Session({ id: "e2e", file: join(dir, "e2e.jsonl") });
  const llm = new LlmRuntime(ctx, { provider: new MockProvider() });

  // 第 1 轮：记录用户消息，模型请求调用工具。
  session.appendUserMessage("say hi");
  const turn1 = await llm.generate(session.deriveMessages());
  assert.equal(turn1.finishReason, "tool_calls");

  const call = turn1.toolCalls[0]!;
  const assistantMsg = assistantMessageFrom(turn1);
  session.appendAssistantMessage(assistantMsg.content, assistantMsg.toolCalls);

  // 工具执行完毕，结果写入日志。
  session.appendToolResult({
    toolCallId: call.id,
    name: call.name,
    content: String(call.arguments.text ?? ""),
  });

  // 第 2 轮：折叠后的日志中现已包含工具结果。
  const folded = session.deriveMessages();
  assert.deepEqual(
    folded.map((m) => m.role),
    ["user", "assistant", "tool"],
  );

  const turn2 = await llm.generate(folded);
  assert.equal(turn2.finishReason, "stop");
  assert.match(turn2.text, /hello from mock/);

  await session.flush();
  const reloaded = await Session.load(join(dir, "e2e.jsonl"));
  assert.deepEqual(reloaded.deriveMessages(), folded);

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
