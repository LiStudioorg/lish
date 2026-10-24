"use client";

/**
 * 设置弹窗（对标 DSH）。
 *
 * 左侧垂直导航 + 右侧内容区：
 *   通用设置 / 模型 / 内置插件 / Agent 预设
 */

import { useEffect, useState } from "react";
import {
  Bot,
  Check,
  KeyRound,
  Palette,
  Plug,
  Puzzle,
  RefreshCw,
  Settings2,
  Sparkles,
  X,
  Loader2,
} from "lucide-react";

import {
  fetchConfig,
  updateConfig,
  fetchPlugins,
  reloadPlugins,
  type ServerConfig,
  type PluginInfo,
} from "../lib/api";

export type ThemeMode = "light" | "dark" | "system";
export type PermissionMode = "workspace" | "full";
export type FontSize = "small" | "medium" | "large";
export type AgentPreset = "standard" | "minimal" | "creative";

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
  plugins: { "fs-tools": true, shell: true, "echo-tool": true, "session-log": true },
};

const TABS = [
  { id: "general", label: "通用设置", icon: Settings2 },
  { id: "model", label: "模型", icon: Sparkles },
  { id: "plugins", label: "内置插件", icon: Plug },
  { id: "manage", label: "插件管理", icon: Puzzle },
  { id: "presets", label: "Agent 预设", icon: Bot },
] as const;

type TabId = (typeof TABS)[number]["id"];

const PRESETS: { id: AgentPreset; name: string; desc: string; badge?: string }[] = [
  { id: "standard", name: "标准模式", desc: "平衡质量与速度，适合日常开发任务", badge: "推荐" },
  { id: "minimal", name: "极简模式", desc: "只回复必要内容，不主动调用工具" },
  { id: "creative", name: "创造模式", desc: "更发散的表达，适合头脑风暴与设计" },
];

