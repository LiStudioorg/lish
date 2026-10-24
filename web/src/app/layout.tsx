import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "lish",
  description: "lish · 微内核 Agent",
};

export const viewport: Viewport = {
  themeColor: "#151517",
  width: "device-width",
  initialScale: 1,
  // 移动端键盘弹出时不缩放
  maximumScale: 1,
};

/**
 * 根布局。
 *
 * 刻意不使用 next/font/google：构建阶段需要联网下载字体，
 * 而本项目要求可离线打包为单进程 CLI，因此直接使用系统字体栈
 * （已在 globals.css 的 --font-sans 中定义）。
 */
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="zh-CN" className="h-full antialiased">
      <body className="h-full">{children}</body>
    </html>
  );
}
