/**
 * Agent 预设与版本检测测试。
 *
 * 预设的关键契约：**切换预设必须真正改变注入的 System Prompt**，
 * 而不是只改一个显示名称。版本检测则必须永不抛错、永不阻塞。
 */

import assert from "node:assert/strict";

import {
  isAgentPreset,
  isPresetMessage,
  PRESET_MARKER,
  PRESETS,
  presetPromptOf,
} from "./presets.js";
import {
  formatUpdateHint,
  isOutdated,
  parseVersion,
} from "./update-check.js";

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) =>
  tests.push([name, fn]);

// --- 预设 -----------------------------------------------------------------

test("四种预设都存在且都有非空 prompt", () => {
  const ids = ["standard", "review", "minimal", "creative"] as const;
  for (const id of ids) {
    const spec = PRESETS[id];
    assert.ok(spec, `缺少预设 ${id}`);
    assert.equal(spec.id, id);
    assert.ok(spec.name.length > 0, `${id} 缺少展示名`);
    assert.ok(spec.prompt.length > 0, `${id} 缺少 System Prompt`);
  }
});

test("每种预设的 prompt 互不相同（不是改个名字）", () => {
  const prompts = Object.values(PRESETS).map((p) => p.prompt);
  assert.equal(
    new Set(prompts).size,
    prompts.length,
    "不同预设必须注入不同的 System Prompt",
  );
});

test("注入文本带可识别标记，便于切换时替换", () => {
  for (const id of ["standard", "review", "minimal", "creative"] as const) {
    const text = presetPromptOf(id);
    assert.ok(text.startsWith(PRESET_MARKER), `${id} 缺少预设标记`);
    assert.equal(isPresetMessage(text), true);
  }
});

test("空内容不会被误判为预设消息", () => {
  assert.equal(isPresetMessage(""), false);
  assert.equal(isPresetMessage("你是一个普通提示"), false);
});

test("review 预设明确要求只读", () => {
  const prompt = PRESETS.review.prompt;
  assert.match(prompt, /只读/);
  assert.match(prompt, /严禁修改/);
});

test("minimal 预设要求不啰嗦", () => {
  const prompt = PRESETS.minimal.prompt;
  assert.match(prompt, /简洁|不要开场白/);
});

test("isAgentPreset 正确校验外部输入", () => {
  assert.equal(isAgentPreset("review"), true);
  assert.equal(isAgentPreset("standard"), true);
  assert.equal(isAgentPreset("nope"), false);
  assert.equal(isAgentPreset(undefined), false);
  assert.equal(isAgentPreset(42), false);
  // 原型链上的属性不应被当合法值
  assert.equal(isAgentPreset("toString"), false);
});

// --- 版本比较 -------------------------------------------------------------

test("parseVersion 解析正式版与预发布版", () => {
  assert.deepEqual(parseVersion("1.2.3"), {
    major: 1,
    minor: 2,
    patch: 3,
    pre: "",
  });
  const pre = parseVersion("0.1.0-alpha.3");
  assert.equal(pre?.major, 0);
  assert.equal(pre?.pre, "alpha.3");
  assert.equal(parseVersion("not-a-version"), null);
});

test("主次补丁号更高的版本判定为有更新", () => {
  assert.equal(isOutdated("0.1.0", "0.2.0"), true);
  assert.equal(isOutdated("0.1.0", "1.0.0"), true);
  assert.equal(isOutdated("1.0.0", "0.9.9"), false);
  assert.equal(isOutdated("1.0.0", "1.0.0"), false);
});

test("预发布版落后于同号正式版", () => {
  assert.equal(isOutdated("1.0.0-alpha.1", "1.0.0"), true);
  assert.equal(isOutdated("1.0.0", "1.0.0-alpha.1"), false);
});

test("预发布序号按数值比较", () => {
  assert.equal(isOutdated("0.1.0-alpha.2", "0.1.0-alpha.3"), true);
  assert.equal(isOutdated("0.1.0-alpha.10", "0.1.0-alpha.9"), false);
});

test("无法解析的版本一律不误报", () => {
  assert.equal(isOutdated("garbage", "1.0.0"), false);
  assert.equal(isOutdated("1.0.0", "whatever"), false);
});

test("提示文案包含新版本号与更新命令", () => {
  const hint = formatUpdateHint({ current: "0.1.0-alpha.2", latest: "0.1.0" });
  assert.match(hint, /🚀/);
  assert.match(hint, /0\.1\.0/);
  assert.match(hint, /npm i -g @listudioorg\/lish/);
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
