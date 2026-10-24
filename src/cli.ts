#!/usr/bin/env node
/**
 * lish 命令行入口（全局 bin）。
 *
 * 用法：
 *   lish                     等价于 `lish web`
 *   lish web [选项]          启动 Web 服务（生产模式托管 web/dist）
 *   lish tui                 启动终端 UI（ink）
 *
 * Web 选项：
 *   -p, --port <number>   端口，默认 3000
 *   -H, --host <string>   监听地址，默认 0.0.0.0（允许局域网访问）
 *   --dev                 开发模式：不托管静态文件（由 Next.js dev server 提供）
 *
 * 环境变量：
 *   LLM_API_KEY        可选，API 密钥（缺省读 ~/.lish/config.json）
 *   LLM_BASE_URL       可选，默认 https://api.deepseek.com
 *   LLM_MODEL          可选，默认 deepseek-chat
 *   LISH_CONFIG_FILE   可选，覆盖配置文件路径（默认 ~/.lish/config.json）
 *   LLISH_MAX_STEPS    可选，单轮最大步数，默认 8
 *   LLISH_MOCK=1       使用 MockProvider，无需 API Key（演示/自测）
 *   LLISH_NO_PERSIST   设置后会话不落盘
 */

import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command, Option } from "commander";

import { createRuntime, readConfig, UsageError } from "./runtime.js";

// --- 终端颜色（非 TTY 或 NO_COLOR 时降级）---------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number, text: string) =>
  useColor ? `\u001b[${code}m${text}\u001b[0m` : text;
const dim = (t: string) => paint(2, t);
const yellow = (t: string) => paint(33, t);
const red = (t: string) => paint(31, t);
const bold = (t: string) => paint(1, t);

// --- 子命令实现 -----------------------------------------------------------

/** 解析并校验端口。 */
export function parsePort(raw: string | number): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new UsageError(`端口不合法：${String(raw)}（应为 0-65535 的整数）`);
  }
  return port;
}

/** `lish web`：启动 Web 服务。 */
async function runWeb(options: { port: string; host: string; dev?: boolean }): Promise<number> {
  const port = parsePort(options.port);
  const host = options.host;

  // 动态导入：只有用到 Web 时才加载 express 及其依赖
  const { startServer, resolveWebRoot } = await import("./server.js");
  const runtime = await createRuntime(readConfig());

  if (!options.dev) {
    const root = resolveWebRoot();
    if (!root) {
      console.warn(
        yellow("! 未找到前端构建产物（web/dist）。") +
          "\n  请先运行 " +
          bold("npm run build") +
          " 打包前端；或使用 " +
          bold("npm run start:dev") +
          " 进入开发模式。",
      );
    }
  }

  try {
    return await startServer(runtime, { port, host });
  } finally {
    await runtime.shutdown();
  }
}

/** `lish tui`：启动终端 UI。 */
async function runTuiCommand(): Promise<number> {
  if (!process.stdin.isTTY) {
    console.error(
      red("lish tui 需要交互式终端。") +
        "\n非 TTY 环境请改用 lish web。",
    );
    return 2;
  }
  const { runTui } = await import("./tui.js");
  const runtime = await createRuntime(readConfig());
  try {
    return await runTui(runtime);
  } finally {
    await runtime.shutdown();
  }
}

// --- 程序装配 -------------------------------------------------------------

/**
 * 读取 package.json 中的版本号。
 *
 * 不硬编码：发布新版本时只需改 package.json，
 * 避免 CLI 显示的版本与实际包版本不一致。
 * 从 dist/cli.js 出发向上查找 package.json（兼容源码与编译两种位置）。
 */
function readPackageVersion(): string {
  const start = dirname(fileURLToPath(import.meta.url));
  let dir = start;
  for (let depth = 0; depth < 6; depth++) {
    try {
      const raw = readFileSync(join(dir, "package.json"), "utf8");
      const pkg = JSON.parse(raw) as { version?: unknown };
      if (typeof pkg.version === "string" && pkg.version.length > 0) {
        return pkg.version;
      }
    } catch {
      // 本层没有 package.json，继续向上
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return "0.0.0";
}

/** 创建 commander 程序（导出以便测试）。 */
export function buildProgram(): Command {
  const program = new Command();

  program
    .name("lish")
    .description("微内核 Agent 工具：Web UI、终端 TUI 与文本聊天")
    .version(readPackageVersion())
    // 不带子命令时默认执行 web
    .action(async () => {
      await program.parseAsync(["node", "lish", "web"]);
    });

  program
    .command("web")
    .description("启动 Web 服务（生产模式托管 web/dist）")
    .option("-p, --port <number>", "监听端口", "3000")
    .option("-H, --host <string>", "监听地址", "0.0.0.0")
    .option("--dev", "开发模式（不托管静态文件）", false)
    // commander 默认把 -h 留给 help；这里只提供 -H，避免冲突
    .addOption(
      new Option("-v, --verbose", "输出更多日志").hideHelp(),
    )
    .action(async options => {
      process.exitCode = await runWeb({
        port: options.port,
        host: options.host,
        dev: options.dev,
      });
    });

  program
    .command("tui")
    .description("启动终端 UI（ink）")
    .action(async () => {
      process.exitCode = await runTuiCommand();
    });

  return program;
}

/** 程序入口；返回退出码。 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const program = buildProgram();
  try {
    await program.parseAsync(["node", "lish", ...argv]);
    return typeof process.exitCode === "number" ? process.exitCode : 0;
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(red("配置错误：") + err.message);
      return 2;
    }
    // commander 的参数错误已自行打印，这里只处理运行时异常
    if (err instanceof Error && err.name.startsWith("CommanderError")) {
      return 2;
    }
    console.error(red("运行失败：") + (err instanceof Error ? err.message : String(err)));
    if (process.env.LLISH_DEBUG && err instanceof Error && err.stack) {
      console.error(dim(err.stack));
    }
    return 1;
  }
}

/**
 * 判断是否作为可执行入口运行。
 *
 * 不能用文件名匹配（如 /cli\.js$/）：作为全局 bin 时，
 * argv[1] 是软链名（如 /usr/bin/lish），文件名并不是 cli.js。
 * 正确做法是解析软链后的真实路径再命名比较，
 * 这样 npm link / 全局安装 / tsx 直跑都能命中。
 */
function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  let real = entry;
  try {
    real = realpathSync(entry);
  } catch {
    // 解析失败时回退到原始路径
  }
  return /[\\/]cli\.(ts|js)$/.test(real) || /[\\/]lish$/.test(real);
}

if (isDirectRun()) {
  main().then(
    code => {
      process.exitCode = code;
    },
    err => {
      console.error(err);
      process.exitCode = 1;
    },
  );
}
