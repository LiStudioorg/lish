"use client";

/**
 * 右侧多功能面板：文件 / 终端 / 任务。
 *
 * - 文件：真实目录树（GET /api/files），带文件类型图标，点击文件弹出带行号的代码预览
 * - 终端：真实执行命令（POST /api/exec），支持 clear、输出着色、危险命令二次确认
 * - 任务：可勾选的 Todo 列表
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  Square,
  Terminal as TerminalIcon,
  X,
} from "lucide-react";

import {
  execCommand,
  fetchFileContent,
  fetchFileTree,
  type FileNode,
} from "../lib/api";

type Tab = "files" | "terminal" | "tasks";

const TABS: { id: Tab; label: string }[] = [
  { id: "files", label: "文件" },
  { id: "terminal", label: "终端" },
  { id: "tasks", label: "任务" },
];

/** 终端里的一条输出记录。 */
interface TermLine {
  id: number;
  kind: "cmd" | "out" | "err" | "info";
  text: string;
}

interface Todo {
  id: string;
  text: string;
  done: boolean;
}

const INITIAL_TODOS: Todo[] = [
  { id: "t1", text: "接通 Web UI 与后端 SSE", done: true },
  { id: "t2", text: "实现 Token 级流式输出", done: true },
  { id: "t3", text: "补全设置弹窗与配置热更新", done: true },
  { id: "t4", text: "三栏可拖拽布局", done: true },
  { id: "t5", text: "接入真实文件树与终端", done: true },
  { id: "t6", text: "接入多智能体与工具链", done: false },
];

/** 危险命令模式：命中即需二次确认。 */
const DANGEROUS = /(^|\s)(rm|rmdir|sudo|mkfs|dd|shutdown|reboot|kill|killall|chmod|chown)\b|>\s*\/dev\/|\bgit\s+push\s+--force\b/;

/** 根据文件名给图标。 */
function iconFor(name: string, type: "file" | "dir", open: boolean) {
  if (type === "dir") {
    return open ? (
      <FolderOpen size={13} className="text-[#8ab4f8]" />
    ) : (
      <Folder size={13} className="text-[#8ab4f8]" />
    );
  }
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name)) return <FileCode2 size={13} className="text-[#4fc1ff]" />;
  if (/\.json$/.test(name)) return <FileJson size={13} className="text-[#e2c08d]" />;
  if (/\.(md|txt)$/.test(name)) return <FileText size={13} className="text-[#9aa4b2]" />;
  if (/\.(png|jpe?g|gif|webp|svg|ico)$/.test(name)) return <ImageIcon size={13} className="text-[#c792ea]" />;
  if (/\.(css|scss)$/.test(name)) return <FileText size={13} className="text-[#42b883]" />;
  return <FileText size={13} className="text-ink-caption" />;
}

