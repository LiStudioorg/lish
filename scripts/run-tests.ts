/**
 * 统一测试入口。
 *
 * 串行运行全部套件，汇总结果并以正确的退出码结束：
 * 任何一个套件失败，整体即失败（fail-closed），便于 CI 直接使用。
 *
 * 每个套件都是一个独立子进程，互不干扰（各自有临时目录、独立 Context），
 * 因此串行执行不会因为共享状态而互相影响；同时输出顺序稳定、易于阅读。
 *
 * 运行方式：npm test
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(here, "..");

interface Suite {
  /** 显示的套件名，与 npm script 对应。 */
  name: string;
  /** 相对项目根的入口文件。 */
  file: string;
}

const suites: Suite[] = [
  { name: "kernel", file: "src/kernel/test.ts" },
  { name: "events", file: "src/kernel/test-events.ts" },
  { name: "core", file: "src/core/test-session-llm.ts" },
  { name: "agent", file: "src/core/test-agent.ts" },
  { name: "fs", file: "src/tools/test-fs.ts" },
  { name: "openai", file: "src/core/providers/test-openai.ts" },
  { name: "stream", file: "src/core/test-stream.ts" },
];

interface SuiteResult {
  name: string;
  ok: boolean;
  output: string;
  passed?: number;
  total?: number;
  durationMs: number;
}

/** 从套件输出里提取 `N/M tests passed` 这一行。 */
function parseCounts(output: string): { passed?: number; total?: number } {
  const match = output.match(/^(\d+)\/(\d+) tests passed$/m);
  if (!match) return {};
  return { passed: Number(match[1]), total: Number(match[2]) };
}

function runSuite(suite: Suite): Promise<SuiteResult> {
  const entry = join(projectRoot, suite.file);
  const started = Date.now();

  return new Promise((resolve) => {
    // 用当前 Node 进程直接执行 tsx 的入口，避免依赖 npx 的额外启动开销。
    const child = spawn(
      process.execPath,
      ["--import", "tsx", entry],
      {
        cwd: projectRoot,
        env: { ...process.env, NO_COLOR: process.env.NO_COLOR ?? "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let output = "";
    child.stdout.on("data", (chunk) => (output += String(chunk)));
    child.stderr.on("data", (chunk) => (output += String(chunk)));

    child.on("error", (err) => {
      resolve({
        name: suite.name,
        ok: false,
        output: `${output}\n无法启动子进程: ${err.message}`,
        durationMs: Date.now() - started,
      });
    });

    child.on("close", (code) => {
      const counts = parseCounts(output);
      resolve({
        name: suite.name,
        ok: code === 0,
        output,
        ...counts,
        durationMs: Date.now() - started,
      });
    });
  });
}

async function main(): Promise<void> {
  console.log(`运行 ${suites.length} 个测试套件...\n`);

  const results: SuiteResult[] = [];
  for (const suite of suites) {
    process.stdout.write(`▶ ${suite.name.padEnd(8)} `);
    const result = await runSuite(suite);
    results.push(result);

    const summary = result.ok
      ? `✓ ${result.passed ?? "?"}/${result.total ?? "?"} 通过 (${result.durationMs}ms)`
      : `✗ 失败 (${result.durationMs}ms)`;
    console.log(summary);

    // 失败时立刻把该套件的详细输出打出来，便于定位。
    if (!result.ok) {
      console.log(
        result.output
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .filter((line) => line.includes("✗") || line.startsWith("    ") || line.startsWith("Failed:"))
          .map((line) => `    ${line.trim()}`)
          .join("\n"),
      );
    }
  }

  const failed = results.filter((r) => !r.ok);
  const totalPassed = results.reduce((sum, r) => sum + (r.passed ?? 0), 0);
  const totalTests = results.reduce((sum, r) => sum + (r.total ?? 0), 0);

  console.log("");
  if (failed.length === 0) {
    console.log(`全部通过：${results.length} 个套件，${totalPassed}/${totalTests} 个用例。`);
    return;
  }

  console.log(
    `存在失败：${failed.map((f) => f.name).join(", ")}（${failed.length}/${results.length} 个套件）`,
  );
  console.log(`已通过 ${totalPassed}/${totalTests} 个用例。`);
  process.exitCode = 1;
}

void main();
