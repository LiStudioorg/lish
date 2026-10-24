"use client";

/**
 * 设置弹窗。
 *
 * 左侧垂直导航 + 右侧内容区：
 *   通用设置 / 模型 / 内置插件 / Agent 预设
 */

import { useCallback, useState } from "react";
import {
  Bot,
  Check,
  Palette,
  Plug,
  Puzzle,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Settings2,
  Sparkles,
  Trash2,
  X,
  Loader2,
} from "lucide-react";

import {
  fetchConfig,
  fetchModels,
  updateConfig,
  fetchPlugins,
  reloadPlugins,
  saveProvider,
  deleteProvider,
  activateProvider,
  type ServerConfig,
  type PluginInfo,
  type ProviderInfo,
} from "../lib/api";

/**
 * 设置类型统一来自 `lib/settings.ts`，此处只做再导出，
 * 避免出现两份定义导致 preset 等枚举不一致。
 */
export type {
  ThemeMode,
  PermissionMode,
  FontSize,
  AgentPreset,
  AppSettings,
} from "../lib/settings";
export { defaultSettings } from "../lib/settings";

import { PRESET_META, type AppSettings } from "../lib/settings";
import { useAppStore } from "../lib/store";

const TABS = [
  { id: "general", label: "通用设置", icon: Settings2 },
  { id: "model", label: "模型", icon: Sparkles },
  { id: "plugins", label: "内置插件", icon: Plug },
  { id: "manage", label: "插件管理", icon: Puzzle },
  { id: "presets", label: "Agent 预设", icon: Bot },
] as const;

type TabId = (typeof TABS)[number]["id"];