/** 单选行。 */
function RadioRow({
  label,
  desc,
  checked,
  onChange,
}: {
  label: string;
  desc?: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onChange}
      className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition-colors hover:bg-white/[0.04]"
    >
      <span
        className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
          checked ? "border-brand bg-brand" : "border-line-strong"
        }`}
      >
        {checked ? <Check size={10} className="text-white" /> : null}
      </span>
      <span className="min-w-0">
        <span className="block text-[13px] text-ink-2">{label}</span>
        {desc ? <span className="mt-0.5 block text-[11.5px] text-ink-caption">{desc}</span> : null}
      </span>
    </button>
  );
}

/** 分段按钮组。 */
function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex rounded-lg border border-line-strong p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={`rounded-md px-3 py-1 text-[12px] transition-colors ${
            value === o.value
              ? "bg-white/10 text-ink"
              : "text-ink-caption hover:text-ink-2"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** 开关。 */
function Toggle({ checked, onChange }: { checked: boolean; onChange: () => void }) {
  return (
    <button
      type="button"
      onClick={onChange}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${
        checked ? "bg-brand" : "bg-layer3"
      }`}
      role="switch"
      aria-checked={checked}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
          checked ? "translate-x-[18px]" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

export function SettingsModal({
  open,
  settings,
  onChange,
  onClose,
  onSaved,
}: {
  open: boolean;
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
  onClose: () => void;
  onSaved: (cfg: ServerConfig | null) => void;
}) {
  const [tab, setTab] = useState<TabId>("general");

  // 模型相关（服务端配置）
  const [server, setServer] = useState<ServerConfig | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [model, setModel] = useState("");
  const [maxSteps, setMaxSteps] = useState(8);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  // 插件管理
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [pluginsLoading, setPluginsLoading] = useState(false);
  const [reloadingId, setReloadingId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    void fetchConfig().then((cfg) => {
      if (!alive || !cfg) return;
      setServer(cfg);
      setBaseURL(cfg.baseURL);
      setModel(cfg.model);
      setMaxSteps(cfg.maxSteps);
      setApiKey("");
      setMessage(null);
    });
    return () => {
      alive = false;
    };
  }, [open]);

  // 切到插件管理页时拉取列表
  useEffect(() => {
    if (!open || tab !== "manage") return;
    let alive = true;
    setPluginsLoading(true);
    void fetchPlugins().then((r) => {
      if (!alive) return;
      setPlugins(r.plugins);
      setPluginsLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [open, tab]);

  /** 热重载一个插件（或全部）。 */
  const doReload = async (id?: string) => {
    setReloadingId(id ?? "__all__");
    const r = await reloadPlugins(id);
    setPlugins(r.plugins);
    setReloadingId(null);
  };

  if (!open) return null;

  const saveModel = async () => {
    setSaving(true);
    setMessage(null);
    const result = await updateConfig({
      model,
      baseURL,
      maxSteps,
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    });
    setSaving(false);
    if (result.ok) {
      setApiKey("");
      setMessage({ ok: true, text: "已保存并生效" });
      const fresh = await fetchConfig();
      setServer(fresh);
      onSaved(fresh);
    } else {
      setMessage({ ok: false, text: result.error ?? "保存失败" });
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="flex h-[560px] w-full max-w-[820px] overflow-hidden rounded-xl border border-line-strong bg-layer1 shadow-[0_24px_70px_rgba(0,0,0,0.6)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 左侧导航 */}
        <nav className="flex w-[168px] shrink-0 flex-col border-r border-line bg-sidebar py-3">
          <div className="px-4 pb-3 text-[12px] font-medium text-ink-3">设置</div>
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`mx-2 flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors ${
                  tab === t.id
                    ? "bg-white/[0.08] text-ink"
                    : "text-ink-3 hover:bg-white/[0.04] hover:text-ink-2"
                }`}
              >
                <Icon size={13} />
                {t.label}
              </button>
            );
          })}
        </nav>

        {/* 右侧内容 */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-11 shrink-0 items-center justify-between border-b border-line px-5">
            <span className="text-[13px] font-medium text-ink">
              {TABS.find((t) => t.id === tab)?.label}
            </span>
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-ink-caption transition-colors hover:bg-white/5 hover:text-ink"
              aria-label="关闭"
            >
              <X size={15} />
            </button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
            {/* ── 通用设置 ── */}
            {tab === "general" ? (
              <div className="space-y-6">
                <section>
                  <h3 className="mb-1 text-[12px] text-ink-3">权限</h3>
                  <div className="rounded-lg border border-line">
                    <RadioRow
                      label="工作区内修改"
                      desc="仅允许读写当前工作区目录内的文件（推荐）"
                      checked={settings.permission === "workspace"}
                      onChange={() => onChange({ permission: "workspace" })}
                    />
                    <div className="mx-3 h-px bg-line" />
                    <RadioRow
                      label="完全权限"
                      desc="允许访问工作区之外的路径，请谨慎开启"
                      checked={settings.permission === "full"}
                      onChange={() => onChange({ permission: "full" })}
                    />
                  </div>
                </section>

                <section>
                  <h3 className="mb-2 flex items-center gap-1.5 text-[12px] text-ink-3">
                    <Palette size={12} />
                    外观
                  </h3>
                  <Segmented
                    value={settings.theme}
                    onChange={(v) => onChange({ theme: v })}
                    options={[
                      { value: "light", label: "浅色" },
                      { value: "dark", label: "深色" },
                      { value: "system", label: "跟随系统" },
                    ]}
                  />
                </section>

                <section>
                  <h3 className="mb-2 text-[12px] text-ink-3">字号大小</h3>
                  <Segmented
                    value={settings.fontSize}
                    onChange={(v) => onChange({ fontSize: v })}
                    options={[
                      { value: "small", label: "小" },
                      { value: "medium", label: "中" },
                      { value: "large", label: "大" },
                    ]}
                  />
                </section>
              </div>
            ) : null}

            {/* ── 模型 ── */}
            {tab === "model" ? (
              <div className="space-y-4">
                <section>
                  <h3 className="mb-2 flex items-center gap-1.5 text-[12px] text-ink-3">
                    <KeyRound size={12} />
                    当前提供商
                  </h3>
                  <div className="rounded-lg border border-line bg-base/40 p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[13px] text-ink-2">
                        {server?.providerName === "mock" ? "Mock（演示）" : "OpenAI 兼容"}
                      </span>
                      <span className="text-[11px] text-ink-caption">
                        {server?.hasApiKey ? `密钥 ${server.apiKeyMasked}` : "未配置密钥"}
                      </span>
                    </div>
                  </div>
                </section>

                <section className="space-y-3">
                  <h3 className="text-[12px] text-ink-3">添加模型提供商</h3>

                  <div>
                    <label className="mb-1.5 block text-[12px] text-ink-caption">Base URL</label>
                    <input
                      value={baseURL}
                      onChange={(e) => setBaseURL(e.target.value)}
                      placeholder="https://api.deepseek.com"
                      spellCheck={false}
                      className="w-full rounded-lg border border-line-strong bg-base px-3 py-2 text-[13px] text-ink outline-none transition-colors focus:border-brand"
                    />
                  </div>

                  <div>
                    <label className="mb-1.5 block text-[12px] text-ink-caption">模型</label>
                    <input
                      value={model}
                      onChange={(e) => setModel(e.target.value)}
                      placeholder="deepseek-chat"
                      spellCheck={false}
                      className="w-full rounded-lg border border-line-strong bg-base px-3 py-2 text-[13px] text-ink outline-none transition-colors focus:border-brand"
                    />
                  </div>

                  <div>
                    <label className="mb-1.5 block text-[12px] text-ink-caption">API Key</label>
                    <input
                      type="password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder={
                        server?.hasApiKey
                          ? `已配置 ${server.apiKeyMasked}（留空不修改）`
                          : "未配置，请输入 sk-..."
                      }
                      autoComplete="off"
                      spellCheck={false}
                      className="w-full rounded-lg border border-line-strong bg-base px-3 py-2 text-[13px] text-ink outline-none transition-colors focus:border-brand"
                    />
                  </div>

                  <div>
                    <label className="mb-1.5 block text-[12px] text-ink-caption">最大步数</label>
                    <input
                      type="number"
                      min={1}
                      max={50}
                      value={maxSteps}
                      onChange={(e) => setMaxSteps(Number(e.target.value))}
                      className="w-full rounded-lg border border-line-strong bg-base px-3 py-2 text-[13px] text-ink outline-none transition-colors focus:border-brand"
                    />
                  </div>

                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => void saveModel()}
                      disabled={saving}
                      className="rounded-lg bg-brand px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                    >
                      {saving ? "保存中…" : "保存"}
                    </button>
                    {message ? (
                      <span
                        className={`text-[12px] ${
                          message.ok ? "text-emerald-400" : "text-red-400"
                        }`}
                      >
                        {message.text}
                      </span>
                    ) : null}
                  </div>
                </section>
              </div>
            ) : null}

            {/* ── 内置插件 ── */}
            {tab === "plugins" ? (
              <div className="space-y-2">
                {[
                  { id: "fs-tools", name: "文件系统工具", desc: "提供 fs.read / fs.write；关闭后模型无法读写文件" },
                  { id: "shell", name: "终端执行", desc: "提供 shell.run 与终端面板；关闭后命令无法执行" },
                  { id: "echo-tool", name: "回显工具", desc: "演示用 echo 工具，仅 Mock 模式可调用" },
                  { id: "session-log", name: "会话日志", desc: "将每轮对话事件持久化为 JSONL" },
                ].map((p) => (
                  <div
                    key={p.id}
                    className="flex items-center justify-between rounded-lg border border-line px-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <div className="text-[13px] text-ink-2">{p.name}</div>
                      <div className="mt-0.5 text-[11.5px] text-ink-caption">{p.desc}</div>
                    </div>
                    <Toggle
                      checked={settings.plugins[p.id] ?? false}
                      onChange={() =>
                        onChange({
                          plugins: {
                            ...settings.plugins,
                            [p.id]: !(settings.plugins[p.id] ?? false),
                          },
                        })
                      }
                    />
                  </div>
                ))}
              </div>
            ) : null}

            {/* ── 插件管理 ── */}
            {tab === "manage" ? (
              <div className="space-y-2">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[11.5px] text-ink-caption">
                    共 {plugins.length} 个插件
                  </span>
                  <button
                    type="button"
                    onClick={() => void doReload()}
                    disabled={reloadingId !== null}
                    className="flex items-center gap-1.5 rounded-lg border border-line-strong px-2.5 py-1 text-[11.5px] text-ink-3 transition-colors hover:bg-white/[0.04] hover:text-ink disabled:opacity-50"
                  >
                    <RefreshCw size={11} className={reloadingId === "__all__" ? "animate-spin" : ""} />
                    全部重载
                  </button>
                </div>

                {pluginsLoading ? (
                  <div className="flex items-center gap-2 py-4 text-[12px] text-ink-caption">
                    <Loader2 size={13} className="animate-spin" />
                    正在读取插件…
                  </div>
                ) : plugins.length === 0 ? (
                  <div className="rounded-lg border border-line px-3 py-6 text-center text-[12px] text-ink-caption">
                    暂无已加载的插件
                    <div className="mt-1 text-[11px] text-ink-caption/70">
                      将插件放入 ~/.lish/plugins/&lt;id&gt;/patch.json 后重启即可加载
                    </div>
                  </div>
                ) : (
                  plugins.map((p) => (
                    <div key={p.id} className="rounded-lg border border-line px-3 py-2.5">
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-[13px] text-ink-2">{p.name}</span>
                            {p.version ? (
                              <span className="shrink-0 rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] text-ink-caption">
                                v{p.version}
                              </span>
                            ) : null}
                            <span
                              className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] ${
                                p.status === "loaded"
                                  ? "bg-emerald-500/15 text-emerald-400"
                                  : p.status === "error"
                                    ? "bg-red-500/15 text-red-400"
                                    : "bg-white/[0.06] text-ink-caption"
                              }`}
                            >
                              {p.status === "loaded"
                                ? "已启用"
                                : p.status === "error"
                                  ? "报错"
                                  : "已禁用"}
                            </span>
                          </div>
                          <div className="mt-1 truncate font-mono text-[11px] text-ink-caption">
                            {p.id} · {p.module}
                          </div>
                          {p.error ? (
                            <div className="mt-1 break-words text-[11px] text-red-400">{p.error}</div>
                          ) : null}
                        </div>
                        <button
                          type="button"
                          onClick={() => void doReload(p.id)}
                          disabled={reloadingId !== null}
                          className="flex shrink-0 items-center gap-1 rounded-md border border-line-strong px-2 py-1 text-[11px] text-ink-3 transition-colors hover:bg-white/[0.05] hover:text-ink disabled:opacity-50"
                          title="热重载该插件"
                        >
                          <RefreshCw
                            size={10}
                            className={reloadingId === p.id ? "animate-spin" : ""}
                          />
                          重载
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
            ) : null}

            {/* ── Agent 预设 ── */}
            {tab === "presets" ? (
              <div className="space-y-2">
                {PRESETS.map((p) => {
                  const active = settings.agentPreset === p.id;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => onChange({ agentPreset: p.id })}
                      className={`flex w-full items-start gap-3 rounded-lg border px-3 py-3 text-left transition-colors ${
                        active
                          ? "border-brand/70 bg-brand/10"
                          : "border-line hover:bg-white/[0.03]"
                      }`}
                    >
                      <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-white/[0.06]">
                        <Bot size={13} className={active ? "text-brand-soft" : "text-ink-caption"} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className="text-[13px] text-ink-2">{p.name}</span>
                          {p.badge ? (
                            <span className="rounded bg-brand/20 px-1.5 py-0.5 text-[10px] text-brand-soft">
                              {p.badge}
                            </span>
                          ) : null}
                        </span>
                        <span className="mt-0.5 block text-[11.5px] text-ink-caption">
                          {p.desc}
                        </span>
                      </span>
                      {active ? <Check size={14} className="mt-1 shrink-0 text-brand-soft" /> : null}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
