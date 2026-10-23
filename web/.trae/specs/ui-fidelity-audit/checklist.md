# Checklist

## Task 1: CSS 色板系统
- [x] `--dsw-static-*` 包含 200+ 色值（neutral-bluish 0~1000, deepseek 50~900, blue 50~950, red 50~900, green 100~900, amber 100~900）
- [x] Light theme 有完整的 40+ `--dsw-alias-*` 变量
- [x] 15+ `--dsw-specific-*` 变量已定义（bubble、input-major、sidebar-fill 等）
- [x] Dark theme 所有 alias 和 specific 变量正确映射
- [x] `--dsw-shadow-lv2` 阴影变量已定义
- [x] `npm run typecheck` 通过

## Task 2: 组件视觉升级
- [x] 输入卡片 `border-radius: 22px`、`box-shadow: var(--dsw-shadow-lv2)`、背景 `var(--dsw-specific-input-major)`
- [x] 发送按钮圆形 34px，背景 `var(--dsw-alias-button-info-fill)`，白色图标
- [x] 输入框文字 16px/line-height 24
- [x] 用户气泡 `border-radius: 22px`、背景 `var(--dsw-specific-bubble)`、`max-width: min(525px, 82%)`、右对齐
- [x] 助手消息透明背景
- [x] 消息操作行 hover 显示复制+时钟
- [x] `npm run typecheck` 通过

## Task 3: 侧边栏折叠动画
- [x] 折叠时内容冻结宽度 + 150ms crossfade 淡出
- [x] 折叠态 56px 图标栏（展开 + 新会话 + 设置）
- [x] quietBars 行为（指针离开 2 秒隐藏滚动条）
- [x] 折叠态展开按钮使用面板图标
- [x] `npm run typecheck` 通过

## Task 4: 消息操作行
- [x] 助手消息 hover 显示复制按钮
- [x] 复制按钮点击后变为 checkmark，1 秒恢复
- [x] 时钟显示消息时间
- [x] 用户消息时钟在图标前，助手在图标后
- [x] `npm run typecheck` 通过

## Task 5: 轮次状态指示
- [x] 流式底部显示 "Deep diving..." 指示器
- [x] Shimmer 渐变背景动画
- [x] 超过 15 秒显示运行时长计时器
- [x] `prefers-reduced-motion` 支持
- [x] `npm run typecheck` 通过

## Task 6: 空状态升级
- [x] Hero variant 居中卡片，最小高度 52px
- [x] 动态占位符文字（3-4 条轮播）
- [x] 选中 session 无消息时显示提示卡片
- [x] 空状态卡片样式匹配输入卡片
- [x] `npm run typecheck` 通过

## Task 7: Markdown 渲染升级
- [x] 代码块语言标签（大写、11px）
- [x] 代码块复制按钮
- [x] inline code 使用正确 CSS 变量背景
- [x] 代码字体使用 `--dsw-font-family-code`
- [x] `npm run typecheck` 通过

## Task 8: FOUC 预防
- [x] index.html 添加 inline `<style>` 设置 `color-scheme: dark`
- [x] App.tsx 初始渲染前设置 colorScheme
- [x] 视觉无白屏闪烁
- [x] `npm run build` 通过
