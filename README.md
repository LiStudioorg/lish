<div align="center">

# lish

**面向智能体应用的微内核基础设施**

事件溯源 · 插件热插拔 · 全链路可观测 · 路径沙箱

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](tsconfig.json)
[![Tests](https://img.shields.io/badge/tests-234%20passed-success.svg)]()
[![Version](https://img.shields.io/badge/version-0.1.0--alpha.2-orange.svg)](package.json)

</div>

---

## 目录

- [项目简介](#项目简介)
- [核心特性](#核心特性)
- [系统架构](#系统架构)
- [环境要求](#环境要求)
- [安装](#安装)
- [快速开始](#快速开始)
- [命令参考](#命令参考)
- [配置](#配置)
- [HTTP API](#http-api)（完整契约见 [`docs/API.md`](./docs/API.md)）
- [插件开发](#插件开发)
- [子智能体](#子智能体)
- [可观测性](#可观测性)
- [安全模型](#安全模型)
- [开发指南](#开发指南)
- [项目结构](#项目结构)
- [常见问题](#常见问题)
- [故障排查](#故障排查)
- [贡献指南](#贡献指南)
- [许可证](#许可证)

---

## 项目简介

`lish` 是一个面向智能体（Agent）应用的基础设施层。它把「会话状态、模型调用、工具执行、插件扩展」四件事拆解为可组合的内核能力，并在其上提供三种前端形态（Web / TUI / CLI）。

设计上遵循**微内核的开闭原则**：内核只提供机制（事件总线、依赖注入、生命周期管理），所有业务策略都以插件或工具形式注册，因此新增能力无需改动核心循环。

### 适用场景

| 场景 | 说明 |
| --- | --- |
| 自建编码助手 | 基于工作区文件读写与 Shell 执行构建本地开发助手 |
| 多智能体编排 | 使用 `spawn_agent` 拆分并行子任务 |
| 可审计的 Agent 平台 | 每条事件带 `traceId`、耗时与 token 用量，支持事后回溯 |
| Agent 框架学习 | 内核模块边界清晰，易于阅读与二次开发 |

---

## 核心特性

### 微内核架构

- **事件总线**：五种派发语义（`emit` / `parallel` / `serial` / `waterfall` / `bail`），支持中间件式拦截与短路。
- **依赖注入**：`Context` 提供 `provide` / `resolve` / `effect` / `scope`，插件可声明依赖，缺失时拒绝装载（fail-closed）。
- **LIFO 生命周期**：所有清理函数按注册逆序执行，插件热插拔时副作用 100% 回收。

### 事件溯源会话

- 会话的唯一真源是 **append-only JSONL 日志**，重启后完整恢复。
- 派生的消息列表通过对日志 fold 计算得出，不做就地修改，投影可随时重建。

### 可插拔工具链

- 文件系统工具（`fs.read` / `fs.write`）受**双重路径校验**保护。
- Shell 执行工具（`shell.run`）带超时强制终止。
- 插件系统支持 Patch 声明式配置、目录扫描式动态加载、文件变更热重载。

### 全链路可观测

- 每个轨迹事件携带 `traceId`、毫秒时间戳、`duration`、`tokenUsage`。
- Web UI 提供「轨迹」面板：微型耗时条形图 + 虚拟化时间轴 + 五维详情（概述 / 参数 / 结果 / Schema / 计时）。

### 多形态前端

| 形态 | 启动方式 | 说明 |
| --- | --- | --- |
| Web UI | `lish web` | Next.js 静态导出，三栏可拖拽布局，支持移动端 |
| TUI | `lish tui` | 基于 ink 的终端界面 |

---

## 系统架构

```
┌──────────────────────────────────────────────────────────┐
│                     前端层（可替换）                       │
│      Web UI (Next.js)    TUI (ink)    CLI (readline)     │
└───────────────────────────┬──────────────────────────────┘
                            │ HTTP / SSE
┌───────────────────────────┴──────────────────────────────┐
│                    服务层（src/server.ts）                 │
│   /api/chat  /api/config  /api/files  /api/exec  ...      │
└───────────────────────────┬──────────────────────────────┘
                            │
┌───────────────────────────┴──────────────────────────────┐
│                     内核层（微内核）                       │
│  ┌────────────┐  ┌────────────┐  ┌────────────────────┐  │
│  │  Context   │  │ EventBus   │  │  Plugin Loader     │  │
│  │  依赖注入   │  │ 五种派发    │  │  Patch + HMR       │  │
│  └────────────┘  └────────────┘  └────────────────────┘  │
└───────────────────────────┬──────────────────────────────┘
                            │
┌───────────────────────────┴──────────────────────────────┐
│                     核心能力层（src/core）                 │
│  AgentLoop │ LlmRuntime │ Session │ ToolRegistry │ Trace │
└───────────────────────────┬──────────────────────────────┘
                            │
┌───────────────────────────┴──────────────────────────────┐
│                     工具与适配层                           │
│   fs.read/write │ shell.run │ OpenAI Provider │ Mock     │
└──────────────────────────────────────────────────────────┘
```

### 一次对话的数据流

```
用户输入
   │
   ▼
Session.appendUserMessage()          ← 日志先行（事件溯源）
   │
   ▼
AgentLoop.run()
   │  ① deriveMessages() 从日志折叠出消息列表
   │  ② LlmRuntime.generate() 调用模型
   │  ③ 若返回 tool_calls → ToolRegistry.executeTool()
   │      └─ tools/pre-execute → handler → tools/post-execute
   │  ④ 工具结果写回 Session，循环直到无 tool_calls
   ▼
每个步骤同时写入 TraceStore（traceId + 耗时 + tokenUsage）
   │
   ▼
SSE 推送：`0:` 文本帧（打字机） + `2:` 数据帧（工具事件）
```

---

## 环境要求

| 项 | 最低要求 | 说明 |
| --- | --- | --- |
| Node.js | **>= 22** | 依赖原生 `fetch`、`AsyncLocalStorage`、稳定 ESM |
| 内存 | **>= 4 GB** | 从源码安装需构建 Next.js 前端 |
| 磁盘 | >= 1 GB | 含 node_modules |
| 操作系统 | Linux / macOS / Windows | 已在 Linux 验证 |

> Node 22 是硬性下限：内核使用 `AsyncLocalStorage` 隔离子代理深度，
> 网络层使用全局 `fetch`。低版本会直接启动失败。

---

## 安装

> **包名说明**：本项目的 npm 包名为 **`@listudioorg/lish`**，安装后命令为 **`lish`**。
> npm 上另有一个同名的第三方包 `lish`（LiveShell），**与本项目无关**，请勿混淆。

### 方式一：从 npm 全局安装

```bash
npm install -g @listudioorg/lish
```

### 方式二：使用 pnpm

```bash
pnpm add -g @listudioorg/lish
```

> 若提示 `ERR_PNPM_GLOBAL_BIN_DIR_NOT_IN_PATH`，先执行一次 `pnpm setup` 配置全局 bin 目录。

### 方式三：使用 bun

```bash
bun add -g @listudioorg/lish
```

### 方式四：从源码安装

#### 4.1 本地源码目录

```bash
git clone https://github.com/LiStudioorg/lish.git
cd lish
npm install          # 自动触发 prepare：构建前端 + 编译后端
npm link             # 链接为全局命令
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

> ⚠️ **资源警告**：从 Git 源码构建需下载 300+ 依赖并执行 Next.js 编译，
> 请确保机器至少有 **4 GB 可用内存**，首次安装可能耗时 **10-20 分钟**。
> 内存不足或并行安装多个包时容易触发 OOM，请**串行执行**。

#### 4.3 开发模式（不安装为全局命令）

```bash
npm run start:dev      # 后端 + Next.js 前端（热更新）
npx tsx src/cli.ts web # 仅后端，托管已构建的前端产物
```

### 安装时的自动构建

从源码或 Git 安装时，`prepare` 脚本会自动执行：

1. 安装 `web/` 子项目依赖（`npm install --prefix web`）
2. 构建前端静态资源（`next build` → `web/out`）
3. 编译后端 TypeScript（`tsc` → `dist/`）
4. 复制前端产物到 `dist/web`，确保随包发布

从 npm 安装已发布的包时不会触发（产物已随包提供）。

### 验证安装

```bash
lish --version                          # 期望输出 0.1.0-alpha.2
lish web --port 3000                    # 启动服务
curl http://localhost:3000/api/health   # 期望返回 {"ok":true,...}
```

### 安装方式验证状态

| 安装方式 | 状态 | 说明 |
| --- | --- | --- |
| **npm 已发布包** | ✅ **已发布并实测** | `@listudioorg/lish@0.1.0-alpha.2`，从官方源安装后启动正常 |
| npm 本地源码目录 | ✅ 已实测 | 在 `/tmp` 下启动，页面与 API 均正常 |
| pnpm 全局安装 | ✅ 已实测 | 同上 |
| bun 全局安装 | ✅ 已实测 | 同上 |
| Git 仓库地址 | ⚠️ 未端到端验证 | 流程与本地源码一致，本机因内存限制未跑完 |

> 已发布版本：`0.1.0-alpha.2`（`latest`）。查看全部版本：
> `npm view @listudioorg/lish versions`

---

## 快速开始

### 1. 配置模型凭据（两种方式，任选其一）

**方式 A：界面内配置（推荐）** —— 直接启动，然后在「设置 → 模型 → 添加提供商」中填写
Base URL / API Key，点「获取可用模型」选择模型即可。配置保存在 `~/.lish/config.json`，
下次启动自动生效。

**方式 B：环境变量**

```bash
export LLM_API_KEY="sk-..."                       # 可选
export LLM_BASE_URL="https://api.deepseek.com"    # 可选，默认值
export LLM_MODEL="deepseek-chat"                  # 可选，默认值
```

> 优先级：环境变量 > `~/.lish/config.json` > 内置默认值。
> **没有 Key 也能启动**，界面顶部会提示你去设置里补齐。

### 2. 启动

```bash
lish web --port 3000
```

启动日志会打印本机与局域网访问地址：

```
  lish web 已启动
  本机访问:   http://localhost:3000
  健康检查:   http://localhost:3000/api/health
  模型:       deepseek-chat
  局域网访问: http://192.168.1.166:3000
  静态资源:   /path/to/dist/web
```

### 3. 开始对话

浏览器打开对应地址，在输入框发送消息即可。支持：

- `Enter` 发送，`Shift + Enter` 换行
- `Ctrl/Cmd + K` 聚焦输入框
- 左侧「新会话」创建新对话
- 顶部「轨迹」查看该轮全部事件与耗时

### 无网络快速体验

```bash
LLISH_MOCK=1 lish web --port 3000
```

Mock 模式不需要 API Key，会模拟模型返回并演示工具调用，适合本地验证链路。

---

## 命令参考

```
lish [命令] [选项]

命令：
  web [options]   启动 Web 服务（默认命令）
  tui             启动终端 UI（ink）

web 选项：
  -p, --port <number>   监听端口（默认 3000）
  -H, --host <string>   监听地址（默认 0.0.0.0）
  --dev                 开发模式（不托管静态文件）

全局选项：
  -V, --version   显示版本
  -h, --help      显示帮助
```

**示例**

```bash
lish                              # 等价于 lish web
lish web -p 8080 -H 127.0.0.1     # 仅本机访问的 8080 端口
lish tui                          # 终端界面
```

---

## 配置

### 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `LLM_API_KEY` | 无（可选） | 模型 API 密钥；缺省时读 `~/.lish/config.json` |
| `LLM_BASE_URL` | `https://api.deepseek.com` | OpenAI 兼容接口地址 |
| `LLM_MODEL` | `deepseek-chat` | 模型名称 |
| `LLISH_MAX_STEPS` | `8` | 单轮 Agent 最大步数 |
| `LLISH_MOCK` | 未设置 | 设为 `1` 启用 Mock 模式（无需 Key） |
| `LLISH_NO_PERSIST` | 未设置 | 设置后会话不落盘 |
| `LLISH_PLUGINS_DIR` | `~/.lish/plugins` | 插件目录 |
| `LISH_SETTINGS_FILE` | `~/.lish/settings.json` | 应用配置文件路径 |
| `LISH_CONFIG_FILE` | `~/.lish/config.json` | 模型提供商配置文件路径 |
| `LISH_LOAD_EXAMPLE_PLUGIN` | 未设置 | 设为 `1` 加载仓库内示例插件 |
| `LLISH_DEBUG` | 未设置 | 设为 `1` 输出完整错误堆栈 |
| `PORT` | `3000` | 默认端口（`--port` 优先） |
| `HOST` | `0.0.0.0` | 默认监听地址（`--host` 优先） |
| `NO_COLOR` | 未设置 | 设置后禁用终端颜色 |

### 运行时配置（界面内）

启动后可在「设置」中调整，**保存即热生效，无需重启**：

| 分类 | 可配置项 |
| --- | --- |
| 模型提供商 | **可添加任意多个**（DeepSeek / OpenAI / Ollama / 中转网关…）：名称、Base URL、API Key、模型；一键「获取可用模型」；点击圆点切换启用 |
| 通用 | 权限模式（工作区内 / 完全权限）、主题、字号 |
| 内置插件 | 文件系统、终端执行、回显工具、会话日志 |
| Agent 预设 | 标准 / 极简 / 创造 |
| 插件管理 | 查看已加载插件、热重载 |

> 运行时参数「最大步数」在「模型」页底部单独保存，不属于任何提供商。

#### 配置优先级

```
环境变量 (LLM_API_KEY / LLM_BASE_URL / LLM_MODEL)
        ↓ 覆盖
~/.lish/config.json 中「当前激活的提供商」
        ↓ 覆盖
内置默认值 (https://api.deepseek.com · deepseek-chat · maxSteps 8)
```

环境变量为空串或纯空白时**不**遮蔽配置文件。配置文件权限固定 `0600`（含明文密钥）。

> **无 Key 也能启动**：`lish web` / `lish tui` 在没有 API Key 时会打印警告并继续启动，
> 前端在输入框上方显示红色横幅，引导用户到【设置】中补齐。

> API Key 在接口返回中**永久脱敏**（形如 `sk-…abcd`），前端只显示脱敏值与是否已配置。

---

## HTTP API

服务默认监听 `0.0.0.0:3000`。

> **接口风格：RPC over HTTPS（全 POST）**。所有 `/api/*` 端点统一使用 `POST`，
> 动作写在路径上、参数放在 JSON 请求体里；只有 `/` 静态页面走 `GET`。
> 这与模型工具调用（工具名 + JSON 参数）的心智模型一致，也让网关只需放行一种方法。
>
> 完整字段、错误码、数据结构与兼容策略见 **[`docs/API.md`](./docs/API.md)**。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/health` | 健康检查，返回模型、工作区、工具列表 |
| `POST` | `/api/chat` | 对话主接口，返回 SSE 流 |
| `POST` | `/api/config/get` | 读取 LLM 与应用配置（密钥已脱敏） |
| `POST` | `/api/config` | 更新配置（热生效并落盘） |
| `POST` | `/api/providers/list` | 列出全部模型提供商（密钥已脱敏） |
| `POST` | `/api/providers` | 新增 / 更新提供商（带 `id` 即更新） |
| `POST` | `/api/providers/delete` | 删除提供商 |
| `POST` | `/api/providers/activate` | 切换激活的提供商（热生效） |
| `POST` | `/api/models` | 拉取上游可用模型列表（失败由前端降级为手填） |
| `POST` | `/api/files` | 工作区文件树（限深 3 层，忽略 node_modules 等） |
| `POST` | `/api/files/content` | 读取单个文件内容（body: `{ "path": "..." }`） |
| `POST` | `/api/exec` | 执行 Shell 命令（5 秒超时） |
| `POST` | `/api/session/events` | 会话轨迹事件（body: `{ "sessionId": "..." }`） |
| `POST` | `/api/plugins` | 已加载插件列表 |
| `POST` | `/api/plugins/reload` | 热重载插件（可指定 id） |
| `POST` | `/api/subagents` | 子代理记录与运行中数量 |

### SSE 协议说明

`POST /api/chat` 返回 AI SDK 数据流协议，逐行解析：

| 帧前缀 | 含义 |
| --- | --- |
| `0:` | 文本增量帧（用于打字机效果） |
| `2:` | 数据帧（工具事件、会话信息、完成标记） |

示例：

```
2:[{"type":"session","sessionId":"sess_xxx"}]
2:[{"type":"thinking","step":1,"messageCount":1}]
2:[{"type":"tool_call","name":"fs.read","argsJson":"{\"path\":\"a.txt\"}"}]
0:"文件内容是"
0:"：hello"
2:[{"type":"done","stopReason":"stop"}]
```

### 请求示例

```bash
# 对话
curl -N -X POST http://localhost:3000/api/chat \
  -H 'content-type: application/json' \
  -d '{"message":"读取 package.json 并告诉我项目名"}'

# 新增一个提供商
curl -X POST http://localhost:3000/api/providers \
  -H 'content-type: application/json' \
  -d '{"name":"DeepSeek","baseURL":"https://api.deepseek.com","apiKey":"sk-...","model":"deepseek-chat"}'

# 拉取可用模型
curl -X POST http://localhost:3000/api/models \
  -H 'content-type: application/json' -d '{}'

# 查看轨迹
curl -X POST http://localhost:3000/api/session/events \
  -H 'content-type: application/json' -d '{"sessionId":"s_xxx"}'
```

---

## 插件开发

插件可以：

- 注册新服务到内核（`ctx.provide`）
- 向工具注册表添加工具（供模型调用）
- 订阅内核事件
- 借助 `Context.scope()` 保证卸载时副作用被回收

### 方式一：目录直投（最简单）

把文件放入 `~/.lish/plugins/`，导出 `apply` 即可：

```ts
// ~/.lish/plugins/hello-world.ts
export function apply(ctx, config) {
  console.log("插件已加载");
  ctx.provide("hello-world", { loadedAt: Date.now() });
}

export function dispose() {
  console.log("插件已卸载");
}
```

支持 `.ts` / `.mts` / `.js` / `.mjs`；忽略 `.d.ts` 与 `_` 前缀文件。
插件 id 取文件名（`hello-world.ts` → `hello-world`）。

### 方式二：Bundle + Patch（声明式）

适合需要版本管理、默认配置的多插件包：

```
my-bundle/
├── package.json      # 含 "lish": { "bundle": { "patch": "./patch.json" } }
├── patch.json
└── index.ts
```

`patch.json` 示例：

```json
{
  "name": "my-bundle",
  "operations": [
    {
      "op": "insert",
      "row": {
        "id": "hello-world",
        "module": "./index.ts",
        "name": "Hello World",
        "version": "1.0.0",
        "enabled": true,
        "config": { "greeting": "你好" }
      }
    }
  ]
}
```

支持的操作：`insert`（插入）、`replace`（按 id 整体替换）、`remove`（删除）。

### 热重载

- 修改 `~/.lish/plugins/` 下的文件会自动重载对应插件（去抖 300ms）。
- 也可在「设置 → 插件管理」点击「重载」手动触发。

### 完整示例

见仓库 [`examples/plugins/hello-world/`](examples/plugins/hello-world)。

---

## 子智能体

通过 `spawn_agent` 工具可派生子代理完成独立子任务。

### 设计要点

- **继承而非新建**：子代理复用父级的 `LlmRuntime` 与 `ToolRegistry`，因此工具权限、插件开关自动继承，不存在越权。
- **深度限制**：默认最大嵌套 2 层，使用 `AsyncLocalStorage` 隔离计数，支持并发派生互不干扰。
- **独立轨迹**：子代理拥有独立 `Session` 与 `traceId`，可在轨迹面板单独查看。

### 调用示例

模型会自动调用该工具，也可手动触发：

```ts
await tools.executeTool("spawn_agent", {
  role: "你是资深代码审查专家",
  task: "检查 src/kernel/context.ts 是否有内存泄漏风险",
});
```

返回结构：

```json
{
  "agentId": "sub-xxx",
  "status": "done",
  "sessionId": "sess_xxx",
  "steps": 2,
  "toolCalls": 1,
  "result": "……"
}
```

---

## 可观测性

### 轨迹事件

每次运行产生完整事件序列：

```
run.start → step.thinking → tool.call → tool.result → … → answer → run.end
```

每条事件包含：

| 字段 | 说明 |
| --- | --- |
| `traceId` | 贯穿一次运行的链路标识 |
| `timestamp` | 毫秒级时间戳 |
| `duration` | 该步骤真实耗时 |
| `tokenUsage` | 输入/输出 token、首 token 延迟、tok/s |

### 持久化

轨迹事件同步写入会话的 append-only JSONL（`type: "trace.event"`），
进程重启后通过 `GET /api/session/:id/events` 仍可拉取历史轨迹。

### 前端轨迹面板

- 左侧：微型耗时条形图（按真实 duration 渲染）+ 虚拟化事件时间轴（支持 1000+ 事件）
- 右侧：五维详情（概述 / 参数 / 结果 / Schema / 计时）
- 子代理分组：可切换查看各子代理的独立轨迹

---

## 安全模型

### 路径沙箱

所有文件读写经过**双重校验**：

1. `path.resolve` 做字面归一化，拦截 `../` 穿越
2. `realpath` 校验真实路径，拦截**符号链接**绕过

仅当权限模式设为「完全权限」时才允许跨工作区访问（默认关闭）。

### Shell 执行

- 5 秒超时强制终止（含子进程组）
- 输出长度上限 64KB
- 前端对 `rm`、`sudo` 等危险命令二次确认
- 可通过插件开关全局禁用

### 密钥保护

- 接口返回的 `apiKey` 永久脱敏
- 轨迹面板渲染前对可能出现的密钥做正则脱敏
- 全链路禁止明文写入日志或事件载荷

### 内容安全

- 模型返回内容以纯文本 / JSON 文本渲染，**不使用 `dangerouslySetInnerHTML`**
- 渲染异常由 Error Boundary 捕获并降级，不白屏

### CORS

默认仅允许本机与局域网私有网段（10.x / 192.168.x / 172.16-31.x）访问，
其他来源一律拒绝。

---

## 开发指南

### 常用命令

```bash
npm run build          # 完整构建（前端 + 后端 + 资源复制）
npm run build:web      # 仅构建前端
npm run build:cli      # 仅编译后端
npm run start:dev      # 开发模式（后端 + 前端热更新）
npm test               # 全量测试
npm run lint           # ESLint
npx tsc --noEmit       # 类型检查
```

### 测试套件

| 套件 | 覆盖内容 | 用例数 |
| --- | --- | --- |
| `test:kernel` | 依赖注入、LIFO 销毁、插件加载 | 17 |
| `test:events` | 五种派发语义、监听器生命周期 | 40 |
| `test:core` | 会话日志、LLM 接缝、Provider 热切换 | 29 |
| `test:agent` | 工具管线、Agent 循环、循环保护 | 39 |
| `test:fs` | 路径沙箱、越界拦截、符号链接防护 | 18 |
| `test:openai` | OpenAI 协议转换、流式解析、错误分类 | 27 |
| `test:stream` | SSE 流式、工具事件、断连清理 | 26 |
| `test:plugins` | Patch 合并、Loader 生命周期、热更新 | 17 |
| `test:trace` | 轨迹字段完整性、持久化、会话隔离 | 10 |
| `test:subagent` | 子代理派生、深度保护、并发隔离 | 11 |
| **合计** | | **234** |

```bash
npm test              # 运行全部
npm run test:kernel   # 运行单个套件
```

### 提交前检查（强制）

```bash
npx tsc --noEmit                       # 后端类型检查
cd web && npx tsc --noEmit && cd ..    # 前端类型检查
npm run lint                           # ESLint
npm test                               # 全量测试
```

### 代码规范

详见 [AGENTS.md](AGENTS.md)，核心约束：

- 严格 TypeScript，**禁止 `any`**（必要时用 `unknown` + 类型收窄）
- 提交信息遵循 Angular 规范：`feat:` / `fix:` / `refactor:` / `test:` / `docs:` / `chore:`
- 新增能力须通过插件注册，不在核心循环中硬编码业务逻辑

---

## 项目结构

```
lish/
├── src/                          # 后端
│   ├── kernel/                   # 微内核
│   │   ├── context.ts            # 依赖注入、LIFO 生命周期、作用域回滚
│   │   ├── events.ts             # 事件总线（五种派发语义）
│   │   └── plugin.ts             # 插件接口与加载器
│   ├── core/                     # 核心能力
│   │   ├── agent-loop.ts         # Agent 循环 + 轨迹埋点
│   │   ├── llm.ts                # LLM 接缝与 Mock Provider
│   │   ├── session.ts            # 事件溯源会话
│   │   ├── sessions.ts           # 会话注册表与磁盘恢复
│   │   ├── tools.ts              # 工具注册表与拦截管线
│   │   ├── trace.ts              # 轨迹事件模型
│   │   ├── sub-agent.ts          # 子智能体与深度隔离
│   │   ├── settings.ts           # 持久化配置
│   │   ├── plugins/              # Patch / Loader / HMR / 目录扫描
│   │   └── providers/openai.ts   # OpenAI 兼容 Provider
│   ├── tools/                    # 工具实现
│   │   ├── fs.ts                 # 文件读写（路径沙箱）
│   │   ├── shell.ts              # Shell 执行（超时控制）
│   │   └── file-tree.ts          # 文件树读取
│   ├── runtime.ts                # 运行时装配
│   ├── server.ts                 # HTTP 服务
│   ├── cli.ts                    # 命令行入口
│   └── tui.tsx                   # 终端 UI
├── web/                          # 前端（Next.js 静态导出）
│   └── src/
│       ├── app/                  # 页面与全局样式
│       ├── ui/                   # 组件（轨迹面板、设置、文件树、ErrorBoundary）
│       └── lib/api.ts            # 后端接口客户端
├── scripts/                      # 构建脚本
├── examples/plugins/             # 插件示例
├── AGENTS.md                     # 工程准则与交付标准
├── LICENSE                       # Apache-2.0
└── README.md
```

---

## 常见问题

**Q：`lish --version` 输出为空或报错？**
A：确认 Node 版本 `>= 22`；若通过 `npm link` 安装，确认 `dist/cli.js` 存在且可执行。

**Q：浏览器打开是空白页 / 404？**
A：检查启动日志中的「静态资源」路径是否指向存在的目录。若显示「未找到」，执行 `npm run build` 重新构建。

**Q：手机访问不了？**
A：确认服务监听 `0.0.0.0`（默认），并使用启动日志打印的「局域网访问」地址；检查防火墙是否放行端口。

**Q：提示「缺少环境变量 LLM_API_KEY」？**
A：设置该变量，或使用 `LLISH_MOCK=1` 进入 Mock 模式，或在界面「设置 → 模型」中填写。

**Q：模型调用报 401 / 403？**
A：密钥无效或过期。注意 401/403 **不会**自动回退到非流式，需先修正凭据。

**Q：插件放进 `~/.lish/plugins/` 却没有加载？**
A：检查文件是否导出 `apply` 函数；查看启动日志的插件加载结果；或在「设置 → 插件管理」点击重载。

**Q：端口被占用？**
A：换端口 `lish web -p 3001`，或先停止占用进程。

---

## 故障排查

### 开启详细日志

```bash
LLISH_DEBUG=1 lish web
```

错误时会额外输出完整堆栈。

### 检查健康状态

```bash
curl http://localhost:3000/api/health
```

返回示例：

```json
{
  "ok": true,
  "model": "deepseek-chat",
  "workspace": "/path/to/workspace",
  "sessions": 1,
  "tools": ["fs.read", "fs.write", "shell.run", "spawn_agent"]
}
```

### 检查插件加载

```bash
curl http://localhost:3000/api/plugins
```

状态释义：

| 状态 | 含义 |
| --- | --- |
| `loaded` | 已加载并生效 |
| `disabled` | 配置中禁用 |
| `error` | 加载或执行失败（含错误信息） |

### 检查会话日志

会话日志位于 `~/.lish/sessions/<id>.jsonl`：

```bash
tail -f ~/.lish/sessions/*.jsonl
```

> 设置 `LLISH_NO_PERSIST=1` 时日志仅在内存中，不落盘。

---

## 贡献指南

1. Fork 仓库并创建特性分支：`git checkout -b feat/your-feature`
2. 遵守 [AGENTS.md](AGENTS.md) 中的工程准则
3. 提交前确保以下全部通过：

   ```bash
   npx tsc --noEmit
   cd web && npx tsc --noEmit && cd ..
   npm run lint
   npm test
   ```

4. 提交信息遵循 Angular 规范
5. 提交 Pull Request，说明变更动机与验证方式

---

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
