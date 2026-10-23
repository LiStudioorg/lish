# dsh-transition-webui 开发进度记录

## 项目概述

像素级复刻 DeepSeek Harness 网页界面的独立脚手架，用于承接 deepseek-harness 用户迁移到其他 Agent 体系（降低认知成本），并可作为快速搭建自有 Agent 界面的技术展示 demo。

---

## 已完成的工作

### 阶段一：编译修复（2025-08-29）

修复了项目从 deepseek-harness 提取后产生的 30+ 个 TypeScript 编译错误。

| 文件 | 修复内容 |
|------|---------|
| ChatArea.tsx | 补充 `useState` import、添加类型注解、移除未使用变量 |
| ChatInput.tsx | 移除未使用 `Button` import |
| boot.tsx | 修复递归 `extends Window`、`parseBootManifest` 缺失、plugin loader 类型、AppShell props 不匹配 |
| types/boot.ts | `DashWindow` 不再 `extends Window`（避免递归） |
| store.ts | getter 返回值加 `?? null` 避免 undefined、移除重复导出 `AppState`、删除未使用的 `genMsgId` |
| Icons.tsx | `IconProps` 添加 `children` 属性 |
| Sidebar.tsx | 移除未使用 `Session` import、修复 `onClick` 中未定义变量 `e` |
| MessageItem.tsx | 移除未使用 `useMemo` |
| plugin-example.ts | 添加类型注解消除 implicit any |
| main.tsx | 移除重复的 `global.css` import |

### 阶段二：UI 保真度改进（2025-08-29）

基于与 deepseek-harness 原版的深度对比，系统性提升 UI 保真度。共 8 个任务全部完成。

#### Task 1：CSS 色板系统补全
- 从 ~30 个变量扩展到 200+ 个
- 建立三层变量体系：`--dsw-static-*` → `--dsw-alias-*` → `--dsw-specific-*`
- 包含完整色系：neutral-bluish (0~1000)、deepseek (50~900)、blue (50~950)、red、green、amber
- 暗色/亮色两套完整 alias + specific 变量
- `--dsw-shadow-lv2` 阴影定义

#### Task 2：组件视觉升级
- **输入卡片**：`border-radius: 22px`、`box-shadow` 阴影、`--dsw-specific-input-major` 背景
- **发送按钮**：圆形 34px、`--dsw-alias-button-info-fill` 蓝色背景、白色图标
- **用户气泡**：`border-radius: 22px`、`max-width: min(525px, 82%)`、右对齐
- **助手消息**：透明背景

#### Task 3：侧边栏折叠动画
- 折叠时内容冻结宽度 + 150ms crossfade 淡出
- 56px rail 图标栏 + 面板图标
- quietBars：指针离开 2 秒后隐藏滚动条
- `IconPanelLeft` 新增面板图标
- `Sidebar.module.css` 新增动画类

#### Task 4：消息操作行
- hover 显示操作行（复制 + 时钟）
- 复制按钮点击 → checkmark → 1 秒恢复
- 时钟：用户消息在图标前，助手在图标后
- hover 完整时间戳

#### Task 5：TurnStatus 轮次状态
- "Deep diving..." shimmer 渐变动画
- 超过 15 秒显示运行时长计时器
- `prefers-reduced-motion` 支持
- `store.ts` 新增 `streamingStartTime` 字段

#### Task 6：空状态升级
- Hero variant 居中卡片（最小高度 52px）
- Session variant 居中卡片（加号图标）
- 动态占位符文字轮播（3 秒间隔）
- 卡片样式匹配输入卡片（22px 圆角、阴影）

#### Task 7：Markdown 渲染升级
- `CodeBlockWrapper` 组件：语言标签（大写）+ 复制按钮
- 无语言标签也显示复制按钮
- inline code 使用 `--dsw-alias-markdown-code-segment-unselected` 背景
- 代码字体 `--dsw-font-family-code`

#### Task 8：FOUC 预防
- index.html：`html { color-scheme: dark; }` inline style
- App.tsx：`useLayoutEffect` 设置 `colorScheme = 'dark'`
- 三层防护：meta → CSS → JS

### 阶段三：Bug 修复（2025-08-29）

