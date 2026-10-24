/**
 * 前端应用设置（用户偏好）。
 *
 * 与后端 `src/core/settings.ts` 的 `AppSettings` 保持一致，
 * 是所有组件共享的唯一定义来源——不要在组件里重复声明。
 */

export type ThemeMode = "light" | "dark" | "system";
export type PermissionMode = "workspace" | "full";
export type FontSize = "small" | "medium" | "large";

/** Agent 预设：每种预设对应后端注入的一套 System Prompt 与工具策略。 */
export type AgentPreset = "standard" | "review" | "minimal" | "creative";

export interface AppSettings {
  permission: PermissionMode;
  theme: ThemeMode;
  fontSize: FontSize;
  agentPreset: AgentPreset;
  /** 内置插件的启用状态 */
  plugins: Record<string, boolean>;
}

export const defaultSettings: AppSettings = {
  permission: "workspace",
  theme: "dark",
  fontSize: "medium",
  agentPreset: "standard",
  plugins: {
    "fs-tools": true,
    shell: true,
    "echo-tool": true,
    "session-log": true,
  },
};

/** 预设的展示元信息（UI 用；真正的行为由后端注入）。 */
export const PRESET_META: Array<{
  id: AgentPreset;
  name: string;
  desc: string;
  badge?: string;
}> = [
  {
    id: "standard",
    name: "标准模式",
    desc: "通用编码助手：读写文件、执行命令、按需派生探索型子代理",
    badge: "推荐",
  },
  {
    id: "review",
    name: "代码审查",
    desc: "只读优先：聚焦缺陷、安全与可维护性，不做破坏性改动",
    badge: "只读",
  },
  {
    id: "minimal",
    name: "极简模式",
    desc: "最短路径求解：减少解释与工具调用，直接给结果",
  },
  {
    id: "creative",
    name: "创造模式",
    desc: "发散思考：提供备选方案与权衡分析，适合设计探索",
  },
];
