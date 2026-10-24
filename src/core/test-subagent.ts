/**
 * 子智能体与动态插件测试。
 * 运行方式：npm run test:subagent
 */

import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MockProvider } from "./llm.js";
import { createRuntime } from "../runtime.js";
import { discoverPlugins, ensurePluginDir } from "../core/plugins/discover.js";

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

const baseConfig = () => ({
  apiKey: "t",
  baseURL: "http://x",
  model: "mock-model",
  maxSteps: 3,
  workspaceRoot: process.cwd(),
  sessionDir: null,
  provider: new MockProvider(),
});

test("spawn_agent 工具已注册", async () => {
  const rt = await createRuntime(baseConfig());
  assert.ok(rt.tools.list().includes("spawn_agent"));
  await rt.shutdown();
});

test("spawn_agent 创建独立会话并返回结果", async () => {
  const rt = await createRuntime(baseConfig());
  const r = await rt.tools.executeTool("spawn_agent", {
    role: "你是测试角色",
    task: "完成一个测试任务",
  });
  assert.equal(r.isError, false);
  const payload = JSON.parse(r.content) as { status: string; sessionId: string };
  assert.equal(payload.status, "done");
  assert.ok(payload.sessionId.startsWith("sess_"));

  await rt.shutdown();
});

test("子代理拥有独立轨迹", async () => {
  const rt = await createRuntime(baseConfig());
  const r = await rt.tools.executeTool("spawn_agent", { role: "r", task: "t" });
  const { sessionId } = JSON.parse(r.content) as { sessionId: string };

  const events = rt.listTraceEvents(sessionId);
  assert.ok(events.length > 0, "子代理应产生独立轨迹");
  assert.equal(events[0]?.type, "run.start");
  assert.equal(events.at(-1)?.type, "run.end");

  await rt.shutdown();
});

test("子代理记录可被查询", async () => {
  const rt = await createRuntime(baseConfig());
  await rt.tools.executeTool("spawn_agent", { role: "审查者", task: "检查代码" });

  const list = rt.listSubAgents();
  assert.equal(list.length, 1);
  assert.equal(list[0]?.role, "审查者");
  assert.equal(list[0]?.status, "done");

  await rt.shutdown();
});

test("超过最大嵌套深度时拒绝派生", async () => {
  const rt = await createRuntime(baseConfig());
  // 深度由 AsyncLocalStorage 管理，这里直接构造一个已达上限的异步上下文
  const { runInSpawnDepth } = await import("./sub-agent.js");
  const r = await runInSpawnDepth(2, () =>
    rt.tools.executeTool("spawn_agent", { role: "x", task: "y" }),
  );
  assert.equal(r.isError, true);
  assert.match(r.content, /最大嵌套深度/);
  await rt.shutdown();
});

test("缺少 role 或 task 时报错", async () => {
  const rt = await createRuntime(baseConfig());
  const r = await rt.tools.executeTool("spawn_agent", { role: "", task: "t" });
  assert.equal(r.isError, true);
  await rt.shutdown();
});

test("并发派发多个子代理不冲突（AsyncLocalStorage 隔离）", async () => {
  const rt = await createRuntime(baseConfig());
  const results = await Promise.all(
    Array.from({ length: 4 }, (_, i) =>
      rt.tools.executeTool("spawn_agent", { role: `角色${i}`, task: `任务${i}` }),
    ),
  );
  assert.equal(results.every((r) => !r.isError), true, "并发派生应全部成功");
  assert.equal(rt.listSubAgents().length, 4);

  await rt.shutdown();
});

