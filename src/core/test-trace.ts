/**
 * 轨迹（Trace）测试：事件完整性、毫秒时间戳、真实耗时与 token 用量。
 * 运行方式：npm run test:trace
 */

import assert from "node:assert/strict";

import { Context } from "../kernel/context.js";
import { SessionService } from "./sessions.js";
import { LlmRuntime, MockProvider } from "./llm.js";
import { ToolRegistry } from "./tools.js";
import { AgentLoop } from "./agent-loop.js";
import { TraceStore, newTraceId } from "./trace.js";

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

/** 构造最小内核。 */
function makeStack() {
  const ctx = new Context();
  const sessions = new SessionService(ctx);
  ctx.provide(SessionService.KEY, sessions);
  const llm = new LlmRuntime(ctx, { provider: new MockProvider() });
  ctx.provide(LlmRuntime.KEY, llm);
  const tools = new ToolRegistry(ctx);
  ctx.provide(ToolRegistry.KEY, tools);
  tools.register({
    name: "echo",
    description: "回显",
    parameters: { type: "object", properties: { text: { type: "string" } } },
    handler: (a) => String(a.text ?? ""),
  });
  const traceStore = new TraceStore();
  const agent = new AgentLoop(ctx, { maxSteps: 4, traceStore });
  ctx.provide(AgentLoop.KEY, agent);
  return { ctx, sessions, agent, traceStore };
}

test("traceId 格式正确且唯一", () => {
  const a = newTraceId();
  const b = newTraceId();
  assert.match(a, /^trc_[a-z0-9]+_[a-z0-9]+$/);
  assert.notEqual(a, b);
});

test("一次运行产生完整事件序列", async () => {
  const { ctx, sessions, agent, traceStore } = makeStack();
  const s = sessions.create({ id: "s1" });
  await agent.run(s, "hi");

  const events = traceStore.list("s1");
  const types = events.map((e) => e.type);
  assert.deepEqual(types, [
    "run.start",
    "step.thinking",
    "tool.call",
    "tool.result",
    "step.thinking",
    "answer",
    "run.end",
  ]);

  await ctx.dispose();
});

test("每个事件都带 traceId / timestamp / duration", async () => {
  const { ctx, sessions, agent, traceStore } = makeStack();
  const s = sessions.create({ id: "s2" });
  await agent.run(s, "hi");

  for (const e of traceStore.list("s2")) {
    assert.ok(e.traceId.startsWith("trc_"), `traceId 缺失：${e.type}`);
    assert.equal(typeof e.timestamp, "number");
    assert.ok(e.timestamp > 0);
    assert.equal(typeof e.duration, "number");
    assert.ok(e.duration >= 0);
  }
  // 同一 run 内 traceId 一致
  const ids = new Set(traceStore.list("s2").map((e) => e.traceId));
  assert.equal(ids.size, 1);

  await ctx.dispose();
});

test("时间戳单调不减（可用于排序）", async () => {
  const { ctx, sessions, agent, traceStore } = makeStack();
  await agent.run(sessions.create({ id: "s3" }), "hi");
  const ts = traceStore.list("s3").map((e) => e.timestamp);
  for (let i = 1; i < ts.length; i++) {
    assert.ok(ts[i]! >= ts[i - 1]!, `时间戳逆序：${ts[i - 1]} > ${ts[i]}`);
  }
  await ctx.dispose();
});

test("thinking 事件含真实耗时与 token 用量", async () => {
  const { ctx, sessions, agent, traceStore } = makeStack();
  await agent.run(sessions.create({ id: "s4" }), "hi");

  const thinking = traceStore.list("s4").filter((e) => e.type === "step.thinking");
  assert.ok(thinking.length >= 1);
  for (const e of thinking) {
    assert.ok(e.tokenUsage, "缺少 tokenUsage");
    assert.equal(typeof e.tokenUsage.outputTokens, "number");
  }
  await ctx.dispose();
});

test("tool.call 记录入参、Schema 与 callId", async () => {
  const { ctx, sessions, agent, traceStore } = makeStack();
  await agent.run(sessions.create({ id: "s5" }), "hi");

  const call = traceStore.list("s5").find((e) => e.type === "tool.call");
  assert.ok(call);
  assert.equal(call.toolName, "echo");
  assert.ok(call.callId);
  assert.ok(call.args);
  assert.ok(call.schema, "缺少工具 Schema");
  await ctx.dispose();
});

test("tool.result 记录真实耗时与结果", async () => {
  const { ctx, sessions, agent, traceStore } = makeStack();
  await agent.run(sessions.create({ id: "s6" }), "hi");

  const res = traceStore.list("s6").find((e) => e.type === "tool.result");
  assert.ok(res);
  assert.equal(typeof res.duration, "number");
  assert.ok(typeof res.result === "string" && res.result.length > 0);
  await ctx.dispose();
});

test("工具执行失败时 isError 为 true", async () => {
  const ctx = new Context();
  const sessions = new SessionService(ctx);
  ctx.provide(SessionService.KEY, sessions);
  const llm = new LlmRuntime(ctx, { provider: new MockProvider() });
  ctx.provide(LlmRuntime.KEY, llm);
  const tools = new ToolRegistry(ctx);
  ctx.provide(ToolRegistry.KEY, tools);
  tools.register({
    name: "echo",
    handler: () => {
      throw new Error("boom");
    },
  });
  const traceStore = new TraceStore();
  const agent = new AgentLoop(ctx, { maxSteps: 3, traceStore });
  ctx.provide(AgentLoop.KEY, agent);

  await agent.run(sessions.create({ id: "s7" }), "hi");
  const res = traceStore.list("s7").find((e) => e.type === "tool.result");
  assert.equal(res?.isError, true);

  await ctx.dispose();
});

test("TraceStore 超出上限时淘汰最旧事件", () => {
  const store = new TraceStore(3);
  for (let i = 0; i < 5; i++) {
    store.append({
      traceId: "t",
      sessionId: "s",
      type: "run.start",
      step: i,
      timestamp: Date.now(),
      duration: 0,
      title: `e${i}`,
    });
  }
  const list = store.list("s");
  assert.equal(list.length, 3);
  assert.equal(list[0]?.title, "e2");
});

test("不同会话的轨迹互相隔离", async () => {
  const { ctx, sessions, agent, traceStore } = makeStack();
  await agent.run(sessions.create({ id: "a" }), "hi");
  await agent.run(sessions.create({ id: "b" }), "hi");

  assert.ok(traceStore.list("a").length > 0);
  assert.ok(traceStore.list("b").length > 0);
  assert.equal(
    traceStore.list("a").every((e) => e.sessionId === "a"),
    true,
  );
  await ctx.dispose();
});

// --- 运行器 ---------------------------------------------------------------

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
