/**
 * 确保 web/ 子项目的依赖就绪。
 *
 * 背景：
 *   `prepare` 在 `npm install <git-url>` 期间执行，此时：
 *     - 根目录 devDependencies（typescript 等）可能尚未安装；
 *     - web/ 的依赖通常完全缺失。
 *   而在 prepare 内部再调用 `npm install` 会触发 npm 自身的目录重命名，
 *   导致 EISDIR 错误（rename node_modules/lish -> .lish-XXXX），
 *   因此这里只在**缺少关键依赖时**才执行安装，并跳过脚本钩子避免递归。
 */

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const web = join(root, "web");

const need = (p) => !existsSync(join(web, p));

// 关键依赖缺失才安装，避免每次 prepare 都耗时
if (need("node_modules/next") || need("node_modules/react")) {
  console.log("[ensure-web-deps] 安装 web 依赖…");
  execFileSync("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts"], {
    cwd: web,
    stdio: "inherit",
    env: { ...process.env, npm_config_ignore_scripts: "true" },
  });
} else {
  console.log("[ensure-web-deps] web 依赖已就绪");
}
