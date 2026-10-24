/**
 * 把前端构建产物复制到 dist/web。
 *
 * 为什么需要这一步：
 *   npm 打包会尊重子目录的 .gitignore，而 web/.gitignore 含 `/out/`，
 *   导致 web/out 被排除，用户全局安装后前端 404 白屏。
 *   把产物复制进 dist/（已在 files 白名单内）即可稳定发布。
 */

import { cp, rm, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "web", "out");
const dest = join(root, "dist", "web");

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(join(src, "index.html")))) {
  console.error(`[build:assets] 未找到前端产物：${src}\n请先运行 npm run build:web`);
  process.exit(1);
}

await rm(dest, { recursive: true, force: true });
await cp(src, dest, { recursive: true });
console.log(`[build:assets] 已复制前端产物 → dist/web`);
