/**
 * 终端 UI（ink + React）。
 *
 * 布局：
 *   ┌ 头部横幅（模型 / 工作区 / 会话）
 *   ├ 对话历史（用户输入、助手回答、工具调用与结果）
 *   ├ 加载态（思考中 / 正在调用工具）
 *   └ 输入框
 *
 * 数据流：用户回车 -> agent.run() -> 期间通过 ctx.events 推送事件，
 * 每个事件更新 React 状态，界面随之重绘。
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout } from "ink";
import TextInput from "ink-text-input";

import {
  AGENT_ANSWER,
  AGENT_ABORTED,
  AGENT_THINKING,
  AGENT_TOOL_CALL,
  AGENT_TOOL_RESULT,
  type AgentAnswerPayload,
  type AgentThinkingPayload,
  type AgentToolCallPayload,
  type AgentToolResultPayload,
} from "./core/agent-loop.js";
import type { Runtime } from "./runtime.js";

// --- 消息模型 -------------------------------------------------------------

type Entry =
  | { kind: "user"; id: number; text: string }
  | { kind: "assistant"; id: number; text: string }
  | { kind: "tool-call"; id: number; name: string; args: Record<string, unknown> }
  | { kind: "tool-result"; id: number; name: string; content: string; isError: boolean; durationMs: number }
  | { kind: "error"; id: number; text: string }
  | { kind: "notice"; id: number; text: string };

/** 把参数压成适合单行展示的摘要。 */
function describeArgs(args: Record<string, unknown>): string {
  for (const key of ["path", "text", "query", "name"]) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) {
      return `${key}=${value.length > 40 ? `${value.slice(0, 40)}…` : value}`;
    }
  }
  const json = JSON.stringify(args);
  return json.length > 50 ? `${json.slice(0, 50)}…` : json;
}

/** 截断多行文本用于工具结果预览。 */
function previewContent(text: string, limit = 160): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= limit ? single : `${single.slice(0, limit)}…`;
}

// --- 组件 -----------------------------------------------------------------

interface AppProps {
  runtime: Runtime;
}

export function App({ runtime }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const rows = (stdout as unknown as { rows?: number })?.rows ?? process.stdout.rows ?? 24;
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [stepInfo, setStepInfo] = useState<string>("");

  const idRef = useRef(0);
  const nextId = () => ++idRef.current;

  // 用「不含 id 的联合类型」作为入参，避免 Omit 在联合类型上不分发的问题。
  type EntryInput = Entry extends infer E
    ? E extends Entry
      ? Omit<E, "id">
      : never
    : never;

  const push = useCallback((entry: EntryInput) => {
    setEntries((prev) => [...prev, { ...entry, id: nextId() } as Entry]);
  }, []);

  // 订阅内核事件 -> 更新界面
  useEffect(() => {
    const { ctx } = runtime;

    const onThinking = (p: AgentThinkingPayload) => {
      setStatus("思考中…");
      setStepInfo(`第 ${p.step} 步 · 上下文 ${p.messageCount} 条消息`);
    };

    const onToolCall = (p: AgentToolCallPayload) => {
      setStatus(`调用工具 ${p.name} …`);
      push({ kind: "tool-call", name: p.name, args: p.args });
    };

    const onToolResult = (p: AgentToolResultPayload) => {
      setStatus("思考中…");
      push({
        kind: "tool-result",
        name: p.name,
        content: p.content,
        isError: p.isError,
        durationMs: p.durationMs,
      });
    };

    const onAnswer = (p: AgentAnswerPayload) => {
      setStatus("");
      setStepInfo("");
      if (p.text.trim().length > 0) {
        push({ kind: "assistant", text: p.text });
      }
      if (p.stopReason !== "stop") {
        push({ kind: "notice", text: `本轮结束：${p.stopReason}` });
      }
    };

    const onAborted = (p: { stopReason: string; error?: string }) => {
      if (p.error) push({ kind: "error", text: p.error });
    };

    ctx.on(AGENT_THINKING, onThinking);
    ctx.on(AGENT_TOOL_CALL, onToolCall);
    ctx.on(AGENT_TOOL_RESULT, onToolResult);
    ctx.on(AGENT_ANSWER, onAnswer);
    ctx.on(AGENT_ABORTED, onAborted);

    return () => {
      ctx.off(AGENT_THINKING, onThinking);
      ctx.off(AGENT_TOOL_CALL, onToolCall);
      ctx.off(AGENT_TOOL_RESULT, onToolResult);
      ctx.off(AGENT_ANSWER, onAnswer);
      ctx.off(AGENT_ABORTED, onAborted);
    };
  }, [runtime, push]);

  // Ctrl+C：忙碌时仅取消输入，空闲时退出
  useInput((_input, key) => {
    if (key.ctrl && _input === "c") {
      exit();
    }
  });

  const sessionRef = useRef(runtime.sessions.create({ title: "tui session" }));

  const submit = useCallback(
    async (value: string) => {
      const text = value.trim();
      if (text.length === 0 || busy) return;

      if (text === "exit" || text === "quit") {
        exit();
        return;
      }

      if (text === "/reset") {
        sessionRef.current = runtime.sessions.create({ title: "tui session" });
        setEntries([]);
        push({ kind: "notice", text: "已开启新会话" });
        setInput("");
        return;
      }

      setInput("");
      setBusy(true);
      push({ kind: "user", text });

      try {
        await runtime.agent.run(sessionRef.current, text);
      } catch (err) {
        push({
          kind: "error",
          text: err instanceof Error ? err.message : String(err),
        });
      } finally {
        setBusy(false);
        setStatus("");
        setStepInfo("");
      }
    },
    [busy, exit, push, runtime],
  );

  // 计算可用高度，避免终端溢出后滚动错乱
  const viewport = Math.max(6, rows - 12);
  const visible = entries.slice(-viewport);

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* 头部 */}
      <Box marginBottom={1}>
        <Text bold color="cyan">
          lish{" "}
        </Text>
        <Text dimColor>
          {runtime.config.model} · {runtime.config.workspaceRoot}
        </Text>
      </Box>

      {/* 对话历史 */}
      <Box flexDirection="column">
        {visible.length === 0 ? (
          <Text dimColor>输入消息开始对话；输入 /reset 开新会话，exit 退出。</Text>
        ) : (
          visible.map((entry) => <EntryView key={entry.id} entry={entry} />)
        )}
      </Box>

      {/* 加载态 */}
      {busy ? (
        <Box marginTop={1} flexDirection="column">
          <Text color="yellow">● {status || "处理中…"}</Text>
          {stepInfo ? <Text dimColor>{"  " + stepInfo}</Text> : null}
        </Box>
      ) : null}

      {/* 输入框 */}
      <Box marginTop={1}>
        <Text color="cyan">{busy ? "… " : "> "}</Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={(value) => void submit(value)}
          placeholder={busy ? "等待上一轮完成…" : "输入消息"}
          focus={!busy}
        />
      </Box>
    </Box>
  );
}

