/**
 * 前端全局状态（Zustand store）测试。
 *
 * 覆盖：
 *   - 会话增删改与标题推导
 *   - 流式增量的就地合并（不重建无关会话）
 *   - 工具调用的 upsert 语义
 *   - 结束态兜底文案（空内容 / 错误 / 中止）
 *   - 选择器的引用稳定性（高频打字不波及其他会话）—— 这是性能契约
 *
 * 直接调用 store 的 action，不涉及 React 渲染，因此可以在 Node 里跑。
 * 运行方式：npm run test:store
 */

import assert from "node:assert/strict";

import {
  resetStoreForTests,
  selectActiveSession,
  selectMessages,
  useAppStore,
  type AppState,
} from "../src/lib/store";

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) =>
  tests.push([name, fn]);

/** 取当前 store 快照。 */
const snap = (): AppState => useAppStore.getState();

/** 每个用例前重置，保证互不影响。 */
function beforeEach(): void {
  resetStoreForTests();
}

// --- 会话 -----------------------------------------------------------------

test("newSession 创建会话并激活", () => {
  beforeEach();
  const id = snap().newSession();
  assert.equal(snap().activeId, id);
  assert.equal(snap().sessions.length, 1);
  assert.equal(snap().sessions[0].title, "新会话");
});

test("addUserMessage 在无会话时自动建会话，并用首条消息命名", () => {
  beforeEach();
  snap().addUserMessage("读取 package.json 并告诉我项目名");
  const state = snap();
  assert.equal(state.sessions.length, 1);
  assert.equal(state.sessions[0].messages.length, 1);
  assert.ok(state.sessions[0].title.startsWith("读取 package.json"));
});

test("长标题被截断到 24 字符并加省略号", () => {
  beforeEach();
  const long = "一".repeat(60);
  snap().addUserMessage(long);
  const title = snap().sessions[0].title;
  assert.equal(title.length, 25); // 24 + 省略号
  assert.ok(title.endsWith("…"));
});

test("首条之后的消息不改变标题", () => {
  beforeEach();
  snap().addUserMessage("第一条");
  const first = snap().sessions[0].title;
  snap().addUserMessage("第二条完全不同的内容");
  assert.equal(snap().sessions[0].title, first);
});

test("removeSession 删除激活会话后回落到下一条", () => {
  beforeEach();
  const a = snap().newSession();
  const b = snap().newSession();
  assert.equal(snap().activeId, b);
  snap().removeSession(b);
  assert.equal(snap().sessions.length, 1);
  assert.equal(snap().activeId, a);
});

test("删除最后一个会话后 activeId 为 null", () => {
  beforeEach();
  const a = snap().newSession();
  snap().removeSession(a);
  assert.equal(snap().sessions.length, 0);
  assert.equal(snap().activeId, null);
});

test("selectSession 切换到指定会话并重置轨迹", () => {
  beforeEach();
  const a = snap().newSession();
  snap().setTraceEvents([{ id: "e1" } as never]);
  snap().newSession();
  snap().selectSession(a);
  assert.equal(snap().activeId, a);
  assert.deepEqual(snap().traceEvents, []);
});

// --- 流式增量 -------------------------------------------------------------

test("appendDelta 累加到当前助手消息", () => {
  beforeEach();
  snap().addUserMessage("hi");
  snap().startAssistant();
  snap().appendDelta("你");
  snap().appendDelta("好");
  const msgs = selectMessages(snap());
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].content, "你好");
});

test("appendDelta 在没有助手消息时是空操作（不崩溃）", () => {
  beforeEach();
  snap().addUserMessage("hi");
  snap().appendDelta("孤立增量");
  const msgs = selectMessages(snap());
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].role, "user");
});

test("打字只改动当前会话，其它会话引用保持不变", () => {
  beforeEach();
  const a = snap().newSession();
  snap().addUserMessage("会话A");
  snap().startAssistant();
  const b = snap().newSession();
  snap().addUserMessage("会话B");

  const before = snap().sessions.find((s) => s.id === a);
  snap().appendDelta("A 的增量");
  // 当前是 b，没有助手消息 → 不产生任何会话变更
  const after = snap().sessions.find((s) => s.id === a);
  assert.equal(before, after, "非激活会话不应被重新创建");

  // 切回 a 打字，b 引用必须不变
  snap().selectSession(a);
  const bBefore = snap().sessions.find((s) => s.id === b);
  snap().appendDelta("x");
  const bAfter = snap().sessions.find((s) => s.id === b);
  assert.equal(bBefore, bAfter, "其它会话引用必须稳定");
});

test("无激活会话时 selectMessages 返回稳定空数组", () => {
  beforeEach();
  const first = selectMessages(snap());
  const second = selectMessages(snap());
  assert.equal(first, second, "空数组引用应稳定，避免无谓重渲染");
  assert.equal(first.length, 0);
});

