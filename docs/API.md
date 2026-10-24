# lish HTTP API 参考

> 版本：`0.1.0-alpha.3`　·　协议：HTTP/1.1 + SSE　·　默认地址：`http://127.0.0.1:3000`
>
> 本文档是 lish Web 服务端的**对外契约**。任何字段的新增、删除、语义变更都必须同步更新本文，
> 并在 `CHANGELOG` 中标注是否为破坏性变更（Breaking Change）。

---

## 目录

1. [通用约定](#1-通用约定)
2. [错误模型](#2-错误模型)
3. [端点总览](#3-端点总览)
4. [运行状态](#4-运行状态)
5. [模型提供商](#5-模型提供商)
6. [模型列表](#6-模型列表)
7. [应用配置](#7-应用配置)
8. [对话（SSE 流式）](#8-对话sse-流式)
9. [会话轨迹](#9-会话轨迹)
10. [文件系统](#10-文件系统)
11. [命令执行](#11-命令执行)
12. [插件](#12-插件)
13. [子智能体](#13-子智能体)
14. [数据结构附录](#14-数据结构附录)
15. [版本与兼容策略](#15-版本与兼容策略)

---

## 1. 通用约定

### 1.1 基础地址

服务由 `lish web` 启动，默认监听 `0.0.0.0:3000`。可通过启动参数调整：

```bash
lish web -p 8080 -H 127.0.0.1        # 端口与监听地址
LISH_CONFIG_FILE=/tmp/c.json lish web # 覆盖配置文件路径
```

前端（静态导出的 Next.js 页面）与 API **同源**，因此浏览器端无需处理 CORS。
若单独部署前端，服务端已内置 `cors` 中间件。

### 1.2 接口风格：RPC over HTTPS（全 POST）

lish 的 HTTP 接口**不是** RESTful 资源设计，而是 **RPC 风格**：
所有 `/api/*` 端点统一使用 `POST`，**动作名写在路径上，参数放在 JSON 请求体里**。

| 方法 | 用途 |
| --- | --- |
| `POST` | 所有 API 调用（读与写一视同仁） |
| `GET` | 仅用于返回静态页面 `/` |

**为什么不做 GET/PUT/DELETE 的区分**

1. **贴合 Agent 工具调用协议**：模型工具调用本质是「工具名 + JSON 参数」，
   MCP（Model Context Protocol）/ JSON-RPC 2.0 也都是单端点 + 方法名 + 参数体的形态。
   本项目的 API 与内部工具调用保持同构，前端、插件、外部程序可以用同一套心智模型调用。
2. **代理与网关零特判**：企业防火墙、反向代理、前端请求封装通常只放行 GET/POST，
   `PATCH`/`DELETE` 常被拦截或需要额外白名单。
3. **参数不受 URL 限制**：模型名、Base URL、命令文本等放进 body，避免了查询串长度与转义问题。
4. **幂等性由业务保证**，而不是靠 HTTP 方法：删除不存在的 id、重复激活同一提供商，
   结果都一致且安全。

因此**不存在** `PUT` / `PATCH` / `DELETE`，动作差异完全由路径表达：

| 动作 | 端点 | 请求体 |
| --- | --- | --- |
| 读取配置 | `POST /api/config/get` | `{}` |
| 更新配置 | `POST /api/config` | `{ "apiKey"?, "baseURL"?, "model"?, "maxSteps"?, "settings"? }` |
| 列出提供商 | `POST /api/providers/list` | `{}` |
| 新增提供商 | `POST /api/providers` | 不带 `id` |
| 更新提供商 | `POST /api/providers` | 带 `id`；`apiKey` 为空表示不修改 |
| 删除提供商 | `POST /api/providers/delete` | `{ "id": "..." }` |
| 切换提供商 | `POST /api/providers/activate` | `{ "id": "..." }` |

**调用示例**

```bash
# 读
curl -X POST http://127.0.0.1:3000/api/config/get \
  -H 'content-type: application/json' -d '{}'

# 写
curl -X POST http://127.0.0.1:3000/api/providers/activate \
  -H 'content-type: application/json' -d '{"id":"p_abc"}'
```

### 1.3 请求格式

| 项 | 规则 |
| --- | --- |
| 请求体 | `application/json`，上限 **1 MB**（超出返回 413） |
| 字符编码 | UTF-8 |
| 路径参数 | **无**：所有参数都在 JSON 请求体中（动作由路径表达） |
| 查询参数 | 统一使用 `camelCase`（如 `baseUrl`、`apiKey`） |
| 时间戳 | **毫秒级 Unix 时间戳**（`number`），非 ISO 字符串 |
| 标识符 | 字符串；`sessionId` 由服务端生成或客户端指定 |

### 1.4 成功响应约定

所有非流式接口都返回 JSON 对象，并在顶层携带 `ok` 字段（`/api/config`、`/api/models` 除外，
其成功即 `2xx` 且不带 `error` 字段）。

```json
{ "ok": true, "...": "业务字段" }
```

### 1.5 安全约束（实现强制）

| 约束 | 说明 |
| --- | --- |
| **密钥脱敏** | 任何响应中的 API Key 都是 `sk-…abcd` 形式，**永不回传明文** |
| **路径沙箱** | 文件接口复用 `fs.read` 工具，`workspace` 权限模式下禁止越界 |
| **命令白名单** | `/api/exec` 受「终端插件」开关控制，缺省 5 秒超时强制终止 |
| **隐私** | 服务不发起任何出站请求，除 `/api/models` 会按用户给定的 `baseUrl` 转发一次 |
| **本地凭证** | 密钥落盘于 `~/.lish/config.json`，文件权限 `0600` |

---

## 2. 错误模型

### 2.1 统一错误体

```json
{
  "ok": false,
  "error": "人类可读的错误说明",
  "detail": "上游原始报文（可选，仅 /api/models 使用）"
}
```

> `/api/chat` 例外：它走 SSE 流，错误以流内 `3:` 帧或 HTTP 状态码表达（见 8.4）。
> `/api/config` 与 `/api/models` 使用 `{ "error": "..." }`（不含 `ok`），保留历史兼容。

### 2.2 状态码语义

| 状态码 | 语义 | 典型场景 |
| --- | --- | --- |
| `200` | 成功 | 所有读取与写入成功 |
| `400` | 参数错误 | 缺 `path`、`message` 为空、`baseURL` 非法、`maxSteps` 非正 |
| `403` | 被策略拒绝 | 文件工具被禁用、终端插件已关闭 |
| `404` | 资源不存在 | 激活了不存在的提供商 id |
| `413` | 请求体过大 | 超过 1 MB |
| `500` | 服务端内部错误 | 文件树读取失败、轨迹查询异常 |
| `502` | 上游失败 | `/api/models` 上游非 2xx、连接失败、超时（10s） |

### 2.3 容错原则

- **任何单点异常都不得导致进程退出**：路由处理器全部包裹 try/catch。
- 配置文件损坏、JSON 解析失败 → 降级为空配置并继续启动。
- 模型返回非法 JSON → 保留原始串并标记解析错误，不抛出未捕获异常。

---

## 3. 端点总览

| 方法 | 路径 | 用途 | 幂等 |
| --- | --- | --- | :---: |
| `POST` | `/api/health` | 健康检查与能力探测 | ✅ |
| `POST` | `/api/config/get` | 读取配置（含提供商、应用设置） | ✅ |
| `POST` | `/api/config` | 更新当前模型的连接参数与应用设置 | ✅ |
| `POST` | `/api/providers/list` | 列出全部提供商 | ✅ |
| `POST` | `/api/providers` | 新增 / 更新一个提供商 | ✅ |
| `POST` | `/api/providers/delete` | 删除提供商 | ✅ |
| `POST` | `/api/providers/activate` | 切换激活的提供商 | ✅ |
| `POST` | `/api/models` | 拉取上游可用模型列表 | ✅ |
| `POST` | `/api/chat` | 对话（SSE 流式） | ❌ |
| `POST` | `/api/session/events` | 会话轨迹事件 | ✅ |
| `POST` | `/api/files` | 工作区文件树 | ✅ |
| `POST` | `/api/files/content` | 读取单个文件 | ✅ |
| `POST` | `/api/exec` | 执行 shell 命令 | ❌ |
| `POST` | `/api/plugins` | 插件列表 | ✅ |
| `POST` | `/api/plugins/reload` | 热重载插件 | ✅ |
| `POST` | `/api/subagents` | 子智能体记录 | ✅ |
| `GET` | `/` | 静态前端页面 | ✅ |

> 「幂等」指业务语义：相同请求重复执行结果一致，可安全重试。
> 例如重复删除同一个 id、重复激活同一提供商都不会产生额外副作用（并非 HTTP 方法本身的幂等性）。

---

## 4. 运行状态

### 4.1 `POST /api/health`

健康检查与能力探测。**不需要任何凭证**，可用于容器探针。

**响应 `200`**

```json
{
  "ok": true,
  "model": "deepseek-chat",
  "workspace": "/path/to/workspace",
  "sessions": 3,
  "tools": ["fs.read", "fs.write", "shell.run", "spawn_agent"]
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `model` | `string` | 当前激活模型 |
| `workspace` | `string` | 工作区绝对路径（文件与命令的根） |
| `sessions` | `number` | 内存中的会话数量 |
| `tools` | `string[]` | 当前已注册的工具名列表 |

> 无 API Key 时该接口依然返回 `200`，服务可正常启动——这是刻意设计，
> 缺失配置应在前端引导用户补齐，而不是让进程启动失败。

---

## 5. 模型提供商

lish 支持配置**任意多个**模型提供商（DeepSeek / OpenAI / Ollama / 中转网关…），
运行时始终使用「当前激活」的那一个。切换是**热生效**的，无需重启。

### 5.1 提供商对象

```json
{
  "id": "p_m1x2y3abc",
  "name": "DeepSeek 官方",
  "baseURL": "https://api.deepseek.com",
  "model": "deepseek-chat",
  "apiKeyMasked": "sk-…a1b2",
  "hasApiKey": true
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `string` | 稳定标识，创建后不变 |
| `name` | `string` | 展示名，可自由修改 |
| `baseURL` | `string` | 形如 `https://api.deepseek.com`，末尾斜杠会被忽略 |
| `model` | `string` | 该提供商下选中的模型 |
| `apiKeyMasked` | `string` | **脱敏**后的密钥；未配置为空串 |
| `hasApiKey` | `boolean` | 是否已配置密钥 |

### 5.1.1 `POST /api/providers/list` — 列出全部提供商

只刷新提供商列表而不重取整份配置时使用。

**响应 `200`**

```json
{
  "ok": true,
  "providers": [ { "id": "p_…", "name": "DeepSeek 官方", "...": "..." } ],
  "activeProviderId": "p_…"
}
```

> `POST /api/config/get` 也会内联同一份 `providers`，首次加载用后者可省一次往返。

### 5.2 `POST /api/providers` — 新增或更新

**幂等语义**

- 带 `id` 且存在 → **更新该条**；
- 带 `id` 但不存在 → 视为新建（忽略传入 id，分配新 id）；
- 不带 `id` → 新建，若当前无任何提供商则自动激活。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | `string` | 否 | 传入即更新该提供商 |
| `name` | `string` | 否 | 展示名；空串保留原值 |
| `baseURL` | `string` | 否 | 必须是 `http(s)://`，否则 `400` |
| `apiKey` | `string` | 否 | **空串 = 不修改密钥**（防止前端回写脱敏值） |
| `model` | `string` | 否 | 模型名 |

```bash
curl -X POST http://127.0.0.1:3000/api/providers \
  -H 'content-type: application/json' \
  -d '{"name":"本地 Ollama","baseURL":"http://127.0.0.1:11434/v1","apiKey":"ollama","model":"llama3"}'
```

**响应 `200`**

```json
{
  "ok": true,
  "providers": [ { "id": "p_…", "name": "本地 Ollama", "...": "..." } ],
  "activeProviderId": "p_…",
  "config": {
    "baseURL": "http://127.0.0.1:11434/v1",
    "model": "llama3",
    "apiKeyMasked": "oll…lama",
    "hasApiKey": true,
    "providerName": "openai"
  }
}
```

**错误**

| 状态码 | 条件 |
| --- | --- |
| `400` | `baseURL` 非 http(s) 地址 |

### 5.3 `POST /api/providers/delete` — 删除

删除后若删掉的是激活项，自动回落到列表第一条；列表清空时运行时降级为
`unconfigured`（发消息时提示去设置页补配置，而不是崩进程）。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | `string` | ✅ | 要删除的提供商 id |

```bash
curl -X POST http://127.0.0.1:3000/api/providers/delete \
  -H 'content-type: application/json' \
  -d '{"id":"p_m1x2y3abc"}'
```

**响应 `200`**：结构同 5.2（`providers` 中不再包含被删项）。

**错误**

| 状态码 | 条件 |
| --- | --- |
| `400` | 缺少 `id` |

> 删除不存在的 id 视为幂等成功（列表不变）。

### 5.4 `POST /api/providers/activate` — 切换激活

立即热切换底层 Provider，下一次对话即使用新的地址/密钥/模型。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | `string` | ✅ | 要启用的提供商 id |

```bash
curl -X POST http://127.0.0.1:3000/api/providers/activate \
  -H 'content-type: application/json' \
  -d '{"id":"p_m1x2y3abc"}'
```

**响应 `200`**：结构同 5.2。

**错误**

| 状态码 | 条件 |
| --- | --- |
| `400` | 缺少 `id` |
| `404` | 提供商 id 不存在 |

---

## 6. 模型列表

### 6.1 `POST /api/models`

一键拉取上游可用模型，用于设置面板的「获取可用模型」按钮。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `baseUrl` | `string` | 否 | 不传则用当前激活提供商的地址 |
| `apiKey` | `string` | 否 | 不传则用当前激活提供商的密钥 |

```bash
curl -X POST http://127.0.0.1:3000/api/models \
  -H 'content-type: application/json' \
  -d '{"baseUrl":"https://api.deepseek.com","apiKey":"sk-xxx"}'
```

> 传入 `baseUrl`/`apiKey` 的意义：用户刚填完表单、尚未保存时也能先预览模型列表。

**行为**

1. 请求 `${baseUrl}/models`（末尾斜杠自动去掉），携带 `Authorization: Bearer <key>`；
2. 超时 **10 秒**（`AbortController`）；
3. 兼容三种响应结构并去重排序：
   - `{ "data": [{ "id": "deepseek-chat" }] }`（OpenAI / DeepSeek）
   - `[{ "id": "..." }]`（裸数组）
   - `{ "models": [{ "name": "llama3" }] }`（Ollama）

**响应 `200`**

```json
{
  "models": ["deepseek-chat", "deepseek-reasoner"],
  "endpoint": "https://api.deepseek.com/models"
}
```

**错误**

| 状态码 | 条件 | 响应体示例 |
| --- | --- | --- |
| `400` | 缺 API Key | `{"error":"缺少 API Key，请先在设置中填写"}` |
| `400` | `baseUrl` 非法 | `{"error":"baseURL 不合法：..."}` |
| `502` | 上游非 2xx | `{"error":"上游返回 401","detail":"{\"error\":...}"}` |
| `502` | 超时 / 网络失败 | `{"error":"请求超时（10s）"}` 或 `{"error":"无法连接模型服务"}` |

**前端降级约定**：任一错误都必须把模型输入框还原为**文本输入**，
并展示「获取失败，请手动输入模型名」。

---

## 7. 应用配置

### 7.1 `POST /api/config/get`

一次性返回模型连接状态、提供商列表、应用设置与已注册工具，前端首屏据此渲染。

**响应 `200`**

```json
{
  "baseURL": "https://api.deepseek.com",
  "model": "deepseek-chat",
  "maxSteps": 8,
  "workspaceRoot": "/path/to/workspace",
  "apiKeyMasked": "sk-…a1b2",
  "hasApiKey": true,
  "providerName": "openai",
  "tools": ["fs.read", "fs.write", "shell.run", "spawn_agent"],
  "providers": [ { "id": "p_…", "name": "DeepSeek 官方", "...": "..." } ],
  "activeProviderId": "p_…",
  "settings": {
    "permission": "workspace",
    "theme": "dark",
    "fontSize": "medium",
    "agentPreset": "standard",
    "plugins": {
      "fs-tools": true,
      "shell": true,
      "echo-tool": true,
      "session-log": true
    }
  }
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `providerName` | `string` | 底层 Provider 名：`openai` / `mock` / `unconfigured` |
| `providers` | `PublicProvider[]` | 见 5.1 |
| `settings` | `AppSettings` | 见 14.1 |

> `providerName === "unconfigured"` 是前端展示「未配置 API Key」红色横幅的判定依据，
> 也可用 `hasApiKey === false`。

### 7.2 `POST /api/config`

更新当前激活提供商的连接参数，以及/或应用设置。两者可同时提交。

**请求体**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `apiKey` | `string` | 非空才生效；空串表示不修改 |
| `baseURL` | `string` | 非空才生效 |
| `model` | `string` | 非空才生效 |
| `maxSteps` | `number` | ≥ 1，自动取整 |
| `settings` | `Partial<AppSettings>` | 深度合并，非法值回落到默认 |

```bash
curl -X POST http://127.0.0.1:3000/api/config \
  -H 'content-type: application/json' \
  -d '{"apiKey":"sk-xxx","model":"deepseek-reasoner","settings":{"theme":"light"}}'
```

**响应 `200`**

```json
{
  "ok": true,
  "config": {
    "baseURL": "https://api.deepseek.com",
    "model": "deepseek-reasoner",
    "maxSteps": 8,
    "apiKeyMasked": "sk-…a1b2",
    "hasApiKey": true,
    "providerName": "openai"
  },
  "settings": { "theme": "light", "...": "..." },
  "tools": ["fs.read", "fs.write", "shell.run"]
}
```

**错误**

| 状态码 | 条件 |
| --- | --- |
| `400` | 请求体中既无模型字段也无 `settings` |

**副作用**：模型字段变更会同步写回 `~/.lish/config.json` 中的激活提供商并热切换 Provider；
`settings` 变更会持久化到 `~/.lish/settings.json`，并即时调整工具注册表（如关闭 shell 后
`/api/exec` 立即返回 `403`）。

---

## 8. 对话（SSE 流式）

### 8.1 `POST /api/chat`

流式对话。基于 Vercel AI SDK v4 的 **data stream** 协议，`Content-Type: text/event-stream`。

**请求体**（二选一，兼容两种写法）

```jsonc
// 简洁格式
{ "message": "读一下 package.json", "sessionId": "s_abc" }

// useChat 格式（取 messages 数组最后一条）
{ "messages": [{ "role": "user", "content": "读一下 package.json" }] }
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `message` | `string` | ※ | 用户输入，自动 trim |
| `messages` | `Message[]` | ※ | 取最后一条的 `content` 或 `parts[].text` |
| `sessionId` | `string` | 否 | 复用既有会话；不存在则自动创建 |

※ `message` 与 `messages` 至少提供其一，且解析结果非空，否则 `400`。

### 8.2 流帧格式

| 前缀 | 含义 | 载荷 |
| --- | --- | --- |
| `0:` | **正文增量**（打字机效果走这条） | JSON 字符串片段 |
| `2:` | **结构化事件**（工具调用、思考、结束等） | `ToolStreamEvent` JSON |
| `3:` | **错误** | 错误文本 |
| `d:` | 流结束标记 | `{"finishReason":"..."}` |

> 注意：正文**不走** data 帧，而是直接写 `0:` 文本帧——这才是前端逐字渲染的正确通道。

### 8.3 `ToolStreamEvent` 的 type 取值

| `type` | 何时发出 | 关键字段 |
| --- | --- | --- |
| `thinking` | 模型开始一轮推理 | `step` |
| `tool_call` | 请求执行工具 | `callId`、`name`、`argsJson` |
| `tool_result` | 工具返回 | `callId`、`content`、`isError`、`durationMs` |
| `aborted` | 用户/客户端中断 | `stopReason` |
| `done` | 本轮结束 | `messageCount`、`stopReason` |

通用字段：`runId`（贯穿一次请求的链路 id）、`step`、`error`。

流开始时还会先发一条 `data` 帧声明会话：

```json
{ "type": "session", "sessionId": "s_abc" }
```

### 8.4 断连与超时

- 客户端断开（`res` 触发 `close`）→ 服务端**立即解绑全部事件监听器**并停止写入；
- 不会因断连导致内存泄漏（监听器按 `runId` 精确回收，不串台到并发请求）；
- 未配置 API Key 时，流内 `3:` 帧返回「尚未配置 API Key，请点击左下角【设置】…」。

### 8.5 示例

```bash
curl -N -X POST http://127.0.0.1:3000/api/chat \
  -H 'content-type: application/json' \
  -d '{"message":"列出当前目录"}'
```

```
0:"我来"
0:"看看"
2:{"type":"tool_call","runId":"r1","step":1,"callId":"c1","name":"shell.run","argsJson":"{\"command\":\"ls\"}"}
2:{"type":"tool_result","runId":"r1","step":1,"callId":"c1","content":"package.json\nsrc","isError":false,"durationMs":42}
0:"当前目录有…"
2:{"type":"done","runId":"r1","messageCount":4,"stopReason":"stop"}
d:{"finishReason":"stop"}
```

---

## 9. 会话轨迹

### 9.1 `POST /api/session/events`

返回该会话的完整轨迹事件数组，用于轨迹面板的时间轴、耗时条形图与详情视图。
内存缺失时会从会话日志（append-only JSONL）回放重建。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `sessionId` | `string` | ✅ | 目标会话 id |

**响应 `200`**

```json
{
  "ok": true,
  "sessionId": "s_abc",
  "count": 12,
  "events": [ { "id": "e1", "traceId": "r1", "type": "tool.call", "...": "..." } ]
}
```

`TraceEvent` 详见 14.2。

**错误**

| 状态码 | 条件 |
| --- | --- |
| `400` | 缺少 `sessionId` |
| `500` | 回放过程异常 |

---

## 10. 文件系统

### 10.1 `POST /api/files`

递归返回工作区文件树，**深度 3 层**，自动忽略 `node_modules`、`.git`、`dist` 等目录，
单项超过上限时置 `truncated: true`。

**响应 `200`**

```json
{
  "ok": true,
  "root": "/path/to/workspace",
  "tree": [
    {
      "path": "src",
      "name": "src",
      "type": "dir",
      "children": [
        { "path": "src/index.ts", "name": "index.ts", "type": "file", "size": 1203 }
      ]
    }
  ]
}
```

### 10.2 `POST /api/files/content`

读取单个文件文本内容（预览面板用）。复用 `fs.read` 工具的权限判定。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `path` | `string` | ✅ | 相对工作区根的路径 |

```bash
curl -X POST http://127.0.0.1:3000/api/files/content \
  -H 'content-type: application/json' \
  -d '{"path":"package.json"}'
```

**响应 `200`**

```json
{ "ok": true, "path": "package.json", "content": "{ ... }" }
```

**错误**

| 状态码 | 条件 |
| --- | --- |
| `400` | 缺 `path` / 越界 / 读失败 |
| `403` | 文件系统工具已被禁用 |

---

## 11. 命令执行

### 11.1 `POST /api/exec`

在**工作区根目录**执行一条 shell 命令（终端面板用）。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `command` | `string` | ✅ | 命令原文，自动 trim |

```bash
curl -X POST http://127.0.0.1:3000/api/exec \
  -H 'content-type: application/json' \
  -d '{"command":"git status --short"}'
```

**响应 `200`**

```json
{
  "ok": true,
  "command": "git status --short",
  "stdout": " M src/server.ts\n",
  "stderr": "",
  "code": 0,
  "timedOut": false,
  "durationMs": 128
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `code` | `number \| null` | 退出码；被超时杀死时为 `null` |
| `timedOut` | `boolean` | 是否因超时被强制终止 |
| `durationMs` | `number` | 实际耗时 |

**错误**

| 状态码 | 条件 |
| --- | --- |
| `400` | 命令为空 |
| `403` | 终端插件已在设置中关闭 |
| `500` | 执行器异常 |

**约束**：超时 **5 秒**强制终止；输出长度受限。危险命令的二次确认由前端负责，
服务端不做命令白名单——请勿把该端口暴露到不可信网络。

---

## 12. 插件

### 12.1 `POST /api/plugins`

**响应 `200`**

```json
{
  "ok": true,
  "plugins": [
    {
      "id": "hello-world",
      "name": "hello-world",
      "version": "0.1.0",
      "module": "/root/.lish/plugins/hello.ts",
      "status": "loaded",
      "loadMs": 21,
      "sourceDir": "/root/.lish/plugins"
    }
  ]
}
```

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `status` | `"loaded" \| "disabled" \| "error"` | 加载状态 |
| `error` | `string?` | 失败原因 |
| `resolvedFrom` | `string?` | 实际解析到的模块路径（排障用） |
| `loadMs` | `number?` | 最近一次加载耗时 |

### 12.2 `POST /api/plugins/reload`

热重载全部插件，或指定单个插件。卸载时通过 `Context.scope()` 逆序回滚副作用，
不残留监听器、定时器与服务注册。

**请求体**

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `id` | `string` | 否 | 不传表示重载全部 |

**响应 `200`**

```json
{ "ok": true, "plugins": [ { "id": "hello-world", "status": "loaded" } ] }
```

**错误**

| 状态码 | 条件 |
| --- | --- |
| `400` | 指定 id 不存在或重载失败 |
| `500` | 未知异常 |

---

## 13. 子智能体

### 13.1 `POST /api/subagents`

返回子智能体的运行记录，用于前端状态栏计数与轨迹面板分组。

**响应 `200`**

```json
{
  "ok": true,
  "running": 1,
  "total": 3,
  "agents": [
    {
      "id": "sa_1",
      "role": "explorer",
      "task": "找出所有未使用的导出",
      "status": "running",
      "startedAt": 1730000000000,
      "sessionId": "s_abc",
      "traceId": "r1"
    }
  ]
}
```

`SubAgentRecord` 详见 14.4。深度上限为 **2 层**（由 `AsyncLocalStorage` 隔离，防递归失控）。

---

## 14. 数据结构附录

### 14.1 `AppSettings`

| 字段 | 类型 | 取值 | 默认 |
| --- | --- | --- | --- |
| `permission` | `string` | `workspace` \| `full` | `workspace` |
| `theme` | `string` | `light` \| `dark` \| `system` | `dark` |
| `fontSize` | `string` | `small` \| `medium` \| `large` | `medium` |
| `agentPreset` | `string` | `standard` \| `minimal` \| `creative` | `standard` |
| `plugins` | `Record<PluginId, boolean>` | 见下 | 全部 `true` |

`PluginId`：`fs-tools` \| `shell` \| `echo-tool` \| `session-log`

> 持久化位置 `~/.lish/settings.json`；`LISH_SETTINGS_FILE` 可覆盖（测试用）。

### 14.2 `TraceEvent`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `string` | 事件唯一 id（前端列表 key） |
| `traceId` | `string` | 贯穿一次 run 的链路标识 |
| `sessionId` | `string` | 所属会话 |
| `type` | `string` | 见 14.3 |
| `step` | `number` | 轮次，从 1 开始 |
| `timestamp` | `number` | 毫秒时间戳 |
| `duration` | `number` | 耗时（毫秒），瞬时事件为 0 |
| `title` | `string` | 时间轴单行标题 |
| `toolName` | `string?` | 工具名（`tool.call` / `tool.result`） |
| `callId` | `string?` | 配对 call 与 result |
| `args` | `object?` | 已解析入参 |
| `result` | `string?` | 结果文本 |
| `isError` | `boolean?` | 是否错误结果 |
| `tokenUsage` | `TokenUsage?` | 见 14.3 |
| `schema` | `object?` | 该工具的 JSON Schema |

### 14.3 `TraceEventType` 与 `TokenUsage`

```ts
type TraceEventType =
  | "run.start" | "step.thinking" | "stream.delta"
  | "tool.call"  | "tool.result"   | "answer"
  | "run.end"    | "error";

interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  firstTokenMs?: number;      // 首个 token 延迟
  tokensPerSecond?: number;   // 吞吐
}
```

### 14.4 `SubAgentRecord`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `string` | 子代理 id |
| `role` | `string` | 角色名 |
| `task` | `string` | 任务描述 |
| `status` | `"running" \| "done" \| "error"` | 状态 |
| `startedAt` / `finishedAt` | `number` / `number?` | 毫秒时间戳 |
| `sessionId` | `string` | 归属会话 |
| `traceId` | `string?` | 父级链路 |
| `result` / `error` | `string?` | 结果或错误 |

### 14.5 `FileNode`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `path` | `string` | 相对工作区根，`/` 分隔 |
| `name` | `string` | 文件名 |
| `type` | `"file" \| "dir"` | 类型 |
| `size` | `number?` | 字节数（仅文件） |
| `children` | `FileNode[]?` | 子节点（仅目录） |
| `truncated` | `boolean?` | 子项被截断 |

---

## 15. 版本与兼容策略

### 15.1 配置文件格式演进

`~/.lish/config.json` 从 v0.1.0-alpha.3 起支持多提供商：

```json
{
  "providers": [
    {
      "id": "p_m1x2y3abc",
      "name": "DeepSeek 官方",
      "baseURL": "https://api.deepseek.com",
      "apiKey": "sk-xxx",
      "model": "deepseek-chat"
    }
  ],
  "activeProviderId": "p_m1x2y3abc"
}
```

**向后兼容**：早期版本的扁平结构（顶层 `apiKey` / `baseURL` / `model`）在读取时会被
**自动迁移**成一条提供商记录，无需用户手动改文件。迁移后首次写入即转为新格式。

**权限**：文件固定 `0600`，因为其中含明文密钥。

### 15.2 配置优先级

```
环境变量 (LLM_API_KEY / LLM_BASE_URL / LLM_MODEL)
        ↓ 覆盖
~/.lish/config.json 中「当前激活的提供商」
        ↓ 覆盖
内置默认值 (https://api.deepseek.com · deepseek-chat · maxSteps 8)
```

环境变量为空串或纯空白时**不**遮蔽配置文件（便于在 shell 里写 `LLM_API_KEY=` 做透传）。

### 15.3 兼容规则

- **新增字段**：非破坏性变更，客户端应忽略未知字段。
- **删除/重命名字段**：破坏性变更，需在 CHANGELOG 中标注并在次版本号体现。
- **错误码**：只允许新增，不允许改变既有状态码的语义。
- **端点废弃**：先标记 deprecated（文档 + 响应头），至少保留一个小版本。

### 15.4 相关文档

| 文档 | 内容 |
| --- | --- |
| [`README.md`](./README.md) | 安装、启动、配置、架构与插件开发 |
| [`AGENTS.md`](./AGENTS.md) | 工程质量标准与交付验收规程 |