| Bug | 描述 | 修复 |
|-----|------|------|
| **致命** | 流式内容覆盖而非追加 | ChatInput.tsx：`store.updateMessage` 改为追加 `(msg?.content ?? '') + chunk` |
| 高 | 侧边栏 collapsed 无宽度 | Sidebar.tsx：`style` 添加 `{ width: 56 }` |
| 高 | darkMode 切换无效 | store.ts：`removeAttribute` 替代 `setAttribute('')` |
| 中 | 用户气泡过宽 | components.css：`.dsh-message-user` 限制 `max-width: 525px` |
| 中 | ChatInput 重复逻辑 | 合并 `handleSubmit`/`handleSendClick` 为 `doSend` |
| 中 | 代码块无语言时无复制按钮 | MarkdownRenderer.tsx：banner 始终渲染，语言标签条件渲染 |
| 中 | 多余 Stats 统计行 | ChatArea.tsx：移除 Stats 区域和未使用变量 |
| 高 | 浅色模式用户气泡仍为暗色 | components.css：`--dsw-static-deepseek-900` → `--dsw-specific-bubble` |

### 阶段四：CSS 精确对齐（2025-08-29）

基于原版 CSS Modules 的精确属性值，逐项修正视觉差异。

| 修复项 | 原值（错误） | 修正值（原版精确） |
|--------|------------|------------------|
| 消息间距 gap | `8px` | `16px` |
| 聊天区 padding | `24px 0` | `16px 32px` |
| 消息列 max-width | `820px` | `748px` |
| 消息列 padding | `0 24px` | `0` |
| 输入区 padding | `12px 24px 16px` | `0 16px 8px` |
| 输入区 border-top | 有 | 无 |
| 输入卡片 max-width | `820px` | `780px` |
| 输入卡片 background | `--dsw-alias-input-bg` | `--dsw-specific-input-major` |
| 输入卡片 border | `--dsw-alias-input-border` | `--dsw-alias-border-l2-darkmode-thin` |
| 输入卡片 shadow | 硬编码 rgba | `var(--dsw-shadow-lv2)` |
| 输入卡片布局 | 行布局 gap:10 | 列布局 `flex-direction:column` + `gap:12px` + `padding-top:10px` |
| 发送按钮 border-radius | `50%` | `999px` |
| 发送按钮 background | `--dsw-static-blue-500` | `--dsw-alias-button-info-fill` |
| 发送按钮 disabled | 变灰 + 0.5 | 保持蓝色 + `opacity:0.4` + `cursor:default` |
| 发送按钮 hover | `--dsw-static-blue-600` | `--dsw-alias-button-info-hover` |
| 发送按钮 transform | 无 | `translateY(-2px)` |
| 消息字体大小 | `14px` | `16px` |
| 消息行高 | `1.65` | `24px` |
| 消息圆角 | `12px` | `22px` |
| 消息内边距 | `12px 16px` | `10px 16px` |
| 用户气泡 max-width | 硬编码 | `min(525px, 82%)` |
| 用户气泡圆角 | `border-bottom-right-radius:4px` | 全圆角 22px |
| 消息行 gap | `4px` | `6px` |
| textarea padding | `4px 0` | `4px 12px 0 16px` |
| placeholder 颜色 | `label-tertiary` | `label-caption` |
| textarea font-family | 继承 body | `var(--dsw-font-family)` |
| 操作栏 gap | `8px` | `10px` |
| 操作栏字号 | `12px` | `14px` |
| 操作按钮 padding | `4px` | `6px` |
| 侧边栏宽度 | `260px` | `280px` |
| 侧边栏滚动条 | `--dsw-alias-scroll-thumb` | `--dsw-alias-scrollbar-bg-l2` |

### 阶段五：结构对齐（2025-08-29）

修复了与原版 DOM 结构的关键差异。

| 修复项 | 描述 |
|--------|------|
| 侧边栏 DOM 结构 | `.regionArea` 和 `.footArea` 改为始终挂载的同级元素，不再条件渲染 |
| 输入卡片行结构 | 新增 `.dsh-chat-input-row` row div（与原版 `.row` 对齐） |
| TurnStatus 位置 | 包裹在 `.dsh-message` 内（max-width: 748px 居中） |
| 新建会话按钮 | 使用原版 DeepSeek 鲸鱼 Logo SVG + "新会话" 文本 |
| 侧边栏宽度 | 280px（原版 SIDEBAR_DEFAULT） |
| 端口 | 改为 3081（避免与 dsh 3080 冲突） |

---

## 技术架构

### 技术栈
- React 18 + TypeScript
- Vite 6 构建
- CSS Modules（侧边栏）+ 全局 CSS（组件）
- 自研轻量 store（zustand-like）

