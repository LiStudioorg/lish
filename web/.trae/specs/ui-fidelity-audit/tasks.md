# Tasks

- [x] Task 1: 补全 CSS 色板系统 — 从 30 个扩展到 200+ 个变量
  - [x] 1.1 在 components.css 中添加完整 200+ `--dsw-static-*` 静态色值（neutral-bluish、deepseek、blue、red、green、amber 系列，与原版 design-platform.css 对齐）
  - [x] 1.2 补全 light theme 的 40+ `--dsw-alias-*` 变量（bg-base、bg-layer、border、label、button、interactive、state 等子项）
  - [x] 1.3 增加 15+ `--dsw-specific-*` 特定用途变量（bubble、bubble-highlight、input-major、sidebar-fill、selector、tip、menu 等）
  - [x] 1.4 补全 dark theme 所有 alias 和 specific 变量映射
  - [x] 1.5 添加 `--dsw-shadow-lv2` 阴影变量定义
  - [x] 1.6 验证 typecheck 通过

- [x] Task 2: 组件视觉升级（输入框、气泡、按钮）
  - [x] 2.1 ChatInput: 输入卡片 `border-radius: 22px`、`box-shadow: var(--dsw-shadow-lv2)`、背景使用 `--dsw-specific-input-major`
  - [x] 2.2 ChatInput: 发送按钮改为圆形 34px，背景 `--dsw-alias-button-info-fill`（深蓝），白色图标
  - [x] 2.3 ChatInput: 输入框内文字大小 16px/line-height 24（原版标准）
  - [x] 2.4 MessageItem: 用户气泡 `border-radius: 22px`、背景 `--dsw-specific-bubble`、`max-width: min(525px, 82%)`、右对齐
  - [x] 2.5 MessageItem: 助手消息区域透明背景，padding 0
  - [x] 2.6 MessageItem: 添加消息操作行（hover 显示复制按钮 + 时钟）
  - [x] 2.7 验证 typecheck 通过

- [x] Task 3: 侧边栏折叠动画改进
  - [x] 3.1 Sidebar: 折叠时内容冻结宽度 + 150ms crossfade 淡出，侧栏列滑动到 56px
  - [x] 3.2 Sidebar: 折叠态显示 56px 图标栏，包含展开按钮 + 新会话按钮 + 设置按钮（圆形图标）
  - [x] 3.3 Sidebar: 添加 quietBars 行为（指针离开 2 秒后隐藏滚动条）
  - [x] 3.4 Sidebar: 折叠态展开按钮使用面板图标，悬停显示 tooltip
  - [x] 3.5 验证 typecheck 通过

- [x] Task 4: 消息操作行增强
  - [x] 4.1 MessageItem: 助手消息添加 hover 显示操作行（复制 + 时钟）
  - [x] 4.2 复制按钮点击后图标变为 checkmark，1 秒后恢复
  - [x] 4.3 时钟显示消息时间，hover 显示完整时间戳
  - [x] 4.4 用户消息操作行：时钟在图标前（clock='start'），助手在图标后（clock='end'）
  - [x] 4.5 验证 typecheck 通过

- [x] Task 5: 轮次状态指示（TurnStatus）
  - [x] 5.1 ChatArea: 流式状态下底部显示 "Deep diving..." 指示器
  - [x] 5.2 添加 shimmer 渐变背景动画（深蓝→浅蓝→深蓝循环）
  - [x] 5.3 流式超过 15 秒显示运行时长计时器
  - [x] 5.4 支持 `prefers-reduced-motion` 媒体查询减少动效
  - [x] 5.5 验证 typecheck 通过

- [x] Task 6: 空状态升级
  - [x] 6.1 ChatArea: hero variant 空状态 — 居中卡片，最小高度 52px
  - [x] 6.2 动态占位符文字（3-4 条消息轮播，类似原版 placeholder 优先级）
  - [x] 6.3 选中 session 但无消息时显示 "开始新对话" 提示卡片
  - [x] 6.4 空状态卡片样式匹配输入卡片（22px 圆角、阴影）
  - [x] 6.5 验证 typecheck 通过

- [x] Task 7: Markdown 渲染升级
  - [x] 7.1 MarkdownRenderer: 代码块添加语言标签（大写、11px、灰色背景条）
  - [x] 7.2 MarkdownRenderer: 代码块右上角添加复制按钮
  - [x] 7.3 MarkdownRenderer: inline code 使用 `--dsw-alias-markdown-code-segment-unselected` 背景
  - [x] 7.4 MarkdownRenderer: 代码字体使用 `--dsw-font-family-code`
  - [x] 7.5 验证 typecheck 通过

- [x] Task 8: FOUC 预防
  - [x] 8.1 index.html: 添加 inline `<style>` 设置 `color-scheme: dark`
  - [x] 8.2 App.tsx: 初始渲染前设置 `document.documentElement.style.colorScheme = 'dark'`
  - [x] 8.3 确保 dark theme 在 React 挂载前已生效
  - [x] 8.4 验证视觉无白屏闪烁
