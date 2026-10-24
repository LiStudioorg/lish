import type { NextConfig } from "next";

/**
 * Next.js 配置。
 *
 * 关键约束：本项目要打包成单进程 CLI（由后端 express.static 托管），
 * 因此必须 `output: "export"` 生成纯静态文件到 web/out。
 * 这意味着：
 *   - 不能使用 SSR / 服务端数据获取
 *   - 不能使用 API Routes（所有接口都在后端 src/server.ts）
 *   - 所有交互组件必须标注 "use client"
 */
const nextConfig: NextConfig = {
  output: "export",
  // 静态导出时没有 Node 运行时做图片优化
  images: { unoptimized: true },
  // 导出 /path/index.html 形式，便于 express.static 直接命中
  trailingSlash: true,
  turbopack: {
    /*
     * 显式指定 workspace root。
     *
     * web/ 内没有 .git，而上层 /root/work/lish 有，
     * Turbopack 会以此把 root 判成上层目录，导致模块别名
     * （@/* 与相对路径）基于错误基准解析，报 "Module not found"。
     */
    root: __dirname,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
