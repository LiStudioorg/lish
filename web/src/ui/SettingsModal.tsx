"use client";

/**
 * 设置弹窗。
 *
 * 左侧垂直导航 + 右侧内容区：
 *   通用设置 / 模型 / 内置插件 / Agent 预设
 */

import { useCallback, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
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
  type ProviderPreset,
  PROVIDER_PRESETS,
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
  const [form, setForm] = useState<{
    name: string;
    preset: ProviderPreset;
    baseURL: string;
    model: string;
    apiKey: string;
    models: string[];
  }>({
    name: "",
    preset: "deepseek",
    baseURL: "",
    model: "",
    apiKey: "",
    models: [],
  });
  /** 手动输入新模型名的输入框。 */
  const [newModel, setNewModel] = useState("");
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
    const first = PROVIDER_PRESETS[0]!;
    setForm({
      name: first.label,
      preset: first.id,
      baseURL: first.baseURL,
      model: first.models[0] ?? "",
      apiKey: "",
      models: [...first.models],
    });
    setNewModel("");
    setModelOptions(null);
    setModelHint("");
    setMessage(null);
  };

  /** 打开「编辑」表单（密钥不回填，留空即不修改）。 */
  const startEdit = (p: ProviderInfo) => {
    setEditingId(p.id);
    setForm({
      name: p.name,
      preset: p.preset ?? "custom",
      baseURL: p.baseURL,
      model: p.model,
      apiKey: "",
      models: [...p.models],
    });
    setNewModel("");
    setModelOptions(null);
    setModelHint("");
    setMessage(null);
  };

  /** 选中预设：自动填 Base URL、名称与推荐模型（用户只需补 Key）。 */
  const applyPreset = (id: ProviderPreset) => {
    const preset = PROVIDER_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    setForm((f) => ({
      ...f,
      preset: id,
      // 自定义渠道保留用户已填内容，其它预设直接覆盖
      name: id === "custom" ? f.name : preset.label,
      baseURL: id === "custom" ? f.baseURL : preset.baseURL,
      models: id === "custom" ? f.models : [...preset.models],
      model:
        id === "custom"
          ? f.model
          : (preset.models.find((m) => m === f.model) ?? preset.models[0] ?? ""),
    }));
    setModelOptions(null);
    setModelHint("");
  };

  /** 手动添加一个模型名。 */
  const addModel = () => {
    const v = newModel.trim();
    if (!v) return;
    setForm((f) =>
      f.models.includes(v)
        ? f
        : { ...f, models: [...f.models, v], model: f.model || v },
    );
    setNewModel("");
  };

  /** 勾选/取消「获取到的模型」。 */
  const toggleModel = (m: string) => {
    setForm((f) => {
      const has = f.models.includes(m);
      const models = has ? f.models.filter((x) => x !== m) : [...f.models, m];
      return {
        ...f,
        models,
        model: models.includes(f.model) ? f.model : (models[0] ?? ""),
      };
    });
  };

  /** 直接切换某渠道当前使用的模型（热生效）。 */
  const doSelectModel = async (providerId: string, model: string) => {
    const r = await saveProvider({ id: providerId, model });
    if (r.ok) {
      applyProviders(r);
      onSaved(await fetchConfig());
    } else {
      setMessage({ ok: false, text: r.error ?? "切换失败" });
    }
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

  /** 切换分类；插件管理页按需加载列表（在交互回调里触发，避免 effect 内 setState）。 */
  const selectTab = (id: TabId) => {
    setTab(id);
    if (id === "manage" && plugins.length === 0) loadPluginList();
  };

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          className="fixed inset-0 z-50 bg-base"
          role="dialog"
          aria-modal="true"
          aria-label="设置"
          onClick={onClose}
        >
          {/*
            全屏设置面板（IDE 风格）。
              - 移动端（<768px）：绝对全屏，无任何背景露出
              - 桌面端：整屏铺满，内部用 max-w 限制内容宽度以保持可读性
            动画：整体淡入 + 轻微向上滑动，像独立的 App 页面而非廉价弹窗。
          */}
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="flex h-full w-full flex-col overflow-hidden bg-base"
            onClick={(e) => e.stopPropagation()}
          >
        {/* 固定 Header：标题 + 保存并应用 + 关闭 */}
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line px-4 sm:px-6">
          <Settings2 size={16} className="shrink-0 text-ink-3" />
          <h2 className="text-[15px] font-medium text-ink">设置</h2>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                // 设置类改动是即时生效的（onChange 直接落库），
                // 这里的按钮语义是「确认并回到主界面」，同时给出明确反馈。
                setMessage({ ok: true, text: "已应用" });
                onClose();
              }}
              className="hidden rounded-lg bg-brand px-3 py-1.5 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 sm:block"
            >
              保存并应用
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭设置"
              className="rounded-lg p-1.5 text-ink-caption transition-colors hover:bg-white/5 hover:text-ink"
            >
              <X size={18} />
            </button>
          </div>
        </header>

        {/*
          主体：横向两栏（导航 + 内容）。
          这里是 flex-row，必须包在 Header 之外、与底部 Tab 同级，
          否则桌面端会退化成纵向堆叠，把内容区挤到导航下面。
        */}
        <div className="flex min-h-0 flex-1 flex-row">
          {/*
            导航区：
              - ≥768px：左侧固定竖排导航
              - <768px：隐藏，改用底部 Tab 栏
          */}
          <nav className="hidden shrink-0 border-r border-line bg-sidebar/60 py-4 md:block md:w-[200px]">
          <div className="px-4 pb-2 text-[11px] font-medium uppercase tracking-wide text-ink-caption">
            设置
          </div>
          <div className="space-y-0.5 px-2">
            {TABS.map((t) => {
              const Icon = t.icon;
              const on = tab === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => selectTab(t.id)}
                  aria-current={on ? "page" : undefined}
                  className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-[13px] transition-colors ${
                    on
                      ? "bg-brand/12 text-ink"
                      : "text-ink-3 hover:bg-white/[0.04] hover:text-ink-2"
                  }`}
                >
                  <Icon size={14} className={on ? "text-brand" : ""} />
                  {t.label}
                </button>
              );
            })}
          </div>
          </nav>

          {/* 内容区：独立滚动，表单再长也不会把 Header 顶走 */}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-10 sm:py-8">
              <div className="w-full max-w-[680px]">
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
              <div className="space-y-6">
                <section>
                  <div className="mb-3 flex items-center justify-between">
                    <div>
                      <h3 className="flex items-center gap-1.5 text-[13px] font-medium text-ink-2">
                        <Server size={13} />
                        模型渠道
                      </h3>
                      <p className="mt-0.5 text-[11.5px] text-ink-caption">
                        一个渠道可保存多个模型，聊天时可随时切换
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={startCreate}
                      className="flex shrink-0 items-center gap-1 rounded-lg bg-brand px-2.5 py-1.5 text-[12px] font-medium text-white transition-opacity hover:opacity-90"
                    >
                      <Plus size={12} />
                      添加渠道
                    </button>
                  </div>

                  {providers.length === 0 && !editingId ? (
                    <div className="rounded-xl border border-dashed border-line-strong px-4 py-8 text-center text-[12.5px] text-ink-caption">
                      还没有任何渠道。点击「添加渠道」，选择预设后只需填入 API Key 即可。
                    </div>
                  ) : null}

                  <div className="space-y-2">
                    {providers.map((p) => {
                      const isActive = p.id === activeProviderId;
                      return (
                        <div
                          key={p.id}
                          className={`rounded-xl border px-3.5 py-3 transition-colors ${
                            isActive
                              ? "border-brand/60 bg-brand/5"
                              : "border-line bg-layer1/40 hover:border-line-strong"
                          }`}
                        >
                          <div className="flex items-center gap-2.5">
                            <button
                              type="button"
                              onClick={() => void doActivate(p.id)}
                              title={isActive ? "当前使用中" : "点击启用该渠道"}
                              aria-label={isActive ? "当前使用中" : "启用该渠道"}
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
                                <span className="truncate text-[13px] text-ink">{p.name}</span>
                                {isActive ? (
                                  <span className="shrink-0 rounded bg-brand/15 px-1.5 py-0.5 text-[10px] text-brand">
                                    使用中
                                  </span>
                                ) : null}
                                {p.hasApiKey ? null : (
                                  <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-400">
                                    未配密钥
                                  </span>
                                )}
                              </div>
                              <div className="mt-0.5 truncate text-[11.5px] text-ink-caption">
                                {p.baseURL}
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => startEdit(p)}
                              className="shrink-0 rounded-lg p-1.5 text-ink-caption transition-colors hover:bg-white/5 hover:text-ink"
                              aria-label="编辑渠道"
                            >
                              <Pencil size={13} />
                            </button>
                            <button
                              type="button"
                              onClick={() => void doDelete(p.id)}
                              className="shrink-0 rounded-lg p-1.5 text-ink-caption transition-colors hover:bg-white/5 hover:text-red-400"
                              aria-label="删除渠道"
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>

                          {/* 模型列表：每个模型一行，点一下即切换 */}
                          <div className="mt-2 flex flex-wrap gap-1.5 pl-6.5">
                            {p.models.length === 0 ? (
                              <span className="text-[11.5px] text-ink-caption">未配置模型</span>
                            ) : (
                              p.models.map((m) => {
                                const on = isActive && m === p.model;
                                return (
                                  <button
                                    key={m}
                                    type="button"
                                    onClick={() => void doSelectModel(p.id, m)}
                                    disabled={!isActive}
                                    title={isActive ? "切换到该模型" : "请先启用该渠道"}
                                    className={`rounded-md border px-2 py-0.5 text-[11.5px] font-mono transition-colors ${
                                      on
                                        ? "border-brand bg-brand/15 text-brand"
                                        : "border-line text-ink-3 hover:border-line-strong hover:text-ink-2"
                                    } ${isActive ? "" : "cursor-default opacity-60"}`}
                                  >
                                    {m}
                                  </button>
                                );
                              })
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>

                {editingId !== null ? (
                  <section className="rounded-xl border border-line bg-layer1/60 p-4">
                    <h3 className="mb-3 text-[13px] font-medium text-ink-2">
                      {editingId === "new" ? "新增渠道" : "编辑渠道"}
                    </h3>

                    <div className="space-y-3.5">
                      {/* 预设下拉：选中即自动填 Base URL 与推荐模型 */}
                      <div>
                        <label className="mb-1.5 block text-[12px] text-ink-caption">
                          渠道预设
                        </label>
                        <select
                          value={form.preset}
                          onChange={(e) => applyPreset(e.target.value as ProviderPreset)}
                          className="w-full rounded-lg border border-line-strong bg-base px-3 py-2 text-[13px] text-ink outline-none focus:border-brand"
                        >
                          {PROVIDER_PRESETS.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.label}
                            </option>
                          ))}
                        </select>
                        <p className="mt-1 text-[11px] text-ink-caption">
                          选择预设后会自动填入 Base URL 与推荐模型，你只需补上 API Key。
                        </p>
                      </div>

                      <div className="grid gap-3.5 sm:grid-cols-2">
                        <div>
                          <label className="mb-1.5 block text-[12px] text-ink-caption">
                            名称
                          </label>
                          <input
                            value={form.name}
                            onChange={(e) => setForm({ ...form, name: e.target.value })}
                            placeholder="DeepSeek"
                            spellCheck={false}
                            className="w-full rounded-lg border border-line-strong bg-base px-3 py-2 text-[13px] text-ink outline-none focus:border-brand"
                          />
                        </div>
                        <div>
                          <label className="mb-1.5 block text-[12px] text-ink-caption">
                            API Key
                          </label>
                          <input
                            type="password"
                            value={form.apiKey}
                            onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
                            placeholder={
                              editingProvider?.hasApiKey
                                ? `已配置 ${editingProvider.apiKeyMasked}（留空不修改）`
                                : "sk-...（仅本地保存，权限 0600）"
                            }
                            autoComplete="off"
                            spellCheck={false}
                            className="w-full rounded-lg border border-line-strong bg-base px-3 py-2 text-[13px] text-ink outline-none focus:border-brand"
                          />
                        </div>
                      </div>

                      <div>
                        <label className="mb-1.5 block text-[12px] text-ink-caption">
                          Base URL
                        </label>
                        <input
                          value={form.baseURL}
                          onChange={(e) => setForm({ ...form, baseURL: e.target.value })}
                          placeholder="https://api.deepseek.com"
                          spellCheck={false}
                          className="w-full rounded-lg border border-line-strong bg-base px-3 py-2 text-[13px] text-ink outline-none focus:border-brand"
                        />
                      </div>

                      {/* 多模型编辑 */}
                      <div>
                        <div className="mb-1.5 flex items-center justify-between">
                          <label className="text-[12px] text-ink-caption">
                            模型（可添加多个）
                          </label>
                          <button
                            type="button"
                            onClick={() => void doFetchModels()}
                            disabled={fetchingModels}
                            className="flex items-center gap-1 rounded-md border border-line-strong px-2 py-1 text-[11px] text-ink-2 transition-colors hover:border-brand hover:text-brand disabled:opacity-50"
                          >
                            <RefreshCw size={11} className={fetchingModels ? "animate-spin" : ""} />
                            {fetchingModels ? "获取中…" : "获取可用模型"}
                          </button>
                        </div>

                        {form.models.length > 0 ? (
                          <div className="mb-2 space-y-1">
                            {form.models.map((m) => (
                              <div
                                key={m}
                                className="flex items-center gap-2 rounded-lg border border-line bg-base/50 px-2.5 py-1.5"
                              >
                                <button
                                  type="button"
                                  onClick={() => setForm({ ...form, model: m })}
                                  aria-label={`选择模型 ${m}`}
                                  className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border transition-colors ${
                                    form.model === m
                                      ? "border-brand bg-brand text-white"
                                      : "border-line-strong text-transparent"
                                  }`}
                                >
                                  <Check size={9} />
                                </button>
                                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink-2">
                                  {m}
                                </span>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setForm((f) => {
                                      const models = f.models.filter((x) => x !== m);
                                      return {
                                        ...f,
                                        models,
                                        model: f.model === m ? (models[0] ?? "") : f.model,
                                      };
                                    })
                                  }
                                  className="shrink-0 rounded p-0.5 text-ink-caption hover:text-red-400"
                                  aria-label={`移除模型 ${m}`}
                                >
                                  <X size={12} />
                                </button>
                              </div>
                            ))}
                          </div>
                        ) : null}

                        <div className="flex gap-2">
                          <input
                            value={newModel}
                            onChange={(e) => setNewModel(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                addModel();
                              }
                            }}
                            placeholder="手动输入模型名后回车添加，如 deepseek-chat"
                            spellCheck={false}
                            className="min-w-0 flex-1 rounded-lg border border-line-strong bg-base px-3 py-2 text-[13px] text-ink outline-none focus:border-brand"
                          />
                          <button
                            type="button"
                            onClick={addModel}
                            disabled={!newModel.trim()}
                            className="shrink-0 rounded-lg border border-line-strong px-3 py-2 text-[12px] text-ink-2 transition-colors hover:border-brand hover:text-brand disabled:opacity-40"
                          >
                            添加
                          </button>
                        </div>

                        {modelHint ? (
                          <p
                            className={`mt-1.5 text-[11px] ${
                              modelOptions ? "text-ink-caption" : "text-danger"
                            }`}
                          >
                            {modelHint}
                          </p>
                        ) : null}

                        {/* 获取到的模型：打钩批量加入 */}
                        {modelOptions && modelOptions.length > 0 ? (
                          <div className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-line bg-base/40 p-2">
                            <div className="mb-1.5 text-[11px] text-ink-caption">
                              点击打钩加入（已选 {form.models.length} 个）
                            </div>
                            <div className="space-y-0.5">
                              {modelOptions.map((m) => {
                                const picked = form.models.includes(m);
                                return (
                                  <button
                                    key={m}
                                    type="button"
                                    onClick={() => toggleModel(m)}
                                    className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[12px] transition-colors hover:bg-white/5"
                                  >
                                    <span
                                      className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border transition-colors ${
                                        picked
                                          ? "border-brand bg-brand text-white"
                                          : "border-line-strong text-transparent"
                                      }`}
                                    >
                                      <Check size={9} />
                                    </span>
                                    <span className="min-w-0 flex-1 truncate font-mono text-ink-2">
                                      {m}
                                    </span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        ) : null}
                      </div>

                      <div className="flex items-center gap-3 pt-1">
                        <button
                          type="button"
                          onClick={() => void saveProviderForm()}
                          disabled={saving}
                          className="rounded-lg bg-brand px-4 py-2 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                        >
                          {saving ? "保存中…" : "保存渠道"}
                        </button>
                        <button
                          type="button"
                          onClick={cancelEdit}
                          className="rounded-lg border border-line-strong px-4 py-2 text-[12.5px] text-ink-2 transition-colors hover:text-ink"
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
                    className="w-full max-w-[200px] rounded-lg border border-line-strong bg-base px-3 py-2 text-[13px] text-ink outline-none focus:border-brand"
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

        {/* 移动端底部 Tab 栏：像原生 App，不再依赖下拉或横向滚动 */}
        <nav className="flex shrink-0 items-stretch border-t border-line bg-sidebar/80 pb-[env(safe-area-inset-bottom)] md:hidden">
          {TABS.map((t) => {
            const Icon = t.icon;
            const on = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => selectTab(t.id)}
                aria-current={on ? "page" : undefined}
                className={`flex flex-1 flex-col items-center gap-1 py-2 text-[10.5px] transition-colors ${
                  on ? "text-brand" : "text-ink-caption"
                }`}
              >
                <Icon size={17} />
                {t.label}
              </button>
            );
          })}
        </nav>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
