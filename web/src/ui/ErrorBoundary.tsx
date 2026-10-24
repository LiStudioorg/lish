"use client";

/**
 * 错误边界。
 *
 * 依据 AGENTS.md 第 2 条：任何渲染异常必须降级为可恢复提示，绝对禁止白屏。
 * 用于包裹轨迹详情面板的各个 Tab，单个 Tab 崩溃不影响整个面板。
 */

import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

interface Props {
  children: ReactNode;
  /** 出错时的区域名称，用于提示文案。 */
  label?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 结构化日志（AGENTS.md 第 5 条），便于定位是哪个 Tab 出错
    console.error(
      JSON.stringify({
        level: "error",
        scope: "ui.error-boundary",
        label: this.props.label ?? "unknown",
        message: error.message,
        componentStack: info.componentStack?.slice(0, 500),
        timestamp: Date.now(),
      }),
    );
  }

  private reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-start gap-2 rounded-lg border border-red-900/60 bg-red-950/20 p-3">
          <div className="flex items-center gap-2 text-[12px] text-red-300">
            <AlertTriangle size={13} />
            {this.props.label ?? "此区域"}渲染失败
          </div>
          <pre className="max-h-24 w-full overflow-auto whitespace-pre-wrap break-all rounded bg-black/30 p-2 font-mono text-[11px] text-red-400/90">
            {this.state.error.message}
          </pre>
          <button
            type="button"
            onClick={this.reset}
            className="flex items-center gap-1.5 rounded-md border border-line-strong px-2 py-1 text-[11.5px] text-ink-3 transition-colors hover:bg-white/5 hover:text-ink"
          >
            <RotateCcw size={11} />
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
