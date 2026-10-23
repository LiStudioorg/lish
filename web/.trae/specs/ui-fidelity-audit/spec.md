# UI 保真度审计改进

## Why
portable-dsh-shell 与 deepseek-harness 原版视觉和交互体验差距巨大。用户反馈"一点都不像"。需要系统性提升 UI 保真度，使 portable 版本在视觉上接近原版 DSH。

## What Changes
- **色板补全** — 从 30 个 CSS 变量扩展到 200+ 个（与原版完全对齐）
- **三层次系统** — 建立 static → alias → specific 三级变量体系
- **组件视觉升级** — 气泡圆角 22px、阴影 lv2、发送按钮圆形 34px
- **侧边栏折叠动画** — 改进为 crossfade 淡出 + 滑动效果
- **消息操作行** — 增加时钟、复制状态反馈
- **轮次状态指示** — TurnStatus "Deep diving..." shimmer 效果
- **目标栏** — GoalBar 占位，输入框上方显示
- **空状态升级** — Hero variant 居中卡片，动态占位符
- **主题切换优化** — FOUC 预防 + color-scheme 动态设置
- **Markdown 渲染升级** — 代码块语言标签 + 复制按钮

## Impact
- Affected specs: none (this is a new spec)
- Affected code: `src/styles/components.css`, `src/styles/global.css`, `src/chat/ChatInput.tsx`, `src/chat/ChatArea.tsx`, `src/chat/MessageItem.tsx`, `src/chat/MarkdownRenderer.tsx`, `src/app/layout/Sidebar.tsx`, `src/app/App.tsx`, `src/store.ts`

## MODIFIED Requirements

### Requirement: CSS 变量系统
当前系统仅有 ~30 个 CSS 变量，分为 static 和 alias 两层。

**改进后**：
- 建立完整 200+ 色值的 static 层（与原版 design-platform.css 对齐）
- 补全 40+ 个 alias 变量
- 增加 15+ 个 specific 变量（bubble、input-major、sidebar-fill 等）
- 三级变量体系：static → alias → specific

### Requirement: 组件视觉风格
当前圆角偏小（8-12px），阴影较弱，整体扁平。

**改进后**：
- 输入卡片 `border-radius: 22px`（原版标准）
- 用户气泡 `border-radius: 22px` + `deepseek-50` 浅蓝背景
- 卡片阴影使用 `--dsw-shadow-lv2`
- 发送按钮改为圆形 34px `button-info-fill` 深蓝背景

### Requirement: 侧边栏折叠动画
当前侧边栏折叠时直接改变宽度，无过渡动画。

**改进后**：
- 折叠时内容冻结宽度 + crossfade 淡出（150ms）
- 指针离开 2 秒后隐藏滚动条（quietBars）
- 折叠态显示 56px 图标栏 + FishLogo 鲸鱼标志

## REMOVED Requirements

### Requirement: 简化版 MarkdownRenderer
当前行级 parseMarkdown 功能有限，不支持代码块语言标签、复制按钮。

**Reason**: 原版 AssistantMarkdown 提供完整的块级 Markdown 渲染
**Migration**: 升级 MarkdownRenderer 支持代码块语言标签、复制按钮、更完整的 inline 解析

## ADDED Requirements

### Requirement: 完整色板系统
The system SHALL provide a complete CSS variable system matching deepseek-harness design-platform.css.

#### Scenario: Light theme renders
- **WHEN** no `data-ds-dark-theme` on body
- **THEN** all `--dsw-alias-*` and `--dsw-specific-*` resolve to light theme values

#### Scenario: Dark theme renders
- **WHEN** `data-ds-dark-theme` attribute on body
- **THEN** all `--dsw-alias-*` and `--dsw-specific-*` resolve to dark theme values

#### Scenario: 200+ static color tokens
- **WHEN** reading components.css
- **THEN** `--dsw-static-*` contains all colors from original: neutral-bluish (0~1000), deepseek (50~900), blue (50~950), red (50~900), green (100~900), amber (100~900)

### Requirement: 组件视觉升级
The system SHALL match the visual style of deepseek-harness for all key components.