// --- 工具调用 -------------------------------------------------------------

test("upsertToolCall 首次插入为 running", () => {
  beforeEach();
  snap().addUserMessage("x");
  snap().startAssistant();
  snap().upsertToolCall({ id: "c1", name: "fs.read", argsJson: '{"path":"a"}' });
  const tc = selectMessages(snap())[1].toolCalls[0];
  assert.equal(tc.name, "fs.read");
  assert.equal(tc.status, "running");
});

test("upsertToolCall 二次更新为 done，保留原有字段", () => {
  beforeEach();
  snap().addUserMessage("x");
  snap().startAssistant();
  snap().upsertToolCall({ id: "c1", name: "fs.read", argsJson: '{"path":"a"}' });
  snap().upsertToolCall({
    id: "c1",
    content: "文件内容",
    isError: false,
    durationMs: 12,
    status: "done",
  });
  const tc = selectMessages(snap())[1].toolCalls[0];
  assert.equal(tc.name, "fs.read", "name 不应丢失");
  assert.equal(tc.argsJson, '{"path":"a"}', "argsJson 不应丢失");
  assert.equal(tc.content, "文件内容");
  assert.equal(tc.status, "done");
});

test("多个工具调用按 id 分别 upsert", () => {
  beforeEach();
  snap().addUserMessage("x");
  snap().startAssistant();
  snap().upsertToolCall({ id: "c1", name: "fs.read" });
  snap().upsertToolCall({ id: "c2", name: "shell.run" });
  snap().upsertToolCall({ id: "c1", content: "ok", status: "done" });
  const calls = selectMessages(snap())[1].toolCalls;
  assert.equal(calls.length, 2);
  assert.equal(calls[0].status, "done");
  assert.equal(calls[1].status, "running");
});

// --- 结束态 ---------------------------------------------------------------

test("finishAssistant 标记 streaming=false", () => {
  beforeEach();
  snap().addUserMessage("x");
  snap().startAssistant();
  snap().appendDelta("回答");
  snap().finishAssistant({ stopReason: "stop" });
  const msg = selectMessages(snap())[1];
  assert.equal(msg.streaming, false);
  assert.equal(msg.content, "回答");
});

test("空内容且正常结束 → 给出「模型未返回内容」", () => {
  beforeEach();
  snap().addUserMessage("x");
  snap().startAssistant();
  snap().finishAssistant({ stopReason: "stop" });
  assert.equal(selectMessages(snap())[1].content, "（模型未返回内容）");
});

test("空内容且出错 → 展示错误", () => {
  beforeEach();
  snap().addUserMessage("x");
  snap().startAssistant();
  snap().finishAssistant({ error: "网络中断" });
  const msg = selectMessages(snap())[1];
  assert.match(msg.content, /请求失败：网络中断/);
  assert.equal(msg.error, "网络中断");
});

test("空内容且中止 → 展示「已停止」", () => {
  beforeEach();
  snap().addUserMessage("x");
  snap().startAssistant();
  snap().finishAssistant({ stopReason: "aborted" });
  assert.equal(selectMessages(snap())[1].content, "（已停止）");
});

test("有工具调用但无文本时不覆盖内容", () => {
  beforeEach();
  snap().addUserMessage("x");
  snap().startAssistant();
  snap().upsertToolCall({ id: "c1", name: "fs.read", status: "done" });
  snap().finishAssistant({ stopReason: "stop" });
  const msg = selectMessages(snap())[1];
  assert.equal(msg.content, "", "有工具调用时不应插入占位文案");
});

// --- 配置与视图 -----------------------------------------------------------

test("setSettings 合并补丁而不丢其它字段", () => {
  beforeEach();
  snap().setSettings({ theme: "light" });
  const s = snap().settings;
  assert.equal(s.theme, "light");
  assert.equal(s.fontSize, "medium", "未指定的字段应保留默认值");
});

test("setSettings 更新预设立即反映", () => {
  beforeEach();
  snap().setSettings({ agentPreset: "review" });
  assert.equal(snap().settings.agentPreset, "review");
});

test("视图状态互不干扰", () => {
  beforeEach();
  snap().setMainTab("trace");
  snap().setSideView("plugins");
  snap().setSettingsOpen(true);
  const s = snap();
  assert.equal(s.mainTab, "trace");
  assert.equal(s.sideView, "plugins");
  assert.equal(s.settingsOpen, true);
});

test("setInput 只改输入框，不触碰会话", () => {
  beforeEach();
  snap().newSession();
  const sessionsBefore = snap().sessions;
  snap().setInput("正在输入的草稿");
  assert.equal(snap().input, "正在输入的草稿");
  assert.equal(snap().sessions, sessionsBefore, "会话引用不应变化");
});

// --- 选择器 ---------------------------------------------------------------

test("selectActiveSession 随 activeId 变化", () => {
  beforeEach();
  const a = snap().newSession();
  snap().newSession();
  snap().selectSession(a);
  assert.equal(selectActiveSession(snap())?.id, a);
});

