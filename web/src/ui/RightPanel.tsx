"use client";

/**
 * 右侧多功能面板：文件 / 终端 / 任务。
 *
 * - 文件：静态文件树（尚未接入真实目录读取）
 * - 终端：纯黑展示框（当前没有终端执行工具）
 * - 任务：可勾选的 Todo 列表
 */

import { useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileText,
  FolderOpen,
  Square,
  Terminal as TerminalIcon,
} from "lucide-react";

type Tab = "files" | "terminal" | "tasks";

const TABS: { id: Tab; label: string }[] = [
  { id: "files", label: "文件" },
  { id: "terminal", label: "终端" },
  { id: "tasks", label: "任务" },
];

interface Todo {
  id: string;
  text: string;
  done: boolean;
}

const INITIAL_TODOS: Todo[] = [
  { id: "t1", text: "接通 Web UI 与后端 SSE", done: true },
  { id: "t2", text: "实现 Token 级流式输出", done: true },
  { id: "t3", text: "补全设置弹窗与配置热更新", done: true },
  { id: "t4", text: "对齐 DSH 三栏可拖拽布局", done: false },
  { id: "t5", text: "接入多智能体与工具链", done: false },
];

export function RightPanel() {
  const [tab, setTab] = useState<Tab>("files");
  const [todos, setTodos] = useState<Todo[]>(INITIAL_TODOS);

  const toggle = (id: string) =>
    setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t)));

  const remaining = todos.filter((t) => !t.done).length;

  return (
    <div className="flex h-full min-w-0 flex-col bg-sidebar">
      {/* Tab 栏 */}
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-line px-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`rounded px-2.5 py-1 text-[12px] transition-colors ${
              tab === t.id
                ? "bg-white/[0.08] text-ink"
                : "text-ink-caption hover:bg-white/[0.04] hover:text-ink-2"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* 文件树 */}
      {tab === "files" ? (
        <div className="min-h-0 flex-1 overflow-y-auto py-2 text-[12.5px]">
          <div className="flex items-center gap-1.5 px-2 py-1 text-ink-3">
            <ChevronDown size={13} />
            <FolderOpen size={13} />
            <span className="truncate">lish</span>
          </div>
          <div className="pl-5">
            <div className="flex items-center gap-1.5 px-2 py-1 text-ink-3">
              <ChevronDown size={13} />
              <FolderOpen size={13} />
              <span>src</span>
            </div>
            <div className="pl-5">
              {["app", "components", "lib"].map((d) => (
                <div key={d} className="flex items-center gap-1.5 px-2 py-1 text-ink-caption">
                  <ChevronRight size={12} />
                  <FolderOpen size={12} />
                  <span>{d}</span>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-1.5 px-2 py-1 text-ink-3">
              <FileCode2 size={13} />
              <span>package.json</span>
            </div>
            <div className="flex items-center gap-1.5 px-2 py-1 text-ink-3">
              <FileText size={13} />
              <span>README.md</span>
            </div>
          </div>
        </div>
      ) : null}

      {/* 终端 */}
      {tab === "terminal" ? (
        <div className="min-h-0 flex-1 overflow-hidden bg-black p-3">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] text-ink-caption">
            <TerminalIcon size={12} />
            <span>终端</span>
          </div>
          <pre className="h-full overflow-auto whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-emerald-400/90">
{`$ lish web
  lish web 已启动
  局域网访问: http://192.168.1.166:3899
  静态资源: web/out

$ _
`}
          </pre>
          <p className="mt-2 text-[10.5px] text-ink-caption">
            当前版本仅展示，终端执行能力将在下一阶段接入
          </p>
        </div>
      ) : null}

      {/* 任务 */}
      {tab === "tasks" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 px-3 py-2 text-[11px] text-ink-caption">
            待完成 {remaining} / {todos.length}
          </div>
          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1.5 pb-3">
            {todos.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => toggle(t.id)}
                className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left transition-colors hover:bg-white/[0.04]"
              >
                <span className="mt-0.5 shrink-0">
                  {t.done ? (
                    <span className="flex h-3.5 w-3.5 items-center justify-center rounded border border-brand bg-brand">
                      <Check size={9} className="text-white" />
                    </span>
                  ) : (
                    <Square size={14} className="text-ink-caption" />
                  )}
                </span>
                <span
                  className={`min-w-0 text-[12.5px] leading-snug ${
                    t.done ? "text-ink-caption line-through" : "text-ink-2"
                  }`}
                >
                  {t.text}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