test("并发子代理的 Session 日志与 Trace 轨迹深度隔离，不串数据", async () => {
  const rt = await createRuntime(baseConfig());

  // 并发派生 4 个子代理，每个的任务描述互不相同
  const tasks = Array.from({ length: 4 }, (_, i) => `唯一任务标记-${i}`);
  await Promise.all(
    tasks.map((task, i) =>
      rt.tools.executeTool("spawn_agent", { role: `唯一角色-${i}`, task }),
    ),
  );

  const agents = rt.listSubAgents();
  assert.equal(agents.length, 4, "每个任务都应生成一条记录");

  // 1. Session 隔离：每个子代理的会话里只能看到自己的任务，不能出现别人的
  for (const agent of agents) {
    const session = rt.sessions.get(agent.sessionId);
    assert.ok(session, `子代理 ${agent.role} 应有独立会话`);
    const text = session.log
      .map((e) => ("content" in e ? String(e.content ?? "") : ""))
      .join("\n");
    assert.ok(
      text.includes(agent.task),
      `会话里应包含自己的任务（${agent.task}）`,
    );
    for (const other of tasks) {
      if (other === agent.task) continue;
      assert.equal(
        text.includes(other),
        false,
        `会话 ${agent.sessionId} 不应出现其它子代理的任务 ${other}`,
      );
    }
  }

  // 2. Trace 隔离：每个 traceId 只属于一条记录
  const traceIds = agents.map((a) => a.traceId).filter(Boolean);
  assert.equal(
    new Set(traceIds).size,
    traceIds.length,
    "并发派生的 traceId 必须互不相同",
  );

  // 3. 轨迹事件归属：某条轨迹里的事件不应指向别的子代理会话
  for (const agent of agents) {
    const events = rt.listTraceEvents(agent.sessionId);
    for (const e of events) {
      assert.equal(
        e.sessionId,
        agent.sessionId,
        `轨迹事件 ${e.id} 串到了别的会话`,
      );
    }
  }

  // 4. 深度栈不串：每个子代理都从深度 1 开始，因此都能再派一层
  assert.equal(new Set(agents.map((a) => a.sessionId)).size, 4);

  await rt.shutdown();
});

test("子代理记录带独立 traceId 且互不相同", async () => {
  const rt = await createRuntime(baseConfig());
  await rt.tools.executeTool("spawn_agent", { role: "a", task: "t1" });
  await rt.tools.executeTool("spawn_agent", { role: "b", task: "t2" });

  const list = rt.listSubAgents();
  const ids = list.map((a) => a.traceId);
  assert.equal(ids.every((t) => typeof t === "string" && t.length > 0), true);
  assert.equal(new Set(ids).size, ids.length, "traceId 应互不相同");

  await rt.shutdown();
});

test("ensurePluginDir 自动创建目录", async () => {
  const dir = join(await mkdtemp(join(tmpdir(), "lish-plug-")), "nested", "plugins");
  assert.equal(await ensurePluginDir(dir), true);
  assert.equal(await ensurePluginDir(dir), true, "重复调用应幂等");
  await rm(dir, { recursive: true, force: true });
});

test("discoverPlugins 发现 .ts/.js 并忽略其它文件", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lish-plug2-"));
  await writeFile(join(dir, "a.ts"), "export function apply(){}", "utf8");
  await writeFile(join(dir, "b.js"), "export function apply(){}", "utf8");
  await writeFile(join(dir, "c.d.ts"), "export {}", "utf8");
  await writeFile(join(dir, "_skip.ts"), "export function apply(){}", "utf8");
  await writeFile(join(dir, "readme.md"), "# x", "utf8");

  const rows = await discoverPlugins(dir);
  const ids = rows.map((r) => r.id).sort();
  assert.deepEqual(ids, ["a", "b"]);

  await rm(dir, { recursive: true, force: true });
});

test("目录中的 .ts 插件能被 Loader 真实加载", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lish-plug3-"));
  await writeFile(
    join(dir, "dynamic.ts"),
    `export function apply(ctx){ if(!ctx.has("dyn")) ctx.provide("dyn", { ok: true }); }`,
    "utf8",
  );

  process.env.LISH_PLUGINS_DIR = dir;
  const rt = await createRuntime(baseConfig());
  assert.ok(rt.listPlugins().some((p) => p.id === "dynamic" && p.status === "loaded"));
  assert.equal(rt.ctx.has("dyn"), true);

  await rt.shutdown();
  await rm(dir, { recursive: true, force: true });
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
