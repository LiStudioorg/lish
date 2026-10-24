/**
 * Shell 执行工具。
 *
 * 安全约束（重要）：
 *   - 超时强制终止（默认 5 秒），避免挂起进程拖死服务；
 *   - 输出长度上限，防止 `cat` 大文件撑爆内存；
 *   - 通过 `shell: true` 执行，因此**默认不做命令白名单**——
 *     这是一个刻意的取舍：终端面板本就是给用户自己用的。
 *     模型侧的 `shell.run` 工具可以按需被插件开关禁用。
 */

import { spawn } from "node:child_process";

import type { ToolDefinition } from "../core/tools.js";
import { getShellInfo, shellGuidance, type ShellInfo } from "./shell-detect.js";

export interface ShellResult {
  command: string;
  stdout: string;
  stderr: string;
  /** 退出码；被超时杀死时为 null */
  code: number | null;
  /** 是否因超时被强制终止 */
  timedOut: boolean;
  durationMs: number;
}

export interface RunShellOptions {
  cwd: string;
  /** 超时毫秒，默认 5000 */
  timeoutMs?: number;
  /** stdout/stderr 各自最大字符数，默认 64KB */
  maxOutputChars?: number;
  /** 显式指定 shell；缺省时使用跨平台探测结果 */
  shell?: ShellInfo;
}

/** 执行一条命令并收集输出。 */
export function runShell(command: string, options: RunShellOptions): Promise<ShellResult> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxChars = options.maxOutputChars ?? 64 * 1024;
  const started = Date.now();

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    // 跨平台 shell：Windows 优先 Git Bash（可直接跑 ls/grep），
    // 找不到再降级 PowerShell，避免模型按 Unix 习惯下指令时卡死。
    const shell = options.shell ?? getShellInfo();

    const child = shell.path
      ? spawn(shell.path, [...(shell.args ?? ["-c"]), command], {
          cwd: options.cwd,
          detached: process.platform !== "win32",
        })
      : spawn(command, {
          cwd: options.cwd,
          shell: true,
          // 独立进程组：shell:true 时会先起一个 /bin/sh，
          // 只有 detached 才能把它的子进程一起纳入同一个组。
          detached: process.platform !== "win32",
        });

    /** 结束并返回，最多只生效一次。 */
    function finish(code: number | null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command,
        stdout: stdout.slice(0, maxChars),
        stderr: stderr.slice(0, maxChars),
        code,
        timedOut,
        durationMs: Date.now() - started,
      });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      // 杀掉整个进程组；再兜底等 300ms，避免 close 事件迟迟不来
      const pid = child.pid;
      if (pid !== undefined) {
        try {
          if (process.platform === "win32") {
            spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
          } else {
            // 负号 = 进程组
            process.kill(-pid, "SIGKILL");
          }
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            /* 已退出 */
          }
        }
      }
      setTimeout(() => finish(null), 300);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < maxChars) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < maxChars) stderr += chunk.toString("utf8");
    });

    child.on("error", (err) => {
      stderr += `\n${err.message}`;
      finish(null);
    });

    child.on("close", (code) => finish(code));
  });
}

/**
 * 构造一个可注册到 ToolRegistry 的 `shell.run` 工具。
 *
 * 模型调用它时走的是同一条执行路径，因此同样受超时保护。
 */
export function createShellTool(cwd: string, timeoutMs = 5000): ToolDefinition {
  // 探测一次并缓存在闭包里：既避免每次调用都扫磁盘，
  // 也让工具描述能声明「本环境有哪些命令可用」。
  const shell = getShellInfo();
  const guidance = shellGuidance(shell);

  return {
    name: "shell.run",
    description:
      "在工作区目录下执行一条 shell 命令并返回输出（默认 5 秒超时）。" +
      "请仅用于只读探查，如 ls、cat、grep。" +
      (guidance ? `\n${guidance}` : ""),
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "要执行的 shell 命令" },
      },
      required: ["command"],
    },
    handler: async (args) => {
      const command = String(args.command ?? "").trim();
      if (!command) throw new Error("command 不能为空");
      const result = await runShell(command, { cwd, timeoutMs });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.code,
        timedOut: result.timedOut,
      };
    },
  };
}
