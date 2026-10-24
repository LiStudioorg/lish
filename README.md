# lish

面向智能体应用的微内核基础设施。

- **微内核架构**：事件总线、依赖注入、LIFO 生命周期；核心只提供机制，不提供策略。
- **可插拔工具链**：文件系统沙箱、Shell 执行、可动态装卸的插件系统。
- **事件溯源会话**：append-only JSONL 为唯一真源，重启可完整恢复。
- **轨迹可观测**：每条事件携带 traceId、毫秒时间戳、耗时与 token 用量。
- **三种前端**：Web UI（Next.js 静态导出）、终端 TUI（ink）、极简文本聊天。

## 快速开始

```bash
# 安装依赖
npm install

# 构建（前端静态导出 + 后端编译）
npm run build

# 链接为全局命令
npm link
```

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
npm run start:dev     # 后端 + Vite 前端（开发模式）
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
