/**
 * 跨平台 Shell 探测。
 *
 * 动机：Windows 上 `cmd.exe` 根本没有 `ls` / `grep` / `sed` 这些 Unix 命令，
 * 模型若按 Unix 习惯下指令会直接失败，表现为"卡死 + 空输出"。
 * 因此在执行器初始化时动态探测一次，优先使用 **Git Bash**，
 * 找不到再降级到 PowerShell，最后才退回系统默认 shell。
 *
 * 探测结果按平台缓存（每个进程只扫一次磁盘），
 * 并允许通过环境变量 `LISH_SHELL` 强制指定（测试与特殊环境用）。
 */

import { existsSync } from "node:fs";
import { win32 } from "node:path";

/** 探测到的 shell 种类。 */
export type ShellKind = "posix" | "git-bash" | "powershell" | "cmd";

export interface ShellInfo {
  kind: ShellKind;
  /** 可执行文件绝对路径；`undefined` 表示用系统默认（`shell: true`）。 */
  path?: string;
  /** 传给 spawn 的额外参数（用于 `-c` / `-Command` 这类调用约定）。 */
  args?: string[];
  /** 人类可读的说明，用于启动日志与报错。 */
  label: string;
  /** 该 shell 是否提供 Unix 工具（ls/grep/sed）。 */
  hasUnixTools: boolean;
}

/** Git for Windows 的常见安装位置。 */
const GIT_BASH_CANDIDATES = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
];

const POWERSHELL_CANDIDATES = [
  "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
];

/**
 * 探测 Git Bash。
 *
 * 除了硬编码路径，还会检查 `GIT_INSTALL_ROOT` 环境变量——
 * 用户自定义安装时 Git 会写这个变量，比扫描整个磁盘可靠得多。
 */
function findGitBash(
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean,
): string | undefined {
  const fromEnv = env.GIT_INSTALL_ROOT?.trim();
  if (fromEnv) {
    // 用 win32 规则拼接：Git 的安装根永远是 Windows 风格路径，
    // 而探测逻辑也要能在非 Windows 的测试环境里正确工作。
    const root = win32.normalize(fromEnv);
    for (const rel of ["bin\\bash.exe", "usr\\bin\\bash.exe"]) {
      const candidate = win32.join(root, rel);
      if (exists(candidate)) return candidate;
    }
  }
  for (const candidate of GIT_BASH_CANDIDATES) {
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

function findPowerShell(
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean,
): string | undefined {
  const fromEnv = env.PSModulePath;
  if (fromEnv) {
    const first = fromEnv.split(";")[0];
    if (first) {
      const candidate = win32.join(win32.normalize(first), "powershell.exe");
      if (exists(candidate)) return candidate;
    }
  }
  for (const candidate of POWERSHELL_CANDIDATES) {
    if (exists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * 探测当前平台应使用的 shell。
 *
 * 优先级：
 *   - `LISH_SHELL` 显式指定 → 直接采用（便于测试与特殊环境）
 *   - 非 Windows → POSIX shell（`shell: true` 用系统默认 /bin/sh）
 *   - Windows → Git Bash → PowerShell → cmd.exe
 *
 * @param platform 平台标识，默认取 `process.platform`（测试可注入）
 * @param env      环境变量，默认取 `process.env`
 * @param exists   文件存在性检查，默认取 `fs.existsSync`（测试可注入）
 */
export function detectShell(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = existsSync,
): ShellInfo {
  // 1. 显式覆盖：用户知道自己要什么
  const override = env.LISH_SHELL?.trim();
  if (override) {
    const lower = override.toLowerCase();
    const isBash = lower.includes("bash");
    return {
      kind: isBash ? "git-bash" : lower.includes("powershell") || lower.includes("pwsh") ? "powershell" : "posix",
      path: override,
      args: lower.includes("powershell") || lower.includes("pwsh")
        ? ["-NoLogo", "-NoProfile", "-Command"]
        : ["-c"],
      label: `自定义 Shell（LISH_SHELL=${override}）`,
      hasUnixTools: isBash,
    };
  }

  // 2. 非 Windows：沿用系统默认，Unix 工具天然可用
  if (platform !== "win32") {
    return {
      kind: "posix",
      label: "系统默认 shell（/bin/sh）",
      hasUnixTools: true,
    };
  }

  // 3. Windows：Git Bash 优先，Unix 命令可直接使用
  const bash = findGitBash(env, exists);
  if (bash) {
    return {
      kind: "git-bash",
      path: bash,
      args: ["-c"],
      label: "Git Bash",
      hasUnixTools: true,
    };
  }

  // 4. 降级到 PowerShell
  const pwsh = findPowerShell(env, exists);
  if (pwsh) {
    return {
      kind: "powershell",
      path: pwsh,
      args: ["-NoLogo", "-NoProfile", "-Command"],
      label: "PowerShell",
      hasUnixTools: false,
    };
  }

  // 5. 最后退回 cmd（Node 在 Windows 上的默认 shell）
  return {
    kind: "cmd",
    label: "cmd.exe",
    hasUnixTools: false,
  };
}

/** 探测结果缓存（每个进程只探测一次）。 */
let cached: ShellInfo | undefined;

/**
 * 取当前进程的 Shell 信息（带缓存）。
 *
 * 首次调用时探测，之后直接返回缓存值。
 */
export function getShellInfo(): ShellInfo {
  if (!cached) cached = detectShell();
  return cached;
}

/** 清空缓存（测试用）。 */
export function resetShellCache(): void {
  cached = undefined;
}

/**
 * 为 Windows + PowerShell 生成「Unix 命令友好」的提示。
 *
 * 当探测结果表明没有 Unix 工具时，把它拼进工具描述，
 * 让模型改用 PowerShell 等价命令，而不是反复试 `ls`。
 */
export function shellGuidance(info: ShellInfo): string {
  if (info.hasUnixTools) return "";
  return (
    "注意：当前环境没有 Unix 工具（ls/grep/sed）。" +
    "请改用 PowerShell 命令：列目录用 Get-ChildItem（别名 dir），" +
    "搜索用 Select-String（别名 sls），读文件用 Get-Content（别名 cat）。"
  );
}
