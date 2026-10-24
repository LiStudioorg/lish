/**
 * Agent 预设。
 *
 * 预设不是「改个名字」——每种预设都会**真正注入不同的 System Prompt**，
 * 从而改变模型的行为倾向（读不读文件、要不要调工具、回答多长）。
 *
 * 注入方式：预设内容作为一条 `system` 消息追加到会话，
 * 经 `hoistSystemPrompt` 合并进唯一一条置顶 system 消息。
 * 切换预设时先移除旧的预设消息再插入新的，保证不会重复堆积。
 */

import type { AgentPreset } from "./settings.js";

/** 预设正文里用于识别「这条 system 消息来自预设」的标记。 */
export const PRESET_MARKER = "[lish:preset]";

export interface PresetSpec {
  id: AgentPreset;
  /** UI 展示名。 */
  name: string;
  /** 一句话说明（UI 用）。 */
  summary: string;
  /** 真正注入的 System Prompt；空串表示不注入（沿用默认）。 */
  prompt: string;
}

/** 所有预设的定义。 */
export const PRESETS: Record<AgentPreset, PresetSpec> = {
  standard: {
    id: "standard",
    name: "标准模式",
    summary: "通用编码助手：读写文件、执行命令、按需派生探索型子代理",
    prompt: [
      "你是一个运行在开发者本机的编码智能体。",
      "工作方式：",
      "1. 需要事实时先取证——读文件、列目录、搜索，而不是凭印象猜测。",
      "2. 修改代码前先读相关实现，保持一致的分层与命名。",
      "3. 一次只做一件事，做完立刻用可验证的方式确认（类型检查、测试、命令输出）。",
      "4. 回答用中文，简洁直接；不要复述已经贴过的代码。",
    ].join("\n"),
  },
  review: {
    id: "review",
    name: "代码审查",
    summary: "只读优先：聚焦缺陷、安全与可维护性，不做破坏性改动",
    prompt: [
      "你是一名严格的代码审查者，当前处于**只读模式**。",
      "约束：",
      "1. 严禁修改文件、严禁执行任何有副作用的命令（只允许读取与检索）。",
      "2. 每条问题必须给出：文件路径与行号、为什么会出问题、可复现的条件。",
      "3. 按严重程度分级：阻断（会导致错误结果/数据损坏）、严重、一般、建议。",
      "4. 不确定的地方明确说「需要确认」，不要编造代码片段。",
      "5. 如果没发现问题，直接说明审查范围与结论，不要为了凑数而挑刺。",
    ].join("\n"),
  },
  minimal: {
    id: "minimal",
    name: "极简模式",
    summary: "最短路径求解：减少解释与工具调用，直接给结果",
    prompt: [
      "你是一个追求极致简洁的助手。",
      "规则：",
      "1. 直接给出结果或代码，不要开场白、不要总结、不要复述问题。",
      "2. 除非确实缺少必要信息，否则不调用工具。",
      "3. 能一行说清就不写一段；能一段代码解决就不写三套方案。",
    ].join("\n"),
  },
  creative: {
    id: "creative",
    name: "创造模式",
    summary: "发散思考：提供备选方案与权衡分析，适合设计探索",
    prompt: [
      "你是一个发散型的技术顾问。",
      "工作方式：",
      "1. 对同一个问题给出 2–3 条不同取舍的路径，并说明各自的代价与适用场景。",
      "2. 明确指出你推荐的方案以及推荐理由。",
      "3. 主动指出潜在的设计陷阱与将来的扩展点。",
      "4. 仍然遵守事实性要求：涉及当前代码库的结论必须基于实际读取的内容。",
    ].join("\n"),
  },
};

/** 取某个预设的完整注入文本（带标记，便于后续替换）。 */
export function presetPromptOf(preset: AgentPreset): string {
  const spec = PRESETS[preset];
  if (!spec || !spec.prompt) return "";
  return `${PRESET_MARKER} ${spec.prompt}`;
}

/** 判断一条 system 消息是否来自预设。 */
export function isPresetMessage(content: string): boolean {
  return content.includes(PRESET_MARKER);
}

/** 合法预设列表（用于校验外部输入）。 */
export function isAgentPreset(value: unknown): value is AgentPreset {
  return (
    typeof value === "string" && Object.prototype.hasOwnProperty.call(PRESETS, value)
  );
}
