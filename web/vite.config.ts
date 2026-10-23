import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        // Separate vendor chunk for React to allow caching
        manualChunks: {
          vendor: ['react', 'react-dom'],
        },
      },
    },
  },
  server: {
    // 与后端 CORS 白名单保持一致；显式绑 IPv4 避免只监听 ::1
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      // 开发期也可走同源代理，避免浏览器跨域限制
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
      },
    },
  },
})
