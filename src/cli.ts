#!/usr/bin/env node
/**
 * lish 命令行入口（bin）。
 *
 * 子命令：
 *   lish              默认启动 Web 服务（等价于 `lish web`）
 *   lish web [--port] 启动 Web UI（express + SSE）
 *   lish tui          启动终端 UI（ink）
 *   lish chat         启动极简文本聊天（纯 readline，无 UI 框架依赖）
 *   lish --help       显示帮助
 *
 * 本文件既是 bin 入口，也导出各前端所需的函数供测试复用。
 *
 * 环境变量：
 *   LLM_API_KEY        必填，API 密钥
 *   LLM_BASE_URL       可选，默认 https://api.deepseek.com
 *   LLM_MODEL          可选，默认 deepseek-chat
 *   LLISH_MAX_STEPS    可选，单轮最大步数，默认 8
 *   PORT               可选，Web 服务端口，默认 3000
 *   LLISH_NO_PERSIST   可选，设置后会话不落盘
 */

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import {
  AGENT_ABORTED,
  AGENT_ANSWER,
  AGENT_TOOL_CALL,
  AGENT_TOOL_RESULT,
} from "./core/agent-loop.js";
import { createRuntime, readConfig, UsageError, type Runtime } from "./runtime.js";

// --- 终端颜色（非 TTY 或设置 NO_COLOR 时降级为无色）----------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number, text: string) =>
  useColor ? `\u001b[${code}m${text}\u001b[0m` : text;
const dim = (t: string) => paint(2, t);
const cyan = (t: string) => paint(36, t);
const green = (t: string) => paint(32, t);
const yellow = (t: string) => paint(33, t);
const red = (t: string) => paint(31, t);
const bold = (t: string) => paint(1, t);

/** 将多行/长文本压成适合终端阅读的单行摘要。 */
function preview(text: string, limit = 120): string {
  const single = String(text ?? "").replace(/\s+/g, " ").trim();
  return single.length <= limit ? single : `${single.slice(0, limit)}…`;
}

/** 从参数对象里挑一个最有信息量的字段做展示。 */
function describeArgs(args: Record<string, unknown>): string {
  for (const key of ["path", "text", "query", "name"]) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) return `${key}=${value}`;
  }
  return preview(JSON.stringify(args), 60);
}

// --- 帮助文本 -------------------------------------------------------------

export const HELP = `
${bold("lish")} — 微内核 Agent 工具

${bold("用法")}
  lish                 启动 Web 服务（默认）
  lish web [--port N]  启动 Web UI（express + SSE）
  lish tui             启动终端 UI（ink）
  lish chat            启动极简文本聊天
  lish --help          显示本帮助

${bold("环境变量")}
  LLM_API_KEY          必需，API 密钥
  LLM_BASE_URL         默认 https://api.deepseek.com
  LLM_MODEL            默认 deepseek-chat
  LLISH_MAX_STEPS      默认 8
  PORT                 Web 端口，默认 3000
  LLISH_NO_PERSIST     设置后会话不写入磁盘
`.trimStart();

// --- 极简文本聊天（最小依赖，TUI 不可用时的降级选项）--------------------

