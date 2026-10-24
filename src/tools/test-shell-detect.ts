/**
 * 跨平台 Shell 探测测试。
 *
 * 重点：在没有 Windows 机器的 CI 上，用注入的 `platform` / `env` / `exists`
 * 模拟 Windows 文件系统，验证探测优先级与降级链路。
 */

import assert from "node:assert/strict";

import {
  detectShell,
  getShellInfo,
  resetShellCache,
  shellGuidance,
} from "./shell-detect.js";

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) =>
  tests.push([name, fn]);

/** 构造一个「只有指定路径存在」的 exists 函数。 */
const only = (...paths: string[]) => (p: string) =>
  paths.includes(p) || paths.some((x) => x.toLowerCase() === p.toLowerCase());

// --- 非 Windows -----------------------------------------------------------

test("Linux/macOS 使用系统默认 shell，Unix 工具可用", () => {
  for (const platform of ["linux", "darwin"]) {
    const info = detectShell(platform, {}, () => false);
    assert.equal(info.kind, "posix");
    assert.equal(info.path, undefined, "应交给 shell:true 使用 /bin/sh");
    assert.equal(info.hasUnixTools, true);
    assert.equal(shellGuidance(info), "", "有 Unix 工具时不应加提示");
  }
});

// --- Windows 降级链路 -----------------------------------------------------

test("Windows + 找到 Git Bash → 优先用 bash.exe", () => {
  const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
  const info = detectShell("win32", {}, only(gitBash));
  assert.equal(info.kind, "git-bash");
  assert.equal(info.path, gitBash);
  assert.deepEqual(info.args, ["-c"]);
  assert.equal(info.hasUnixTools, true, "Git Bash 提供 ls/grep");
});

test("Windows + 没有 Git Bash → 降级 PowerShell", () => {
  const pwsh = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const info = detectShell("win32", {}, only(pwsh));
  assert.equal(info.kind, "powershell");
  assert.equal(info.path, pwsh);
  assert.deepEqual(info.args, ["-NoLogo", "-NoProfile", "-Command"]);
  assert.equal(info.hasUnixTools, false, "PowerShell 没有 ls/grep 语义");
});

test("Windows + 两者都没有 → 退回 cmd.exe", () => {
  const info = detectShell("win32", {}, () => false);
  assert.equal(info.kind, "cmd");
  assert.equal(info.path, undefined, "cmd 交给 shell:true");
  assert.equal(info.hasUnixTools, false);
});

test("Windows + 两者都有 → Git Bash 优先（不被 PowerShell 抢走）", () => {
  const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
  const pwsh = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const info = detectShell("win32", {}, only(gitBash, pwsh));
  assert.equal(info.kind, "git-bash");
});

// --- GIT_INSTALL_ROOT -----------------------------------------------------

test("自定义安装位置通过 GIT_INSTALL_ROOT 被识别", () => {
  const root = "D:\\Tools\\Git";
  const bash = "D:\\Tools\\Git\\bin\\bash.exe";
  const info = detectShell("win32", { GIT_INSTALL_ROOT: root }, only(bash));
  assert.equal(info.kind, "git-bash");
  assert.equal(info.path, bash);
});

test("GIT_INSTALL_ROOT 指向无效目录时继续走硬编码候选", () => {
  const bash = "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe";
  const info = detectShell(
    "win32",
    { GIT_INSTALL_ROOT: "D:\\不存在" },
    only(bash),
  );
  assert.equal(info.path, bash);
});

// --- 显式覆盖 -------------------------------------------------------------

test("LISH_SHELL 覆盖一切探测结果", () => {
  const info = detectShell("win32", { LISH_SHELL: "/opt/custom/bash" }, () => true);
  assert.equal(info.path, "/opt/custom/bash");
  assert.equal(info.kind, "git-bash");
  assert.equal(info.hasUnixTools, true);
});

test("LISH_SHELL 指向 PowerShell 时按 PowerShell 约定传参", () => {
  const info = detectShell("linux", { LISH_SHELL: "pwsh" }, () => false);
  assert.equal(info.kind, "powershell");
  assert.deepEqual(info.args, ["-NoLogo", "-NoProfile", "-Command"]);
});

// --- 提示文案 -------------------------------------------------------------

test("无 Unix 工具时给出 PowerShell 等价命令提示", () => {
  const info = detectShell("win32", {}, () => false);
  const text = shellGuidance(info);
  assert.match(text, /Get-ChildItem/);
  assert.match(text, /Select-String/);
  assert.match(text, /Get-Content/);
});

// --- 缓存 -----------------------------------------------------------------

test("getShellInfo 缓存探测结果，resetShellCache 后可重新探测", () => {
  resetShellCache();
  const first = getShellInfo();
  const second = getShellInfo();
  assert.equal(first, second, "同一进程内应返回同一对象引用");
  resetShellCache();
  const third = getShellInfo();
  assert.notEqual(first, third, "重置后应是新的探测结果");
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
