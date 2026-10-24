/**
 * 持久化应用配置。
 *
 * 与 LLM 配置（API Key 等，可能来自环境变量）不同，
 * 这里保存的是**用户偏好**：权限模式、插件开关、Agent 预设、外观。
 *
 * 存放位置：~/.lish/settings.json
 * 读取失败或文件损坏时回落到默认值，保证服务始终可启动。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** 权限模式：workspace = 仅工作区内；full = 允许跨目录。 */
export type PermissionMode = "workspace" | "full";
export type ThemeMode = "light" | "dark" | "system";
export type FontSize = "small" | "medium" | "large";
/**
 * Agent 预设。
 *
 * 注意：这里只是**枚举值**，真正的行为差异由 `core/presets.ts` 注入的
 * System Prompt 决定。新增预设必须同时在两处登记。
 */
export type AgentPreset = "standard" | "review" | "minimal" | "creative";

/** 可由用户切换的内置插件。 */
export type PluginId = "fs-tools" | "shell" | "echo-tool" | "session-log";

export interface AppSettings {
  permission: PermissionMode;
  theme: ThemeMode;
  fontSize: FontSize;
  agentPreset: AgentPreset;
  plugins: Record<PluginId, boolean>;
}

export const DEFAULT_SETTINGS: AppSettings = {
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

/** 存储路径；可用 LISH_SETTINGS_FILE 覆盖（测试用）。 */
export function settingsPath(): string {
  return process.env.LISH_SETTINGS_FILE ?? join(homedir(), ".lish", "settings.json");
}

/** 读取配置，缺失或损坏时用默认值。 */
export async function loadSettings(): Promise<AppSettings> {
  try {
    const raw = await readFile(settingsPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return mergeSettings(DEFAULT_SETTINGS, parsed);
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

/** 写回配置（自动创建父目录）。 */
export async function saveSettings(settings: AppSettings): Promise<void> {
  const file = settingsPath();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

/** 深度合并并对非法值做白名单校验。 */
export function mergeSettings(base: AppSettings, patch: Partial<AppSettings>): AppSettings {
  const out: AppSettings = structuredClone(base);

  if (patch.permission === "workspace" || patch.permission === "full") {
    out.permission = patch.permission;
  }
  if (patch.theme === "light" || patch.theme === "dark" || patch.theme === "system") {
    out.theme = patch.theme;
  }
  if (patch.fontSize === "small" || patch.fontSize === "medium" || patch.fontSize === "large") {
    out.fontSize = patch.fontSize;
  }
  if (
    patch.agentPreset === "standard" ||
    patch.agentPreset === "minimal" ||
    patch.agentPreset === "creative"
  ) {
    out.agentPreset = patch.agentPreset;
  }
  if (patch.plugins && typeof patch.plugins === "object") {
    for (const key of Object.keys(DEFAULT_SETTINGS.plugins) as PluginId[]) {
      const value = (patch.plugins as Record<string, unknown>)[key];
      if (typeof value === "boolean") out.plugins[key] = value;
    }
  }
  return out;
}