test("resetStoreForTests 清空所有状态", () => {
  beforeEach();
  snap().newSession();
  snap().setInput("x");
  snap().setTraceEvents([{ id: "e" } as never]);
  resetStoreForTests();
  const s = snap();
  assert.equal(s.sessions.length, 0);
  assert.equal(s.activeId, null);
  assert.equal(s.input, "");
  assert.deepEqual(s.traceEvents, []);
});

// --- 测试运行器 -----------------------------------------------------------

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

// --- 历史分页与内存窗口 ----------------------------------------------------

test("replaceMessages 用服务端历史覆盖本地消息", () => {
  beforeEach();
  const id = snap().newSession();
  snap().replaceMessages(id, {
    messages: [
      { id: "h-0", role: "user", content: "旧消息", toolCalls: [] },
      { id: "h-1", role: "assistant", content: "旧回复", toolCalls: [] },
    ],
    hasMore: true,
    nextBefore: 0,
    total: 50,
  });
  const s = snap().sessions.find((x) => x.id === id)!;
  assert.equal(s.messages.length, 2);
  assert.equal(s.hasMore, true);
  assert.equal(s.total, 50);
});

test("prependMessages 把更早的消息插到头部", () => {
  beforeEach();
  const id = snap().newSession();
  snap().replaceMessages(id, {
    messages: [{ id: "h-10", role: "user", content: "较新", toolCalls: [] }],
    hasMore: true,
    nextBefore: 10,
    total: 30,
  });
  snap().prependMessages(id, {
    messages: [
      { id: "h-5", role: "user", content: "更早A", toolCalls: [] },
      { id: "h-6", role: "assistant", content: "更早B", toolCalls: [] },
    ],
    hasMore: true,
    nextBefore: 5,
    total: 30,
  });
  const msgs = snap().sessions.find((x) => x.id === id)!.messages;
  assert.equal(msgs.length, 3);
  assert.equal(msgs[0].id, "h-5", "更早的消息必须在最前面");
  assert.equal(msgs[2].id, "h-10", "原有消息必须留在后面");
});

test("prependMessages 按 id 去重，重复加载不产生重复项", () => {
  beforeEach();
  const id = snap().newSession();
  const page = {
    messages: [{ id: "h-1", role: "user" as const, content: "A", toolCalls: [] }],
    hasMore: false,
    nextBefore: 1,
    total: 1,
  };
  snap().replaceMessages(id, page);
  snap().prependMessages(id, page);
  snap().prependMessages(id, page);
  const msgs = snap().sessions.find((x) => x.id === id)!.messages;
  assert.equal(msgs.length, 1, "同一页重复 prepend 不应重复");
});

test("消息窗口上限：超过 200 条只保留最近 200 条", () => {
  beforeEach();
  const id = snap().newSession();
  const many = Array.from({ length: 260 }, (_, i) => ({
    id: `h-${i}`,
    role: "user" as const,
    content: `消息 ${i}`,
    toolCalls: [],
  }));
  snap().replaceMessages(id, {
    messages: many,
    hasMore: false,
    nextBefore: 0,
    total: 260,
  });
  const msgs = snap().sessions.find((x) => x.id === id)!.messages;
  assert.equal(msgs.length, 200, "必须裁剪到窗口上限");
  assert.equal(msgs[199].id, "h-259", "保留的应是最新的一条");
  assert.equal(msgs[0].id, "h-60", "最旧的 60 条被裁掉");
});

test("连续加载更早不会让消息数无限增长", () => {
  beforeEach();
  const id = snap().newSession();
  snap().replaceMessages(id, {
    messages: Array.from({ length: 200 }, (_, i) => ({
      id: `n-${i}`,
      role: "user" as const,
      content: `新 ${i}`,
      toolCalls: [],
    })),
    hasMore: true,
    nextBefore: 200,
    total: 1000,
  });
  for (let round = 0; round < 5; round++) {
    snap().prependMessages(id, {
      messages: Array.from({ length: 20 }, (_, i) => ({
        id: `o-${round}-${i}`,
        role: "user" as const,
        content: `旧 ${round}-${i}`,
        toolCalls: [],
      })),
      hasMore: true,
      nextBefore: 100 - round * 20,
      total: 1000,
    });
  }
  const msgs = snap().sessions.find((x) => x.id === id)!.messages;
  assert.equal(msgs.length, 200, "反复加载后仍受窗口上限约束");
});

test("setLoadingMore 只影响目标会话", () => {
  beforeEach();
  const a = snap().newSession();
  const b = snap().newSession();
  snap().setLoadingMore(a, true);
  assert.equal(snap().sessions.find((x) => x.id === a)!.loadingMore, true);
  assert.equal(snap().sessions.find((x) => x.id === b)!.loadingMore, false);
});

