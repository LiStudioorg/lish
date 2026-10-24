/**
 * 确保 web/ 子项目依赖就绪（供 prepare 使用）。
 *
 * 设计要点（踩坑记录）：
 *   1. 不能在 prepare 里执行 `npm install`（不带 --prefix）——
 *      npm 在 git 安装期间会把包目录重命名，导致 EISDIR；
 *   2. 但 `npm install --prefix web` 是安全的：它只操作 web/node_modules，
 *      不触碰包根目录的 node_modules。
 *
 * 仅在缺失关键依赖时安装，避免重复耗时。
 */

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const web = join(root, "web");

const ready =
  existsSync(join(web, "node_modules", "next")) &&
  existsSync(join(web, "node_modules", "react"));

if (ready) {
  console.log("[ensure-web-deps] web 依赖已就绪");
} else {
  console.log("[ensure-web-deps] 安装 web 依赖（首次安装耗时较长）…");
  execFileSync(
    "npm",
    ["install", "--prefix", web, "--no-audit", "--no-fund", "--ignore-scripts"],
    { cwd: root, stdio: "inherit" },
  );
  console.log("[ensure-web-deps] 完成");
}