/** 极简 readline 聊天界面，返回进程退出码。 */
export async function runChat(runtime: Runtime): Promise<number> {
  const { ctx, sessions, agent, config } = runtime;
  let current = sessions.create({ title: "cli session" });

  ctx.on(AGENT_TOOL_CALL, (p: { name: string; args: Record<string, unknown> }) => {
    console.log(dim(`  ↳ 调用 ${p.name}(${describeArgs(p.args)})`));
  });
  ctx.on(AGENT_TOOL_RESULT, (p: { isError: boolean; content: string }) => {
    const tag = p.isError ? red("    ✗") : green("    ✓");
    console.log(`${tag} ${dim(preview(p.content))}`);
  });
  ctx.on(AGENT_ANSWER, (p: { text: string }) => {
    if (p.text.trim().length > 0) console.log(cyan("助手> ") + p.text);
  });
  ctx.on(AGENT_ABORTED, (p: { stopReason: string; error?: string }) => {
    console.log(yellow(`  ! 循环提前结束：${p.stopReason}${p.error ? ` — ${p.error}` : ""}`));
  });

  console.log("");
  console.log(bold(" lish ") + dim("· 微内核 Agent CLI"));
  console.log(dim(`  模型：${config.model}   端点：${config.baseURL}`));
  console.log(dim(`  工作区：${config.workspaceRoot}`));
  console.log(dim(`  会话：${current.id}${config.sessionDir ? ` (${config.sessionDir})` : ""}`));
  console.log(dim("  输入 exit 或 quit 退出，输入 /help 查看命令"));
  console.log("");

  const rl = createInterface({ input, output });

  try {
    for (;;) {
      let line: string;
      try {
        line = await rl.question(cyan("> "));
      } catch {
        // stdin 关闭（例如管道输入结束）时视为正常退出。
        break;
      }

      const text = line.trim();
      if (text.length === 0) continue;

      if (text === "exit" || text === "quit" || text === ":q") {
        console.log(dim("再见。"));
        break;
      }

      if (text === "/help") {
        console.log(dim("  /help     显示帮助"));
        console.log(dim("  /history  查看当前会话的消息数"));
        console.log(dim("  /reset    开启新会话"));
        console.log(dim("  exit/quit 退出"));
        continue;
      }

      if (text === "/history") {
        console.log(
          dim(`  当前会话共 ${current.deriveMessages().length} 条消息，日志 ${current.length} 个事件。`),
        );
        continue;
      }

      if (text === "/reset") {
        current = sessions.create({ title: "cli session" });
        console.log(dim(`  已切换到新会话：${current.id}`));
        continue;
      }

      const started = Date.now();
      const result = await agent.run(current, text);
      const elapsed = Date.now() - started;

      console.log("");
      console.log(
        dim(
          `  — 用时 ${elapsed}ms，${result.steps.length} 步，` +
            `${result.toolCallsExecuted} 次工具调用，结束原因：${result.stopReason}`,
        ),
      );
      console.log("");
    }
  } finally {
    rl.close();
  }

  return 0;
}

// --- 子命令分发 -----------------------------------------------------------

export interface ParsedArgs {
  command: string;
  flags: Map<string, string | true>;
}

/** 解析 `lish <command> [--flag value]`；无子命令时默认 `web`。 */
export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string | true>();
  let command = "";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else if (command === "") {
      command = arg;
    }
  }

  return { command: command || "web", flags };
}

/** 从 flag 或环境变量解析端口。 */
export function resolvePort(
  flags: Map<string, string | true>,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = flags.get("port") ?? env.PORT;
  if (raw === undefined || raw === true) return 3000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new UsageError(`端口不合法：${String(raw)}`);
  }
  return port;
}

/**
 * 程序主入口。
 * 返回退出码而不直接调用 process.exit，便于测试复用。
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { command, flags } = parseArgs(argv);

  if (flags.has("help") || command === "help" || command === "-h") {
    process.stdout.write(HELP);
    return 0;
  }

  const known = new Set(["web", "tui", "chat", "serve", "start"]);
  if (!known.has(command)) {
    console.error(red(`未知子命令：${command}`));
    process.stdout.write(HELP);
    return 2;
  }

  let runtime: Runtime | undefined;
  try {
    const config = readConfig();

    if (command === "chat") {
      runtime = createRuntime(config);
      return await runChat(runtime);
    }

    if (command === "tui") {
      // 动态导入：不用 TUI 的用户无需加载 ink/react。
      const { runTui } = await import("./tui.js");
      runtime = createRuntime(config);
      return await runTui(runtime);
    }

    // web / serve / start：默认行为
    const port = resolvePort(flags);
    const { startServer } = await import("./server.js");
    runtime = createRuntime(config);
    return await startServer(runtime, { port });
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(red("配置错误：") + err.message);
      return 2;
    }
    console.error(red("运行失败：") + (err instanceof Error ? err.message : String(err)));
    if (process.env.LLISH_DEBUG && err instanceof Error && err.stack) {
      console.error(dim(err.stack));
    }
    return 1;
  } finally {
    await runtime?.shutdown();
  }
}

// --- 自执行：仅在作为 bin/脚本直接运行时触发，被 import 时不触发 ---------

const entry = process.argv[1] ?? "";
const isDirectRun = /[\\/]cli\.(ts|js)$/.test(entry);

if (isDirectRun) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err);
      process.exitCode = 1;
    },
  );
}