/** 单条对话记录的渲染。 */
function EntryView({ entry }: { entry: Entry }) {
  switch (entry.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text color="green">你 </Text>
          <Text>{entry.text}</Text>
        </Box>
      );

    case "assistant":
      return (
        <Box marginTop={1} flexDirection="column">
          <Text color="cyan">助手</Text>
          <Text>{entry.text}</Text>
        </Box>
      );

    case "tool-call":
      return (
        <Box marginTop={1}>
          <Text dimColor>  ↳ {entry.name}</Text>
          <Text dimColor>({describeArgs(entry.args)})</Text>
        </Box>
      );

    case "tool-result":
      return (
        <Box>
          <Text color={entry.isError ? "red" : "gray"}>
            {"  "}
            {entry.isError ? "✗" : "✓"} {previewContent(entry.content, 140)}
          </Text>
          <Text dimColor> ({entry.durationMs}ms)</Text>
        </Box>
      );

    case "error":
      return (
        <Box marginTop={1}>
          <Text color="red">! {entry.text}</Text>
        </Box>
      );

    case "notice":
      return (
        <Box>
          <Text dimColor>· {entry.text}</Text>
        </Box>
      );
  }
}

// --- 启动 -----------------------------------------------------------------

/**
 * 启动 TUI，直到用户退出。
 * 返回进程退出码。
 */
export async function runTui(runtime: Runtime): Promise<number> {
  // 非 TTY（例如被管道重定向）时给出明确提示，避免 ink 静默异常。
  if (!process.stdin.isTTY) {
    console.error(
      "lish tui 需要在交互式终端中运行。\n" +
        "在非 TTY 环境下请使用 `lish web`（浏览器界面）。",
    );
    return 2;
  }

  // 没有 Key 也要能进 TUI —— 只是发消息时会提示去设置里补，
  // 这里提前把话说清楚，避免用户敲完一大段才被拒。
  if (!runtime.config.apiKey) {
    console.error(
      "⚠️ 未检测到 API Key，请在浏览器界面的【设置】中配置（或设置环境变量 LLM_API_KEY）。",
    );
  }

  const app = render(<App runtime={runtime} />);
  await app.waitUntilExit();
  return 0;
}

// 直接运行（tsx src/tui.tsx）时自动启动，便于 `npm run start:tui`
const entry = process.argv[1] ?? "";
if (/[\\/]tui\.(tsx|ts|js)$/.test(entry)) {
  const { createRuntime, readConfig } = await import("./runtime.js");
  try {
    const runtime = await createRuntime(readConfig());
    const code = await runTui(runtime);
    await runtime.shutdown();
    process.exitCode = code;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
