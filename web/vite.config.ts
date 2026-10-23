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
    // 监听所有网卡，允许手机/平板通过局域网 IP 访问
    host: '0.0.0.0',
    port: 3081,
    strictPort: true,
    proxy: {
      // 前端一律请求同源 /api/*，由 Vite 代理到后端，
      // 避免硬编码 localhost 导致手机访问失败。
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
        // SSE/流式响应需要关闭代理缓冲
        configure: proxy => {
          proxy.on('proxyRes', proxyRes => {
            proxyRes.headers['cache-control'] = 'no-cache, no-transform'
          })
        },
      },
    },
  },
})
