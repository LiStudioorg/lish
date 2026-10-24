"use client";

/**
 * 轨迹面板（Trace）。
 *
 * 左栏：微型耗时条形图 + 虚拟列表时间轴
 * 右栏：五 Tab 详情（概述 / 参数 / 结果 / Schema / 计时）
 *
 * 性能约束（AGENTS.md 第 4 条）：
 *   - 时间轴使用 @tanstack/react-virtual 窗口化，1000+ 事件不卡顿；
 *   - 面板组件用 memo + 稳定的 props，事件追加时不重渲染整个列表。
 *
 * 安全约束（AGENTS.md 第 3 条）：
 *   - JSON 与文本一律走 pre/code 文本渲染，不使用 dangerouslySetInnerHTML；
 *   - 渲染前对可能的密钥做脱敏。
 */

import { memo, useCallback, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { JsonView, darkStyles } from "react-json-view-lite";
import "react-json-view-lite/dist/index.css";
import {
  AlertTriangle,
  ArrowRightLeft,
  CheckCircle2,
  Clock,
  Sparkles,
  Wrench,
  XCircle,
} from "lucide-react";

import type { TraceEvent } from "../lib/api";
import { ErrorBoundary } from "./ErrorBoundary";

// --- 工具函数 -------------------------------------------------------------

/** 密钥脱敏：避免 API Key 混入工具参数被展示（AGENTS.md 第 3 条）。 */
function maskSecrets(text: string): string {
  return text
    .replace(/\b(sk-[A-Za-z0-9_-]{4})[A-Za-z0-9_-]{8,}/g, "$1…[已脱敏]")
    .replace(/("?(?:api[_-]?key|authorization|token)"?\s*[:=]\s*")([^"]{6,})"/gi, '$1[已脱敏]"');
}

/** 尝试解析 JSON；失败时返回解析错误标记（降级而不抛错）。 */
function safeParseJson(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** 事件配色与图标。 */
function eventVisual(type: TraceEvent["type"]): {
  color: string;
  bg: string;
  label: string;
} {
  switch (type) {
    case "step.thinking":
      return { color: "text-violet-300", bg: "bg-violet-500", label: "思考" };
    case "tool.call":
    case "tool.result":
      return { color: "text-amber-300", bg: "bg-amber-500", label: "工具" };
    case "answer":
      return { color: "text-emerald-300", bg: "bg-emerald-500", label: "回答" };
    case "run.start":
    case "run.end":
      return { color: "text-sky-300", bg: "bg-sky-500", label: "运行" };
    case "error":
      return { color: "text-red-300", bg: "bg-red-500", label: "错误" };
    default:
      return { color: "text-ink-3", bg: "bg-layer3", label: "事件" };
  }
}

function EventIcon({ type }: { type: TraceEvent["type"] }) {
  const cls = "shrink-0";
  switch (type) {
    case "step.thinking":
      return <Sparkles size={12} className={`${cls} text-violet-400`} />;
    case "tool.call":
    case "tool.result":
      return <Wrench size={12} className={`${cls} text-amber-400`} />;
    case "answer":
      return <CheckCircle2 size={12} className={`${cls} text-emerald-400`} />;
    case "run.start":
    case "run.end":
      return <ArrowRightLeft size={12} className={`${cls} text-sky-400`} />;
    case "error":
      return <XCircle size={12} className={`${cls} text-red-400`} />;
    default:
      return <Clock size={12} className={`${cls} text-ink-caption`} />;
  }
}

/** 生成时间轴单行摘要：`[类型] 名称 {参数} -> 结果`。 */
function summarize(e: TraceEvent): string {
  const parts: string[] = [];
  if (e.toolName) parts.push(maskSecrets(e.toolName));
  else parts.push(e.title);
  if (e.args && Object.keys(e.args).length > 0) {
    parts.push(`{${maskSecrets(JSON.stringify(e.args)).slice(0, 60)}}`);
  }
  if (e.result) parts.push(`→ ${maskSecrets(e.result).slice(0, 50)}`);
  return parts.join(" ");
}

// --- 时间轴行（memo 化，避免追加事件时全量重渲染）-------------------------

interface RowProps {
  event: TraceEvent;
  active: boolean;
  onSelect: (id: string) => void;
}

const TimelineRow = memo(function TimelineRow({ event, active, onSelect }: RowProps) {
  const v = eventVisual(event.type);
  return (
    <button
      type="button"
      onClick={() => onSelect(event.id)}
      className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left transition-colors ${
        active ? "bg-white/[0.09]" : "hover:bg-white/[0.04]"
      }`}
      title={summarize(event)}
    >
      <EventIcon type={event.type} />
      <span className={`shrink-0 text-[10.5px] uppercase tracking-wide ${v.color}`}>
        {v.label}
      </span>
      <span className="shrink-0 text-[10.5px] text-ink-caption">#{event.step}</span>
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-3">
        {summarize(event)}
      </span>
      <span className="shrink-0 font-mono text-[10.5px] text-ink-caption">
        {event.duration > 0 ? `${event.duration}ms` : ""}
      </span>
    </button>
  );
});

// --- 详情面板的五个 Tab ---------------------------------------------------

type DetailTab = "summary" | "args" | "result" | "schema" | "timing";

const DETAIL_TABS: { id: DetailTab; label: string }[] = [
  { id: "summary", label: "概述" },
  { id: "args", label: "参数" },
  { id: "result", label: "结果" },
  { id: "schema", label: "Schema" },
  { id: "timing", label: "计时" },
];

/** 键值行。 */
function KV({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-2 py-1">
      <span className="w-24 shrink-0 text-[11.5px] text-ink-caption">{k}</span>
      <span className="min-w-0 flex-1 break-all font-mono text-[11.5px] text-ink-2">{v}</span>
    </div>
  );
}

/** JSON 展示：解析失败时降级为原始文本（不白屏）。 */
function JsonBlock({ value, raw }: { value?: unknown; raw?: string }) {
  // 若传入的是字符串，先尝试解析
  const parsed = useMemo(() => {
    if (value !== undefined) return { ok: true as const, value };
    if (raw !== undefined) return safeParseJson(raw);
    return { ok: true as const, value: {} };
  }, [value, raw]);

  if (!parsed.ok) {
    return (
      <div className="space-y-1.5">
        <div className="flex items-center gap-1.5 text-[11.5px] text-amber-400">
          <AlertTriangle size={12} />
          JSON 解析失败，已降级为原始文本
        </div>
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-black/40 p-2 font-mono text-[11px] text-ink-3">
          {maskSecrets(raw ?? "")}
        </pre>
      </div>
    );
  }

  const safeValue =
    typeof parsed.value === "string" ? safeParseJson(parsed.value) : parsed;
  if (!safeValue.ok) {
    return (
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-black/40 p-2 font-mono text-[11px] text-ink-3">
        {maskSecrets(raw ?? String(parsed.value))}
      </pre>
    );
  }

  return (
    <div className="max-h-64 overflow-auto rounded bg-black/30 p-2">
      <JsonView
        data={safeValue.value as never}
        style={{
          ...darkStyles,
          container: "bg-transparent font-mono text-[11px]",
        }}
      />
    </div>
  );
}

/** 单个详情 Tab 的内容（各自被 ErrorBoundary 包裹）。 */
function DetailContent({ tab, event }: { tab: DetailTab; event: TraceEvent }) {
  if (tab === "summary") {
    return (
      <div>
        <KV k="类型" v={event.type} />
        <KV k="第几轮" v={String(event.step)} />
        <KV k="traceId" v={event.traceId} />
        <KV k="发生时间" v={new Date(event.timestamp).toLocaleString("zh-CN")} />
        <KV k="耗时" v={`${event.duration}ms`} />
        <KV k="Token 入" v={String(event.tokenUsage?.inputTokens ?? "-")} />
        <KV k="Token 出" v={String(event.tokenUsage?.outputTokens ?? "-")} />
        {event.toolName ? <KV k="工具" v={event.toolName} /> : null}
        {event.callId ? <KV k="调用 id" v={event.callId} /> : null}
        {event.isError ? (
          <div className="mt-2 flex items-center gap-1.5 text-[11.5px] text-red-400">
            <XCircle size={12} />
            该工具执行失败
          </div>
        ) : null}
      </div>
    );
  }

  if (tab === "args") {
    return event.args ? (
      <JsonBlock value={event.args} />
    ) : (
      <p className="text-[11.5px] text-ink-caption">该事件没有参数。</p>
    );
  }

  if (tab === "result") {
    if (!event.result) return <p className="text-[11.5px] text-ink-caption">该事件没有结果。</p>;
    return (
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded bg-black/30 p-2 font-mono text-[11px] text-ink-2">
        {maskSecrets(event.result)}
      </pre>
    );
  }

  if (tab === "schema") {
    return event.schema ? (
      <JsonBlock value={event.schema} />
    ) : (
      <p className="text-[11.5px] text-ink-caption">该工具未声明 JSON Schema。</p>
    );
  }

  // timing
  const t = event.tokenUsage;
  return (
    <div>
      <KV k="开始时间" v={new Date(event.timestamp).toLocaleTimeString("zh-CN")} />
      <KV k="总耗时" v={`${event.duration}ms`} />
      <KV k="首 Token 延迟" v={t?.firstTokenMs !== undefined ? `${t.firstTokenMs}ms` : "-"} />
      <KV k="tok/s" v={t?.tokensPerSecond !== undefined ? String(t.tokensPerSecond) : "-"} />
      <KV k="输出 Token" v={String(t?.outputTokens ?? "-")} />
    </div>
  );
}

// --- 主面板 ---------------------------------------------------------------

export function TracePanel({ events }: { events: TraceEvent[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>("summary");
  const scrollRef = useRef<HTMLDivElement>(null);

  const selected = useMemo(
    () => events.find((e) => e.id === selectedId) ?? null,
    [events, selectedId],
  );

  // 虚拟列表：固定行高 26px，视口外不渲染
  const virtualizer = useVirtualizer({
    count: events.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 26,
    overscan: 12,
  });

  const maxDuration = useMemo(
    () => events.reduce((m, e) => Math.max(m, e.duration), 0) || 1,
    [events],
  );

  const onSelect = useCallback((id: string) => setSelectedId(id), []);

  if (events.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-ink-caption">
        暂无轨迹事件，发送一条消息后即可查看
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      {/* 左：时间轴 */}
      <div className="flex w-[46%] min-w-0 flex-col border-r border-line">
        {/* 微型耗时条形图 */}
        <div className="shrink-0 border-b border-line px-2 py-1.5">
          <div className="mb-1 flex items-center justify-between text-[10px] text-ink-caption">
            <span>耗时分布</span>
            <span>最长 {maxDuration}ms</span>
          </div>
          <div className="flex h-6 items-end gap-[2px]">
            {events.slice(-80).map((e) => {
              const h = Math.max(2, Math.round((e.duration / maxDuration) * 24));
              const v = eventVisual(e.type);
              return (
                <div
                  key={e.id}
                  className={`flex-1 rounded-sm ${v.bg} ${e.id === selectedId ? "opacity-100" : "opacity-60"}`}
                  style={{ height: `${h}px` }}
                  title={`${e.title} · ${e.duration}ms`}
                />
              );
            })}
          </div>
        </div>

        {/* 虚拟化事件列表 */}
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto py-1">
          <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const e = events[vi.index];
              if (!e) return null;
              return (
                <div
                  key={e.id}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: `${vi.size}px`,
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  <TimelineRow event={e} active={e.id === selectedId} onSelect={onSelect} />
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* 右：详情 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {!selected ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-[12px] text-ink-caption">
            点击左侧事件查看详情
          </div>
        ) : (
          <>
            <div className="shrink-0 border-b border-line px-3 py-2">
              <div className="flex items-center gap-2">
                <EventIcon type={selected.type} />
                <span className="truncate text-[12.5px] text-ink-2">{selected.title}</span>
                <span className="ml-auto shrink-0 text-[10.5px] text-ink-caption">
                  第 {selected.step} 轮
                </span>
              </div>
            </div>

            <div className="flex shrink-0 gap-0.5 border-b border-line px-1.5 py-1">
              {DETAIL_TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={`rounded px-2 py-0.5 text-[11.5px] transition-colors ${
                    tab === t.id
                      ? "bg-white/[0.08] text-ink"
                      : "text-ink-caption hover:bg-white/[0.04] hover:text-ink-2"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <ErrorBoundary label={`详情-${tab}`}>
                <DetailContent tab={tab} event={selected} />
              </ErrorBoundary>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
