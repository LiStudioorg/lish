/**
 * lish Web UI 主界面。
 *
 * 结构：
 *   ┌ 顶栏：品牌、连接状态
 *   ├ 会话区：assistant-ui 的 Thread
 *   └ 输入区：Composer
 *
 * 风格：极简暗色；工具调用以卡片呈现（调用中 / 已完成 / 失败）。
 */

import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { useLishRuntime, type ToolEventData } from "./runtime-adapter";

// --- 工具卡片 -------------------------------------------------------------

/**
 * 工具调用卡片：区分「进行中 / 已完成 / 失败」三种状态。
 *
 * 数据来自 useAuiState 选中的当前 tool-call part，
 * 这是 assistant-ui 0.15 推荐的读取方式（旧版 useMessagePart 已废弃）。
 */
function ToolCallCard() {
  const part = useAuiState((state) =>
    state.part?.type === "tool-call" ? state.part : null,
  );

  if (!part) return null;

  const name = part.toolName ?? "tool";
  const done = part.result !== undefined || part.isPreliminary === false;
  const isError = part.isError === true;
  const args = (part.args ?? {}) as Record<string, unknown>;
  const resultText =
    typeof part.result === "string" ? part.result : part.result === undefined ? "" : JSON.stringify(part.result);

  return (
    <div
      className={`my-2 rounded-lg border px-3 py-2 text-sm ${
        isError
          ? "border-red-900/60 bg-red-950/30"
          : done
            ? "border-emerald-900/60 bg-emerald-950/20"
            : "border-amber-900/60 bg-amber-950/20"
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          className={`inline-block h-2 w-2 shrink-0 rounded-full ${
            isError ? "bg-red-500" : done ? "bg-emerald-500" : "animate-pulse bg-amber-400"
          }`}
        />
        <span className="font-mono text-xs text-slate-300">{name}</span>
        <span className="text-xs text-slate-500">
          {isError ? "执行失败" : done ? "执行完成" : "正在调用工具…"}
        </span>
      </div>

      {Object.keys(args).length > 0 ? (
        <div className="mt-1 truncate font-mono text-[11px] text-slate-500">
          {JSON.stringify(args)}
        </div>
      ) : null}

      {done ? (
        <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-black/30 p-2 font-mono text-[11px] text-slate-400">
          {resultText || "（空结果）"}
        </pre>
      ) : null}
    </div>
  );
}

// --- 消息渲染 -------------------------------------------------------------

function UserMessage() {
  return (
    <div className="flex justify-end px-4 py-2">
      <div className="max-w-[80%] rounded-2xl rounded-br-md bg-indigo-600/90 px-4 py-2 text-[15px] text-white">
        <MessagePrimitive.Parts />
      </div>
    </div>
  );
}

function AssistantMessage() {
  const isEmpty = useAuiState((state) => {
    const message = state.message;
    if (!message || !("content" in message)) return true;
    return Array.isArray(message.content) && message.content.length === 0;
  });

  return (
    <div className="flex justify-start px-4 py-2">
      <div className="min-w-0 max-w-[85%]">
        <div className="mb-1 flex items-center gap-2 text-[11px] uppercase tracking-wider text-slate-500">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-indigo-400" />
          助手
        </div>
        <div className="rounded-2xl rounded-bl-md border border-ink-800 bg-ink-850 px-4 py-2.5 text-[15px] leading-relaxed text-slate-200">
          {isEmpty ? (
            <span className="text-slate-500">思考中…</span>
          ) : (
            <MessagePrimitive.Parts
              components={{
                Text: ({ text }) => (
                  <p className="whitespace-pre-wrap break-words">{text}</p>
                ),
                tools: {
                  Fallback: ToolCallCard,
                  Override: ToolCallCard,
                },
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// --- 输入区 ---------------------------------------------------------------

function Composer() {
  return (
    <ComposerPrimitive.Root className="mx-auto w-full max-w-3xl px-4 pb-6">
      <div className="flex items-end gap-2 rounded-2xl border border-ink-700 bg-ink-900 p-2 focus-within:border-indigo-600/70">
        <ComposerPrimitive.Input
          placeholder="给 lish 发消息…（Enter 发送，Shift+Enter 换行）"
          className="min-h-[42px] max-h-40 flex-1 resize-none bg-transparent px-3 py-2 text-[15px] text-slate-100 placeholder:text-slate-600 focus:outline-none"
          rows={1}
          autoFocus
        />
        <ThreadPrimitive.If running={false}>
          <ComposerPrimitive.Send className="rounded-xl bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-40">
            发送
          </ComposerPrimitive.Send>
        </ThreadPrimitive.If>
        <ThreadPrimitive.If running>
          <ComposerPrimitive.Cancel className="rounded-xl border border-ink-700 px-4 py-2 text-sm text-slate-300 transition hover:bg-ink-800">
            停止
          </ComposerPrimitive.Cancel>
        </ThreadPrimitive.If>
      </div>
      <p className="mt-2 text-center text-[11px] text-slate-600">
        工具受工作区路径沙箱保护 · 文件读写限制在当前目录内
      </p>
    </ComposerPrimitive.Root>
  );
}

// --- 主体 -----------------------------------------------------------------

export default function App() {
  const { runtime, chat } = useLishRuntime();
  const running = chat.status === "streaming" || chat.status === "submitted";

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex h-full flex-col bg-ink-950">
        {/* 顶栏 */}
        <header className="flex items-center gap-3 border-b border-ink-800 px-5 py-3">
          <h1 className="text-sm font-semibold tracking-wide text-slate-100">lish</h1>
          <span className="text-[11px] text-slate-600">微内核 Agent</span>
          <div className="ml-auto flex items-center gap-2 text-[11px] text-slate-500">
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                running ? "animate-pulse bg-amber-400" : "bg-emerald-500"
              }`}
            />
            {running ? "运行中" : "就绪"}
          </div>
        </header>

        {/* 会话区 */}
        <ThreadPrimitive.Root className="flex-1 overflow-hidden">
          <ThreadPrimitive.Viewport className="h-full overflow-y-auto py-4">
            <ThreadPrimitive.Empty>
              <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
                <p className="text-lg text-slate-300">开始与 lish 对话</p>
                <p className="max-w-md text-sm text-slate-500">
                  模型可以调用工具读写工作区文件。试试「读一下 README.md」，或让它帮你写个脚本。
                </p>
              </div>
            </ThreadPrimitive.Empty>

            <ThreadPrimitive.Messages
              components={{
                UserMessage,
                AssistantMessage,
              }}
            />
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>

        <Composer />
      </div>
    </AssistantRuntimeProvider>
  );
}

/** 供调试：在控制台查看最近一次的工具事件。 */
export type { ToolEventData };
