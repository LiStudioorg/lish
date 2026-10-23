import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // 显式绑定 127.0.0.1：Vite 默认可能只监听 IPv6 ::1，
    // 导致用 127.0.0.1 访问时连接被拒绝。
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      // 把 /api 转发到后端，避免开发期跨域；SSE 需要禁用缓冲。
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