/** 代码预览弹层（带行号）。 */
function FilePreview({
  path,
  content,
  loading,
  error,
  onClose,
}: {
  path: string;
  content: string;
  loading: boolean;
  error?: string;
  onClose: () => void;
}) {
  const lines = content.split("\n");
  return (
    <div className="absolute inset-0 z-30 flex flex-col bg-base/98 backdrop-blur-sm">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-2">
        <FileCode2 size={13} className="text-[#4fc1ff]" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink-2">{path}</span>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-ink-caption transition-colors hover:bg-white/5 hover:text-ink"
          aria-label="关闭预览"
        >
          <X size={13} />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {loading ? (
          <div className="flex items-center gap-2 p-3 text-[12px] text-ink-caption">
            <Loader2 size={13} className="animate-spin" />
            加载中…
          </div>
        ) : error ? (
          <div className="p-3 text-[12px] text-red-400">{error}</div>
        ) : (
          <table className="w-full border-collapse font-mono text-[11.5px] leading-[1.7]">
            <tbody>
              {lines.map((line, i) => (
                <tr key={i} className="hover:bg-white/[0.03]">
                  <td className="w-10 select-none border-r border-line px-2 text-right text-ink-caption/60">
                    {i + 1}
                  </td>
                  <td className="whitespace-pre-wrap break-all px-2 text-ink-2">{line || " "}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/** 递归渲染文件树。 */
function TreeNode({
  node,
  depth,
  onOpenFile,
}: {
  node: FileNode;
  depth: number;
  onOpenFile: (path: string) => void;
}) {
  const [open, setOpen] = useState(depth === 0);

  if (node.type === "dir") {
    const isRoot = depth === 0;
    return (
      <div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-1 rounded px-1.5 py-[3px] text-left transition-colors hover:bg-white/[0.04]"
          style={{ paddingLeft: `${depth * 12 + 6}px` }}
        >
          {open ? (
            <ChevronDown size={12} className="shrink-0 text-ink-caption" />
          ) : (
            <ChevronRight size={12} className="shrink-0 text-ink-caption" />
          )}
          {iconFor(node.name, "dir", open)}
          <span className={`truncate text-[12.5px] ${isRoot ? "text-ink-2" : "text-ink-3"}`}>
            {node.name}
          </span>
        </button>
        {open
          ? (node.children ?? []).map((child) => (
              <TreeNode key={child.path} node={child} depth={depth + 1} onOpenFile={onOpenFile} />
            ))
          : null}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onOpenFile(node.path)}
      className="flex w-full items-center gap-1 rounded px-1.5 py-[3px] text-left transition-colors hover:bg-white/[0.04]"
      style={{ paddingLeft: `${depth * 12 + 18}px` }}
    >
      {iconFor(node.name, "file", false)}
      <span className="truncate text-[12.5px] text-ink-3">{node.name}</span>
    </button>
  );
}

export function RightPanel() {
  const [tab, setTab] = useState<Tab>("files");
  const [todos, setTodos] = useState<Todo[]>(INITIAL_TODOS);

  // 文件树
  const [tree, setTree] = useState<FileNode | null>(null);
  const [loadingTree, setLoadingTree] = useState(false);
  const [treeError, setTreeError] = useState<string | undefined>();

  // 预览
  const [preview, setPreview] = useState<{ path: string; content: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | undefined>();

  // 终端
  const [termLines, setTermLines] = useState<TermLine[]>([]);
  const [cmd, setCmd] = useState("");
  const [running, setRunning] = useState(false);
  const [pendingCmd, setPendingCmd] = useState<string | null>(null);
  const lineId = useRef(0);
  const termRef = useRef<HTMLDivElement>(null);

  /** 拉取文件树；由「文件」Tab 的点击事件触发（不在 effect 内调用）。 */
  const loadTree = useCallback(async () => {
    setLoadingTree(true);
    setTreeError(undefined);
    const res = await fetchFileTree();
    setLoadingTree(false);
    if (res.ok && res.tree) setTree(res.tree);
    else setTreeError("加载文件树失败");
  }, []);



  const openFile = useCallback(async (path: string) => {
    setPreview({ path, content: "" });
    setPreviewLoading(true);
    setPreviewError(undefined);
    const res = await fetchFileContent(path);
    setPreviewLoading(false);
    if (res.ok) setPreview({ path, content: res.content ?? "" });
    else setPreviewError(res.error ?? "读取失败");
  }, []);

  const pushLine = (kind: TermLine["kind"], text: string) => {
    const id = ++lineId.current;
    setTermLines((prev) => [...prev, { id, kind, text }]);
  };

  const runCmd = useCallback(
    async (raw: string) => {
      const command = raw.trim();
      if (!command) return;

      if (command === "clear") {
        setTermLines([]);
        setCmd("");
        return;
      }

      setCmd("");
      pushLine("cmd", `$ ${command}`);
      setRunning(true);
      const res = await execCommand(command);
      setRunning(false);

      if (!res.ok) {
        pushLine("err", res.error ?? "执行失败");
        return;
      }
      if (res.stdout) pushLine("out", res.stdout.replace(/\n$/, ""));
      if (res.stderr) pushLine("err", res.stderr.replace(/\n$/, ""));
      if (res.timedOut) {
        pushLine("info", "命令超过 5 秒，已被强制终止");
      } else if (res.code !== 0) {
        pushLine("info", `退出码 ${res.code} · ${res.durationMs}ms`);
      }
    },
    [],
  );

  const submitCmd = useCallback(() => {
    const command = cmd.trim();
    if (!command || running) return;
    // 危险命令先确认
    if (DANGEROUS.test(command)) {
      setPendingCmd(command);
      return;
    }
    void runCmd(command);
  }, [cmd, running, runCmd]);

  useEffect(() => {
    const el = termRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [termLines]);

  return (
    <div className="relative flex h-full min-w-0 flex-col bg-sidebar">
      {/* Tab 栏 */}
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-line px-1.5">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              setTab(t.id);
              // 文件树按需加载：在用户交互回调里发起，避免 effect 内同步 setState
              if (t.id === "files" && !tree && !loadingTree) void loadTree();
            }}
            className={`rounded px-2.5 py-1 text-[12px] transition-colors ${
              tab === t.id
                ? "bg-white/[0.08] text-ink"
                : "text-ink-caption hover:bg-white/[0.04] hover:text-ink-2"
            }`}
          >
            {t.label}
          </button>
        ))}
        {tab === "files" ? (
          <button
            type="button"
            onClick={() => void loadTree()}
            className="ml-auto rounded p-1 text-ink-caption transition-colors hover:bg-white/5 hover:text-ink"
            title="刷新文件树"
            aria-label="刷新文件树"
          >
            <RefreshCw size={12} className={loadingTree ? "animate-spin" : ""} />
          </button>
        ) : null}
      </div>

      {/* 文件 */}
      {tab === "files" ? (
        <div className="min-h-0 flex-1 overflow-y-auto py-1">
          {loadingTree && !tree ? (
            <div className="flex items-center gap-2 px-3 py-3 text-[12px] text-ink-caption">
              <Loader2 size={13} className="animate-spin" />
              正在读取工作区…
            </div>
          ) : treeError ? (
            <div className="px-3 py-3 text-[12px] text-red-400">{treeError}</div>
          ) : tree ? (
            <TreeNode node={tree} depth={0} onOpenFile={(p) => void openFile(p)} />
          ) : null}
        </div>
      ) : null}

      {/* 终端 */}
      {tab === "terminal" ? (
        <div className="flex min-h-0 flex-1 flex-col bg-black">
          <div
            ref={termRef}
            className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-[11.5px] leading-relaxed"
            onClick={() => document.getElementById("lish-term-input")?.focus()}
          >
            {termLines.length === 0 ? (
              <div className="text-ink-caption/70">
                输入命令后回车执行（支持 clear 清屏，危险命令会二次确认）
              </div>
            ) : (
              termLines.map((l) => (
                <pre
                  key={l.id}
                  className={`whitespace-pre-wrap break-all ${
                    l.kind === "cmd"
                      ? "mt-1 text-[#7ee787]"
                      : l.kind === "err"
                        ? "text-[#ff7b72]"
                        : l.kind === "info"
                          ? "text-ink-caption"
                          : "text-ink-2"
                  }`}
                >
                  {l.text}
                </pre>
              ))
            )}
            {running ? (
              <div className="mt-1 flex items-center gap-1.5 text-amber-400">
                <Loader2 size={11} className="animate-spin" />
                执行中…
              </div>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center gap-1.5 border-t border-line/60 px-2 py-2">
            <TerminalIcon size={12} className="shrink-0 text-[#7ee787]" />
            <input
              id="lish-term-input"
              value={cmd}
              onChange={(e) => setCmd(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitCmd();
                }
              }}
              disabled={running}
              placeholder="输入命令，如 ls"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent font-mono text-[11.5px] text-ink outline-none placeholder:text-ink-caption/60"
            />
            <button
              type="button"
              onClick={submitCmd}
              disabled={running || !cmd.trim()}
              className="shrink-0 rounded bg-brand px-2 py-0.5 text-[11px] text-white disabled:opacity-40"
            >
              执行
            </button>
          </div>
        </div>
      ) : null}

      {/* 任务 */}
      {tab === "tasks" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="shrink-0 px-3 py-2 text-[11px] text-ink-caption">
            待完成 {todos.filter((t) => !t.done).length} / {todos.length}
          </div>
          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1.5 pb-3">
            {todos.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() =>
                  setTodos((prev) => prev.map((x) => (x.id === t.id ? { ...x, done: !x.done } : x)))
                }
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

      {/* 代码预览 */}
      {preview ? (
        <FilePreview
          path={preview.path}
          content={preview.content}
          loading={previewLoading}
          error={previewError}
          onClose={() => setPreview(null)}
        />
      ) : null}

      {/* 危险命令确认 */}
      {pendingCmd ? (
        <div className="absolute inset-0 z-40 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full rounded-xl border border-red-900/60 bg-layer1 p-4 shadow-2xl">
            <div className="mb-2 flex items-center gap-2 text-[13px] text-red-300">
              <AlertTriangle size={15} />
              确认执行危险命令？
            </div>
            <pre className="mb-3 max-h-24 overflow-auto rounded bg-black/40 p-2 font-mono text-[11.5px] text-ink-2">
              {pendingCmd}
            </pre>
            <p className="mb-3 text-[11.5px] text-ink-caption">
              该命令可能删除或修改文件，请确认无误后再继续。
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingCmd(null)}
                className="rounded-lg px-3 py-1.5 text-[12px] text-ink-3 hover:bg-white/5"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => {
                  const c = pendingCmd;
                  setPendingCmd(null);
                  void runCmd(c);
                }}
                className="rounded-lg bg-red-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-red-500"
              >
                仍然执行
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
