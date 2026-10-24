# lish

面向智能体应用的微内核基础设施。

- **微内核架构**：事件总线、依赖注入、LIFO 生命周期；核心只提供机制，不提供策略。
- **可插拔工具链**：文件系统沙箱、Shell 执行、可动态装卸的插件系统。
- **事件溯源会话**：append-only JSONL 为唯一真源，重启可完整恢复。
- **轨迹可观测**：每条事件携带 traceId、毫秒时间戳、耗时与 token 用量。
- **三种前端**：Web UI（Next.js 静态导出）、终端 TUI（ink）、极简文本聊天。

## 安装

> **包名说明**：本项目的 npm 包名为 `@listudioorg/lish`。
> 安装后命令行入口是 `lish`（不带 scope）。
> npm 上另有同名的第三方包 `lish`（LiveShell），请勿混淆。

### 前置要求

- Node.js **>= 22**（项目使用了 `AsyncLocalStorage`、原生 `fetch` 等特性）
- 可用内存 **>= 4GB**（从源码安装需构建 Next.js 前端）

### 1. 从 npm 全局安装

```bash
npm install -g @listudioorg/lish
```

### 2. 使用 pnpm 全局安装

```bash
pnpm add -g @listudioorg/lish
```

> pnpm 需要全局 bin 目录在 `PATH` 中。若提示
> `ERR_PNPM_GLOBAL_BIN_DIR_NOT_IN_PATH`，先执行一次 `pnpm setup`。

### 3. 使用 bun 全局安装

```bash
bun add -g @listudioorg/lish
```

### 4. 从源码安装

#### 4.1 本地源码目录

```bash
git clone https://github.com/LiStudioorg/lish.git
cd lish
npm install        # 自动触发 prepare：构建前端 + 编译后端
npm link           # 或 npm install -g .
```

也可直接全局安装源码目录（无需先进入目录）：

```bash
npm install -g /path/to/lish
```

#### 4.2 Git 仓库地址

```bash
npm install -g git+https://github.com/LiStudioorg/lish.git

# 或 SSH 形式
npm install -g git+ssh://git@github.com/LiStudioorg/lish.git
```

> **注意**：从 Git 源码构建需要下载大量依赖并执行 Next.js 编译，
> 请确保机器至少有 **4GB 可用内存**，首次安装可能耗时 **10-20 分钟**。
> 内存不足或并行安装多个包时容易触发 OOM，请串行执行。

#### 4.3 源码开发模式（不安装为全局命令）

```bash
npm run start:dev      # 后端 + Next.js 前端（开发模式）
npx tsx src/cli.ts web # 仅后端，托管已构建的前端产物
```

### 安装时的自动构建

`prepare` 脚本在从源码/Git 安装时自动执行以下步骤：

1. 安装 `web/` 子项目依赖（`npm install --prefix web`）
2. 构建前端静态资源（`next build` → `web/out`）
3. 编译后端 TypeScript（`tsc` → `dist/`）
4. 复制前端产物到 `dist/web`，确保随包发布

从 npm 安装已发布的包时不会触发（`dist/` 与 `dist/web/` 已随包提供）。

### 验证安装

```bash
lish --version          # 期望输出 0.1.0-alpha.1
lish web --port 3000    # 启动后用浏览器打开 http://localhost:3000
```

### 安装方式验证状态

| 安装方式 | 验证状态 | 说明 |
| --- | --- | --- |
| npm 本地源码目录 | ✅ 已实测 | `/tmp` 下启动，页面与 API 均正常 |
| pnpm 全局安装 | ✅ 已实测 | 同上 |
| bun 全局安装 | ✅ 已实测 | 同上 |
| Git 仓库地址 | ⚠️ 未完成端到端验证 | 流程与本地源码一致（多一步 clone），本机因内存限制未跑完 |
| npm 已发布包 | ⏳ 待发布 | 包名 `@listudioorg/lish` 已就绪，尚未执行 `npm publish` |

## 使用

```bash
# 启动 Web 服务（默认 0.0.0.0:3000，自动打印局域网地址）
lish web

# 指定端口与监听地址
lish web --port 3080 --host 0.0.0.0

# 终端 UI / 极简文本聊天
lish tui
lish chat
```

## 配置

通过环境变量提供模型凭据（推荐）：

```bash
export LLM_API_KEY="sk-..."                       # 必填
export LLM_BASE_URL="https://api.deepseek.com"    # 可选
export LLM_MODEL="deepseek-chat"                  # 可选
```

也可以启动后在界面「设置 → 模型」中填写并保存（热生效，无需重启）。
API Key 在接口返回中始终脱敏展示。

其他环境变量：

| 变量 | 说明 |
| --- | --- |
| `LLISH_MAX_STEPS` | 单轮 Agent 最大步数，默认 8 |
| `LLISH_NO_PERSIST` | 设置后会话不落盘 |
| `LLISH_MOCK=1` | 使用 MockProvider，无需 API Key |
| `LLISH_PLUGINS_DIR` | 插件目录，默认 `~/.lish/plugins` |
| `LISH_SETTINGS_FILE` | 配置文件路径，默认 `~/.lish/settings.json` |

## 插件

把 `.ts` 或 `.js` 文件直接放入 `~/.lish/plugins/`，导出 `apply(ctx)` 即可自动加载：

```ts
export function apply(ctx, config) {
  console.log("插件已加载");
}

export function dispose() {
  console.log("插件已卸载");
}
```

也支持 `<id>/patch.json` 声明式 Bundle（见 `examples/plugins/hello-world/`）。
插件热重载：修改文件后自动生效，或在「设置 → 插件管理」点击重载。

## 开发

```bash
npm run start:dev     # 后端 + Next.js 前端（开发模式）
npm test              # 全量测试
npm run lint          # ESLint
npx tsc --noEmit      # 类型检查
```

## 项目规范

工程准则与交付验收标准见 [AGENTS.md](AGENTS.md)。

## 许可证

本项目采用 **Apache License 2.0** 授权。

- 协议全文：[LICENSE](LICENSE)
- 官方链接：<https://www.apache.org/licenses/LICENSE-2.0>

```
Copyright 2026 lish contributors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```