#### Scenario: Chat input card
- **WHEN** viewing chat input area
- **THEN** card has `border-radius: 22px`, `box-shadow: var(--dsw-shadow-lv2)`, background `var(--dsw-specific-input-major)`, max-width matches chat column clearance

#### Scenario: User message bubble
- **WHEN** viewing user message
- **THEN** bubble has `border-radius: 22px`, background `var(--dsw-specific-bubble)`, max-width 525px/82%, right-aligned

#### Scenario: Send button
- **WHEN** viewing send button (not streaming)
- **THEN** button is circular 34px, background `var(--dsw-alias-button-info-fill)` (deepseek-500 blue), color white, disabled state 0.4 opacity

#### Scenario: Assistant message area
- **WHEN** viewing assistant message
- **THEN** content area has transparent background, padding 0, full width within constraints

### Requirement: 侧边栏折叠动画
The system SHALL provide smooth sidebar collapse/expand animation with crossfade.

#### Scenario: Collapse starts
- **WHEN** user clicks collapse button
- **THEN** wide content freezes at expanded width with 150ms fade-out, sidebar column slides to 56px

#### Scenario: Collapse settles
- **WHEN** 150ms after collapse starts
- **THEN** wide content unmounts, 56px rail icons appear with fade-in

#### Scenario: Scrollbar quiet behavior
- **WHEN** pointer leaves sidebar column
- **THEN** scrollbars hide after 2 second delay; if pointer returns before delay, bars remain visible

### Requirement: 消息操作行
The system SHALL provide message chrome with copy button and timestamp.

#### Scenario: Assistant message hover
- **WHEN** user hovers assistant message
- **THEN** copy button appears (click → checkmark → auto-reset after 1s), timestamp appears

#### Scenario: Copy action
- **WHEN** user clicks copy button
- **THEN** icon changes to checkmark, clipboard receives content, icon resets after 1s

### Requirement: 轮次状态指示
The system SHALL show TurnStatus during streaming.

#### Scenario: Streaming starts
- **WHEN** assistant message enters streaming state
- **THEN** "Deep diving..." indicator appears at bottom of chat with shimmer gradient animation

#### Scenario: Streaming continues >15s
- **WHEN** streaming exceeds 15 seconds
- **THEN** running time timer appears alongside status text

### Requirement: 目标栏占位
The system SHALL provide a placeholder area above chat input for future GoalBar.

#### Scenario: No active goal
- **WHEN** chat input is rendered without goal
- **THEN** a small spacer gap exists above input card (reserved for GoalBar integration)

### Requirement: 空状态升级
The system SHALL provide a hero variant for empty chat state.

#### Scenario: Empty state renders
- **WHEN** no session selected
- **THEN** centered card with minimal height 52px, dynamic placeholder text (cycle through 3-4 messages), no top padding

#### Scenario: Session selected but no messages
- **WHEN** session exists but messages are empty
- **THEN** empty state card appears at bottom of message area with "开始新对话" prompt

### Requirement: Markdown 渲染升级
The system SHALL provide enhanced Markdown rendering matching original capabilities.

#### Scenario: Code block rendering
- **WHEN** assistant message contains ```code block```
- **THEN** block renders with language label (uppercase, 11px), copy button in top-right corner, monospace font

#### Scenario: Inline code
- **WHEN** message contains `inline code`
- **THEN** inline code renders with `--dsw-alias-markdown-code-segment-unselected` background

### Requirement: FOUC 预防
The system SHALL prevent flash of unstyled content on initial load.

#### Scenario: Page loads with dark theme
- **WHEN** browser loads index.html
- **THEN** `color-scheme: dark` is set in inline style before React hydrates, preventing white flash

## Task Dependencies
- [ ] Task 1 (色板补全) is foundation — Tasks 2-7 depend on it
- [ ] Task 2 (组件视觉升级) and Task 3 (侧边栏动画) can be parallelized
- [ ] Task 4 (消息操作行) and Task 5 (轮次状态) can be parallelized
- [ ] Task 6 (空状态) and Task 7 (FOUC) are independent, can run in parallel