/** 预设元信息统一来自 lib/settings，保证与状态栏下拉完全一致。 */
const PRESETS = PRESET_META;

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
  const [maxSteps, setMaxSteps] = useState(8);
  const [maxStepsMsg, setMaxStepsMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  // 多提供商管理：列表 + 正在编辑的表单（"new" 表示新增）
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [activeProviderId, setActiveProviderId] = useState<string | undefined>();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({
    name: "",
    baseURL: "",
    model: "",
    apiKey: "",
  });
  /** 已拉取到的可选模型；null 表示尚未拉取（此时展示普通输入框）。 */
  const [modelOptions, setModelOptions] = useState<string[] | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelHint, setModelHint] = useState("");

  /** 正在编辑的那条提供商（新增时为 undefined）。 */
  const editingProvider =
    editingId && editingId !== "new"
      ? providers.find((p) => p.id === editingId)
      : undefined;

  // 插件管理
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [pluginsLoading, setPluginsLoading] = useState(false);
  const [reloadingId, setReloadingId] = useState<string | null>(null);

  /**
   * 打开弹窗时把 store 里的配置同步为本地草稿。
   *
   * 同步动作放在 `open` 变化的**渲染期**（React 官方的「派生 state」模式）：
   * 用上一次的 open 值做比较，只在 false→true 那一帧调整一次，
   * 既不触发级联渲染，也避免 setTimeout 之类的时序把戏。
   */
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      const cfg = useAppStore.getState().serverCfg;
      if (cfg) {
        setMaxSteps(cfg.maxSteps);
        setProviders(cfg.providers ?? []);
        setActiveProviderId(cfg.activeProviderId);
      }
      setMessage(null);
      setMaxStepsMsg("");
      setEditingId(null);
      setModelOptions(null);
      setModelHint("");
    }
  }

  /** 切到插件管理页时拉取列表（在点击回调里触发，不在 effect 里同步 setState）。 */
  const loadPluginList = useCallback(() => {
    setPluginsLoading(true);
    void fetchPlugins().then((r) => {
      setPlugins(r.plugins);
      setPluginsLoading(false);
    });
  }, []);

  /** 热重载一个插件（或全部）。 */
  const doReload = async (id?: string) => {
    setReloadingId(id ?? "__all__");
    const r = await reloadPlugins(id);
    setPlugins(r.plugins);
    setReloadingId(null);
  };

  if (!open) return null;

  /** 把服务端返回的最新提供商列表写回本地状态。 */
  const applyProviders = (r: {
    providers: ProviderInfo[];
    activeProviderId?: string;
  }) => {
    setProviders(r.providers);
    setActiveProviderId(r.activeProviderId);
  };

  /** 打开「新增」表单。 */
  const startCreate = () => {
    setEditingId("new");
    setForm({ name: "", baseURL: "", model: "", apiKey: "" });
    setModelOptions(null);
    setModelHint("");
    setMessage(null);
  };

  /** 打开「编辑」表单（密钥不回填，留空即不修改）。 */
  const startEdit = (p: ProviderInfo) => {
    setEditingId(p.id);
    setForm({ name: p.name, baseURL: p.baseURL, model: p.model, apiKey: "" });
    setModelOptions(null);
    setModelHint("");
    setMessage(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setMessage(null);
  };

  /**
   * 一键获取模型列表。
   *
   * 优先用表单里（可能尚未保存）的 Base URL 与 Key；
   * 编辑既有提供商且 Key 留空时，交由服务端用已保存的密钥补齐。
   */
  const doFetchModels = async () => {
    setFetchingModels(true);
    setModelHint("");
    const r = await fetchModels(
      form.baseURL,
      form.apiKey.trim() || (editingProvider?.hasApiKey ? undefined : ""),
    );
    setFetchingModels(false);
    if (r.ok) {
      setModelOptions(r.models);
      if (!r.models.includes(form.model)) {
        setForm((f) => ({ ...f, model: r.models[0] }));
      }
      setModelHint(`已获取 ${r.models.length} 个可用模型`);
    } else {
      setModelOptions(null);
      setModelHint(
        r.error
          ? `获取失败，请手动输入模型名（${r.error}）`
          : "获取失败，请手动输入模型名",
      );
    }
  };

  /** 保存提供商（新增或更新）。 */
  const saveProviderForm = async () => {
    if (!form.baseURL.trim()) {
      setMessage({ ok: false, text: "Base URL 不能为空" });
      return;
    }
    setSaving(true);
    setMessage(null);
    const r = await saveProvider({
      ...(editingId && editingId !== "new" ? { id: editingId } : {}),
      name: form.name.trim(),
      baseURL: form.baseURL.trim(),
      model: form.model.trim(),
      ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
    });
    setSaving(false);
    if (r.ok) {
      applyProviders(r);
      setEditingId(null);
      setModelOptions(null);
      setMessage({ ok: true, text: "已保存并生效" });
      onSaved(await fetchConfig());
    } else {
      setMessage({ ok: false, text: r.error ?? "保存失败" });
    }
  };

  /** 切换激活的提供商（热生效，无需重启）。 */
  const doActivate = async (id: string) => {
    const r = await activateProvider(id);
    if (r.ok) {
      applyProviders(r);
      onSaved(await fetchConfig());
    } else {
      setMessage({ ok: false, text: r.error ?? "启用失败" });
    }
  };

  /** 删除提供商；正在编辑它时同步关闭表单。 */
  const doDelete = async (id: string) => {
    const r = await deleteProvider(id);
    if (r.ok) {
      applyProviders(r);
      if (editingId === id) setEditingId(null);
      onSaved(await fetchConfig());
    } else {
      setMessage({ ok: false, text: r.error ?? "删除失败" });
    }
  };

  /** 最大步数是运行时参数，不归属任何提供商，单独保存。 */
  const saveMaxSteps = async () => {
    setSaving(true);
    setMaxStepsMsg("");
    const r = await updateConfig({ maxSteps });
    setSaving(false);
    if (r.ok) {
      setMaxStepsMsg("已保存");
      onSaved(await fetchConfig());
    } else {
      setMaxStepsMsg("");
      setMessage({ ok: false, text: r.error ?? "保存失败" });
    }
  };

  /** 常用提供商的 Base URL 预设，省去手打。 */
  const PROVIDER_PRESETS = [
    { name: "DeepSeek", baseURL: "https://api.deepseek.com" },
    { name: "OpenAI", baseURL: "https://api.openai.com/v1" },
    { name: "Ollama", baseURL: "http://127.0.0.1:11434/v1" },
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      {/*
        窄屏（<640px）改为竖排：导航变成顶部横向 Tab 条，
        内容区占满剩余高度。这样在 390px 宽的手机上不会出现
        「左侧 168px 固定列把内容挤到只剩 200px」的折行灾难。
      */}
      <div
        className="flex h-[min(560px,calc(100dvh-2rem))] w-full max-w-[820px] flex-col overflow-hidden rounded-xl border border-line-strong bg-layer1 shadow-[0_24px_70px_rgba(0,0,0,0.6)] sm:flex-row"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 左侧导航 */}
        <nav className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-line bg-sidebar p-2 sm:w-[168px] sm:flex-col sm:gap-0 sm:overflow-visible sm:border-b-0 sm:border-r sm:py-3 sm:px-0">
          <div className="hidden px-4 pb-3 text-[12px] font-medium text-ink-3 sm:block">
            设置
          </div>
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  setTab(t.id);
                  // 插件管理页按需加载列表（在交互回调里发起，避免 effect 内 setState）
                  if (t.id === "manage" && plugins.length === 0) loadPluginList();
                }}
                className={`mx-1 flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1.5 text-left text-[12.5px] transition-colors sm:mx-2 sm:gap-2 ${
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
                  <div className="mb-2 flex items-center justify-between">
                    <h3 className="flex items-center gap-1.5 text-[12px] text-ink-3">
                      <Server size={12} />
                      模型提供商
                    </h3>
                    <button
                      type="button"
                      onClick={startCreate}
                      className="flex items-center gap-1 rounded-md border border-line-strong px-2 py-1 text-[11px] text-ink-2 transition-colors hover:border-brand hover:text-brand"
                    >
                      <Plus size={11} />
                      添加提供商
                    </button>
                  </div>

                  {providers.length === 0 && !editingId ? (
                    <div className="rounded-lg border border-dashed border-line-strong px-3 py-4 text-center text-[12px] text-ink-caption">
                      还没有任何提供商，点击右上角「添加提供商」开始配置。
                    </div>
                  ) : null}

                  <div className="space-y-1.5">
                    {providers.map((p) => {
                      const isActive = p.id === activeProviderId;
                      return (
                        <div
                          key={p.id}
                          className={`flex items-center gap-2 rounded-lg border px-2.5 py-2 transition-colors ${
                            isActive
                              ? "border-brand/60 bg-brand/5"
                              : "border-line bg-base/40 hover:border-line-strong"
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => void doActivate(p.id)}
                            title={isActive ? "当前使用中" : "点击启用"}
                            aria-label={isActive ? "当前使用中" : "启用该提供商"}
                            className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border transition-colors ${
                              isActive
                                ? "border-brand bg-brand text-white"
                                : "border-line-strong text-transparent hover:border-brand"
                            }`}
                          >
                            <Check size={10} />
                          </button>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate text-[12.5px] text-ink">
                                {p.name}
                              </span>
                              {isActive ? (
                                <span className="shrink-0 rounded bg-brand/15 px-1 text-[10px] text-brand">
                                  使用中
                                </span>
                              ) : null}
                            </div>
                            <div className="truncate text-[11px] text-ink-caption">
                              {p.model || "未选模型"} · {p.baseURL}
                              {p.hasApiKey ? "" : " · 未配置密钥"}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => startEdit(p)}
                            className="shrink-0 rounded p-1 text-ink-caption transition-colors hover:text-ink"
                            aria-label="编辑"
                          >
                            <Pencil size={12} />
                          </button>
                          <button
                            type="button"
                            onClick={() => void doDelete(p.id)}
                            className="shrink-0 rounded p-1 text-ink-caption transition-colors hover:text-red-400"
                            aria-label="删除"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </section>

                {editingId !== null ? (
                  <section className="space-y-3 rounded-lg border border-line bg-base/40 p-3">
                    <h3 className="text-[12px] text-ink-3">
                      {editingId === "new" ? "新增提供商" : "编辑提供商"}
                    </h3>

                    <div>
                      <label className="mb-1.5 block text-[12px] text-ink-caption">名称</label>
                      <input
                        value={form.name}
                        onChange={(e) => setForm({ ...form, name: e.target.value })}
                        placeholder="DeepSeek 官方"
                        spellCheck={false}
                        className="w-full rounded-lg border border-line-strong bg-base px-3 py-2 text-[13px] text-ink outline-none transition-colors focus:border-brand"
                      />
                    </div>

                    <div>
                      <label className="mb-1.5 block text-[12px] text-ink-caption">Base URL</label>
                      <input
                        value={form.baseURL}
                        onChange={(e) => setForm({ ...form, baseURL: e.target.value })}
                        placeholder="https://api.deepseek.com"
                        spellCheck={false}
                        className="w-full rounded-lg border border-line-strong bg-base px-3 py-2 text-[13px] text-ink outline-none transition-colors focus:border-brand"
                      />
                      {/* 常用地址一键填充，省去手打 */}
                      <div className="mt-1.5 flex flex-wrap gap-1.5">
                        {PROVIDER_PRESETS.map((preset) => (
                          <button
                            key={preset.baseURL}
                            type="button"
                            onClick={() =>
                              setForm((f) => ({
                                ...f,
                                name: f.name || preset.name,
                                baseURL: preset.baseURL,
                              }))
                            }
                            className="rounded border border-line px-1.5 py-0.5 text-[10.5px] text-ink-caption transition-colors hover:border-brand hover:text-brand"
                          >
                            {preset.name}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div>
                      <div className="mb-1.5 flex items-center justify-between">
                        <label className="block text-[12px] text-ink-caption">模型</label>
                        <button
                          type="button"
                          onClick={() => void doFetchModels()}
                          disabled={fetchingModels}
                          className="flex items-center gap-1 rounded-md border border-line-strong px-2 py-1 text-[11px] text-ink-2 transition-colors hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          <RefreshCw size={11} className={fetchingModels ? "animate-spin" : ""} />
                          {fetchingModels ? "获取中…" : "获取可用模型"}
                        </button>
                      </div>
                      {modelOptions && modelOptions.length > 0 ? (
                        <select
                          value={form.model}
                          onChange={(e) => setForm({ ...form, model: e.target.value })}
                          className="w-full rounded-lg border border-line-strong bg-base px-3 py-2 text-[13px] text-ink outline-none transition-colors focus:border-brand"
                        >
                          {modelOptions.map((m) => (
                            <option key={m} value={m}>
                              {m}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          value={form.model}
                          onChange={(e) => setForm({ ...form, model: e.target.value })}
                          placeholder="deepseek-chat"
                          spellCheck={false}
                          className="w-full rounded-lg border border-line-strong bg-base px-3 py-2 text-[13px] text-ink outline-none transition-colors focus:border-brand"
                        />
                      )}
                      {modelHint ? (
                        <p
                          className={`mt-1.5 text-[11px] ${
                            modelOptions ? "text-ink-caption" : "text-danger"
                          }`}
                        >
                          {modelHint}
                        </p>
                      ) : null}
                    </div>

                    <div>
                      <label className="mb-1.5 block text-[12px] text-ink-caption">API Key</label>
                      <input
                        type="password"
                        value={form.apiKey}
                        onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                        placeholder={
                          editingId === "new"
                            ? "sk-...（仅本地保存，权限 0600）"
                            : editingProvider?.hasApiKey
                              ? `已配置 ${editingProvider.apiKeyMasked}（留空不修改）`
                              : "未配置，请输入 sk-..."
                        }
                        autoComplete="off"
                        spellCheck={false}
                        className="w-full rounded-lg border border-line-strong bg-base px-3 py-2 text-[13px] text-ink outline-none transition-colors focus:border-brand"
                      />
                    </div>

                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => void saveProviderForm()}
                        disabled={saving}
                        className="rounded-lg bg-brand px-3 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                      >
                        {saving ? "保存中…" : "保存"}
                      </button>
                      <button
                        type="button"
                        onClick={cancelEdit}
                        className="rounded-lg border border-line-strong px-3 py-1.5 text-[12px] text-ink-2 transition-colors hover:text-ink"
                      >
                        取消
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
                ) : null}

                <section>
                  <label className="mb-1.5 block text-[12px] text-ink-caption">最大步数</label>
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={maxSteps}
                    onChange={(e) => setMaxSteps(Number(e.target.value))}
                    className="w-full rounded-lg border border-line-strong bg-base px-3 py-2 text-[13px] text-ink outline-none transition-colors focus:border-brand"
                  />
                  <p className="mt-1.5 text-[11px] text-ink-caption">
                    单轮 Agent 循环最多执行的步数，保存后立即生效。
                  </p>
                  <div className="mt-2 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => void saveMaxSteps()}
                      disabled={saving}
                      className="rounded-lg border border-line-strong px-3 py-1.5 text-[12px] text-ink-2 transition-colors hover:border-brand hover:text-brand disabled:opacity-50"
                    >
                      保存步数
                    </button>
                    {maxStepsMsg ? (
                      <span className="text-[12px] text-emerald-400">{maxStepsMsg}</span>
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