### 项目结构
```
src/
├── app/
│   ├── App.tsx              # 根组件（sidebar + chat）
│   └── layout/
│       ├── Sidebar.tsx       # 侧边栏（crossfade 动画）
│       ├── Sidebar.module.css # 侧边栏动画样式
│       └── SettingsModal.tsx  # 设置面板
├── chat/
│   ├── ChatArea.tsx          # 聊天主区域 + TurnStatus + 空状态
│   ├── ChatInput.tsx         # 输入框 + 流式模拟
│   ├── MarkdownRenderer.tsx  # Markdown 渲染 + 代码块
│   ├── MessageItem.tsx       # 消息项 + 操作行
│   └── types.ts              # 聊天类型定义
├── components/
│   ├── Button.tsx            # 按钮组件
│   └── Icons.tsx             # SVG 图标组件
├── styles/
│   └── components.css        # 全局样式 + 200+ CSS 变量
├── types/
│   └── boot.ts               # 启动清单类型
├── store.ts                  # 状态管理
├── boot.tsx                  # 简化版启动内核
└── main.tsx                  # 应用入口
```

---

## 与原版 deepseek-harness 仍存在的差异

### 高优先级（视觉影响大）

| 差异 | 原版 | 当前 | 影响 |
|------|------|------|------|
| **Hero 空状态** | 鲸鱼 Logo + "探索未至之境" + 光晕 SVG + workspace 选择器 + agent 预设 | 简单聊天气泡图标 + "开始新对话" | 首页视觉完全不同 |
| **输入框工具栏** | 底部有：加号命令按钮 + 模式选择 + 模型选择 + 冻结会话 | 仅发送按钮 | 输入区功能缺失 |
| **输入框 textarea** | 三层叠加（backdrop + textarea + mirror）+ chip 字体 | 单层 textarea | 无高亮/引用支持 |
| **输入框占位符** | "描述你想要构建的内容" | "输入消息... (Enter 发送, Shift+Enter 换行)" | 文案不同 |
| **发送按钮图标** | 向上箭头 SVG | IconSend 箭头 | 图标样式不同 |

### 中优先级

| 差异 | 原版 | 当前 |
|------|------|------|
| 侧边栏折叠态 logo | 鲸鱼 FishLogo SVG（24px）| 文字 "dsh" |
| 消息 header 位置 | 在 action bar 下方 | 在 action bar 上方 |
| 用户消息 header | 隐藏（操作行替代）| 显示 "你" 标签 |
| 助手消息 header | 隐藏 | 显示 "AI" 标签 |
| 消息操作行 `@media (hover: hover)` | 仅 hover 设备显示 | 始终 hover 显示 |
| 代码块 banner 样式 | 独立区域 + 分割线 | 仅文字标签 |

### 低优先级（功能差异）

| 特性 | 原版 | 当前 |
|------|------|------|
| 三栏布局（details 面板） | ✅ | ❌ |
| 11 种消息类型 | compaction/retry/error/steering/context 等 | 仅 user/assistant |
| chip 系统（/command @mention） | ✅ base64 字体 + backdrop | ❌ 纯文本 |
| 文件拖放 + DropOverlay | ✅ | ❌ |
| 分页加载历史（Load Older） | ✅ 锚定分页 | ❌ |
| 回到底部浮动按钮 | ✅ sticky 34px | ❌ |
| GoalBar 目标栏 | ✅ | ❌（已预留位置） |
| Tooltip 组件 | ✅ 延迟显示 | ⚠️ 简化版 |
| 会话持久化 | localStorage | 仅内存 |
| 插件系统（Cordis） | 完整 fiber 状态机 | 仅脚本加载 |
| boot-theme 预注入 | 服务端注入 | ❌ |
| DshChipCell 字体 | base64 TTF | ❌ |
| 容器查询（container-type） | ✅ | ❌ |
| 复制按钮后 checkmark 动画 | ✅ 图标切换 | ✅ 已实现 |
| 用户消息 refChip | 蓝色背景 chip | ❌ |
| 工具调用折叠卡片 | ✅ | ⚠️ 简化版 |

---

## 运行命令

```bash
# 开发（dsh-transition-webui）
npm install
npm run dev          # http://localhost:3081

# 原版 deepseek-harness 在 http://localhost:3080

# 构建
npm run build        # → dist/

# 类型检查
npm run typecheck
```
