/**
 * 确保根目录构建依赖（typescript、tsx）就绪。
 *
 * 同样避免在 prepare 中直接跑 `npm install`（会触发 EISDIR），
 * 仅在缺少 tsc 时安装一次。
 */

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

if (!existsSync(join(root, "node_modules", "typescript"))) {
  console.log("[ensure-root-deps] 安装构建依赖…");
  execFileSync(
    "npm",
    ["install", "--no-audit", "--no-fund", "--ignore-scripts", "--no-save"],
    { cwd: root, stdio: "inherit" },
  );
} else {
  console.log("[ensure-root-deps] 构建依赖已就绪");
}
