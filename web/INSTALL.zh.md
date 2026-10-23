- [English README](./README.md)
- [中文 README](./README.zh.md)
- [日本語 README](./README.ja.md)
- [한국어 README](./README.ko.md)
- [Installation guide](./INSTALL.md)
- [中文安装指南](./INSTALL.zh.md)
- [日本語インストールガイド](./INSTALL.ja.md)
- [한국어 설치 안내](./INSTALL.ko.md)
- [Changelog](./CHANGELOG.md)
- [日本語 changelog](./CHANGELOG.ja.md)
- [한국어 changelog](./CHANGELOG.ko.md)

# 安装指南

`dsh-transition-webui` 的前置要求、构建与质量保证命令。

## 前置要求

- [Node.js](https://nodejs.org/) >= 18
- npm（随 Node.js 安装）

## 快速开始

```bash
git clone https://github.com/drscrewdriver/dsh-transition-webui.git
cd dsh-transition-webui

npm install

npm run dev          # 开发服务器 → http://localhost:3081
npm run build        # 生产构建 → dist/
npm run preview      # 预览生产构建产物
```

`npm run dev` 会启动 Vite 开发服务器，用浏览器打开打印的地址即可。

## 质量保证

```bash
npm run lint            # ESLint 检查
npm run typecheck       # TypeScript 类型检查 (tsc --noEmit)
npm run test            # Vitest 单元测试 (jsdom)
npm run test:watch      # 监听模式运行测试
```

## 对接后端

见 [README.zh.md](./README.zh.md) 的「作为脚手架复用 / 对接后端」。将 `App.tsx` 中模拟的 `handleSend` 替换为对 Agent 后端（WS / HTTP / SSE）的真实调用；启动配置可通过 `window.__DASH_BOOT__` 注入。

## 排查

- **端口 3081 被占用** — 开发服务器使用 `strictPort`。释放端口，或修改 `vite.config.ts` 中的 `server.port`。
- **找不到 ESLint 命令** — 依赖可能未装全，重新执行 `npm install`。
- **测试找不到 `Button.test.tsx`** — 测试 glob 沿用 Vitest 默认；请确认 `vitest.config.ts` 存在。

## License

MIT（同 deepseek-harness）