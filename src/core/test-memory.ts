/**
 * 内存红线防护测试（P0：RSS 必须 < 0.5GB）。
 *
 * 这里不跑真实压测（那由 scripts 里的压测脚本负责），
 * 而是验证那些"会让内存无界增长"的代码路径都已被窗口/上限约束住。
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_MAX_EVENTS, Session } from "./session.js";
import { TraceStore } from "./trace.js";

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) =>
  tests.push([name, fn]);

const tmp = async () => mkdtemp(join(tmpdir(), "lish-mem-"));

// --- Session 事件窗口 -----------------------------------------------------

test("Session 内存事件数不超过 maxEvents", () => {
  const s = new Session({ id: "s1", maxEvents: 100 });
  for (let i = 0; i < 500; i++) {
    s.appendUserMessage(`消息 ${i}`);
  }
  assert.equal(s.log.length, 100, "必须裁到窗口上限");
  assert.ok(
    String(s.log[s.log.length - 1]?.content).includes("499"),
    "保留的应是最新事件",
  );
});

test("窗口裁剪不影响磁盘日志完整性", async () => {
  const dir = await tmp();
  try {
    const file = join(dir, "s.jsonl");
    const s = new Session({ id: "s2", file, maxEvents: 10 });
    for (let i = 0; i < 30; i++) s.appendUserMessage(`消息 ${i}`);
    await s.flush();

    assert.equal(s.log.length, 10, "内存只留 10 条");
    const { readFile } = await import("node:fs/promises");
    const lines = (await readFile(file, "utf8")).trimEnd().split("\n");
    // 1 条 session.created + 30 条消息
    assert.equal(lines.length, 31, "磁盘应保留全部事件");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("默认窗口常量足够大，不影响正常使用", () => {
  assert.equal(DEFAULT_MAX_EVENTS, 5000);
  const s = new Session({ id: "s3" });
  for (let i = 0; i < 100; i++) s.appendUserMessage(`m${i}`);
  assert.equal(s.log.length, 101, "1 条 created + 100 条消息，远未触顶");
});

// --- Trace 事件窗口 -------------------------------------------------------

test("TraceStore 每会话事件数不超过上限", () => {
  const store = new TraceStore(50);
  for (let i = 0; i < 300; i++) {
    store.append({
      traceId: "t1",
      sessionId: "s1",
      type: "stream.delta",
      step: 1,
      timestamp: Date.now(),
      duration: 0,
      title: `事件 ${i}`,
    });
  }
  assert.equal(store.list("s1").length, 50, "轨迹必须受窗口约束");
});

test("TraceStore 不同会话各自独立计数", () => {
  const store = new TraceStore(10);
  for (let i = 0; i < 30; i++) {
    store.append({ traceId: "a", sessionId: "sa", type: "answer", step: 1, timestamp: Date.now(), duration: 0, title: "a" });
    store.append({ traceId: "b", sessionId: "sb", type: "answer", step: 1, timestamp: Date.now(), duration: 0, title: "b" });
  }
  assert.equal(store.list("sa").length, 10);
  assert.equal(store.list("sb").length, 10);
});

// --- 文件读取上限 ---------------------------------------------------------

test("fs.read 拒绝超过上限的文件（避免一次性读入内存）", async () => {
  const dir = await tmp();
  try {
    const { createFsTools } = await import("../tools/fs.js");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "big.txt"), "A".repeat(2048));
    const { read } = createFsTools(dir, { maxReadBytes: 1024 });
    await assert.rejects(
      () => Promise.resolve(read.handler({ path: "big.txt" })),
      /too large/i,
      "超过上限必须拒绝，而不是读进内存",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
