/**
 * 配置中心测试（离线）。
 *
 * 覆盖「环境变量 > ~/.lish/config.json > 空配置」这条优先级链，
 * 以及无 API Key 时必须仍能构造运行时（Web / TUI 可在裸环境启动）。
 * 所有落盘都指向临时目录，绝不污染真实的 ~/.lish。
 *
 * 运行方式：npm run test:config
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  activeProvider,
  configFilePath,
  readConfig,
  readFileConfig,
  saveProviders,
  writeFileConfig,
  UnconfiguredProvider,
  UsageError,
} from "../runtime.js";
import { extractModelIds } from "../server.js";

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) =>
  tests.push([name, fn]);

/** 创建一个隔离的临时配置目录，返回可注入的 env。 */
async function tempEnv(): Promise<{
  env: NodeJS.ProcessEnv;
  file: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await mkdtemp(join(tmpdir(), "lish-config-"));
  const file = join(dir, "config.json");
  return {
    env: { LISH_CONFIG_FILE: file } as NodeJS.ProcessEnv,
    file,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

// --- 路径 ----------------------------------------------------------------

test("LISH_CONFIG_FILE 覆盖默认路径", () => {
  const env = { LISH_CONFIG_FILE: "/tmp/x/config.json" } as NodeJS.ProcessEnv;
  assert.equal(configFilePath(env), "/tmp/x/config.json");
});

test("默认路径由 os.homedir() 推导（跨平台）", () => {
  const p = configFilePath({} as NodeJS.ProcessEnv);
  assert.equal(p, join(homedir(), ".lish", "config.json"));
});

// --- 读取与容错 ----------------------------------------------------------

test("文件不存在时返回空配置", () => {
  const env = { LISH_CONFIG_FILE: "/tmp/lish-not-exist-xyz/config.json" };
  assert.deepEqual(readFileConfig(env as NodeJS.ProcessEnv), {});
});

test("JSON 损坏时降级为空配置，不抛错", async () => {
  const { env, file, cleanup } = await tempEnv();
  try {
    await writeFile(file, "{ this is not json", "utf8");
    assert.deepEqual(readFileConfig(env), {});
  } finally {
    await cleanup();
  }
});

test("字段类型不对时只保留合法字段", async () => {
  const { env, file, cleanup } = await tempEnv();
  try {
    await writeFile(
      file,
      JSON.stringify({ apiKey: 123, baseURL: "https://a.example", model: "  " }),
      "utf8",
    );
    const cfg = readFileConfig(env);
    assert.equal(cfg.baseURL, "https://a.example");
    assert.equal(cfg.apiKey, undefined); // 非字符串字段被丢弃
    assert.equal(cfg.model, undefined); // 纯空白字段被丢弃
  } finally {
    await cleanup();
  }
});

test("兼容 baseUrl 拼写", async () => {
  const { env, file, cleanup } = await tempEnv();
  try {
    await writeFile(file, JSON.stringify({ baseUrl: "https://b.example" }), "utf8");
    assert.equal(readFileConfig(env).baseURL, "https://b.example");
  } finally {
    await cleanup();
  }
});

// --- 写入与权限 ----------------------------------------------------------

test("writeFileConfig 落盘并保留既有字段（写回激活提供商）", async () => {
  const { env, file, cleanup } = await tempEnv();
  try {
    assert.equal(await writeFileConfig({ apiKey: "sk-a" }, env), true);
    assert.equal(await writeFileConfig({ model: "deepseek-reasoner" }, env), true);
    const raw = JSON.parse(await readFile(file, "utf8")) as {
      providers: Array<Record<string, unknown>>;
      activeProviderId: string;
    };
    assert.equal(raw.providers.length, 1, "两次写入应落在同一条提供商上");
    assert.equal(raw.providers[0].apiKey, "sk-a");
    assert.equal(raw.providers[0].model, "deepseek-reasoner");
    assert.equal(raw.activeProviderId, raw.providers[0].id);
  } finally {
    await cleanup();
  }
});

test("目录不存在时自动创建", async () => {
  const { env, file, cleanup } = await tempEnv();
  try {
    await mkdir(join(file, ".."), { recursive: true });
    await rm(join(file, ".."), { recursive: true, force: true });
    assert.equal(await writeFileConfig({ apiKey: "sk-b" }, env), true);
    const active = readFileConfig(env).providers?.[0];
    assert.equal(active?.apiKey, "sk-b");
  } finally {
    await cleanup();
  }
});

// --- 多提供商 ------------------------------------------------------------

test("saveProviders 持久化多条并记住激活项", async () => {
  const { env, cleanup } = await tempEnv();
  try {
    const list = [
      { id: "p1", name: "A", baseURL: "https://a.example", apiKey: "sk-a", model: "m-a" },
      { id: "p2", name: "B", baseURL: "https://b.example", apiKey: "sk-b", model: "m-b" },
    ];
    assert.equal(await saveProviders(list, "p2", env), true);
    const cfg = readFileConfig(env);
    assert.equal(cfg.providers?.length, 2);
    assert.equal(activeProvider(cfg)?.id, "p2");
    // 运行时读到的是激活那条
    const runtime = readConfig(env);
    assert.equal(runtime.apiKey, "sk-b");
    assert.equal(runtime.baseURL, "https://b.example");
    assert.equal(runtime.model, "m-b");
  } finally {
    await cleanup();
  }
});

test("激活项指向不存在的 id 时回落到第一条", async () => {
  const { env, cleanup } = await tempEnv();
  try {
    await saveProviders(
      [{ id: "p1", name: "A", baseURL: "https://a.example", apiKey: "sk-a", model: "m" }],
      "missing",
      env,
    );
    assert.equal(readFileConfig(env).activeProviderId, "p1");
  } finally {
    await cleanup();
  }
});

test("旧版扁平配置自动迁移为一条提供商", async () => {
  const { env, file, cleanup } = await tempEnv();
  try {
    await writeFile(
      file,
      JSON.stringify({ apiKey: "sk-old", baseURL: "https://old.example", model: "old-model" }),
      "utf8",
    );
    const cfg = readFileConfig(env);
    assert.equal(cfg.providers?.length, 1, "扁平字段应被迁移");
    assert.equal(cfg.providers?.[0].apiKey, "sk-old");
    assert.equal(cfg.providers?.[0].baseURL, "https://old.example");
    assert.equal(cfg.activeProviderId, cfg.providers?.[0].id);
    // 迁移后运行时行为不变
    assert.equal(readConfig(env).apiKey, "sk-old");
  } finally {
    await cleanup();
  }
});

test("providers 中的非法条目被丢弃，不影响其余条目", async () => {
  const { env, file, cleanup } = await tempEnv();
  try {
    await writeFile(
      file,
      JSON.stringify({
        providers: [
          { id: "p1", baseURL: "https://ok.example", apiKey: "sk-1" },
          { name: "缺 id" },
          "garbage",
          null,
        ],
        activeProviderId: "p1",
      }),
      "utf8",
    );
    const cfg = readFileConfig(env);
    assert.equal(cfg.providers?.length, 1);
    assert.equal(cfg.providers?.[0].id, "p1");
  } finally {
    await cleanup();
  }
});

test("写失败返回 false 而不是抛错", async () => {
  // 把配置文件路径指向一个已存在的文件之下的子路径，必然失败
  const dir = await mkdtemp(join(tmpdir(), "lish-config-"));
  const blocker = join(dir, "blocker");
  try {
    await writeFile(blocker, "x", "utf8");
    const env = { LISH_CONFIG_FILE: join(blocker, "config.json") } as NodeJS.ProcessEnv;
    assert.equal(await writeFileConfig({ apiKey: "sk-c" }, env), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- 优先级 --------------------------------------------------------------

test("环境变量覆盖配置文件", async () => {
  const { env, cleanup } = await tempEnv();
  try {
    await writeFileConfig(
      { apiKey: "sk-file", baseURL: "https://file.example", model: "file-model" },
      env,
    );
    const cfg = readConfig({
      ...env,
      LLM_API_KEY: "sk-env",
      LLM_BASE_URL: "https://env.example",
      LLM_MODEL: "env-model",
    });
    assert.equal(cfg.apiKey, "sk-env");
    assert.equal(cfg.baseURL, "https://env.example");
    assert.equal(cfg.model, "env-model");
  } finally {
    await cleanup();
  }
});

test("无环境变量时回落到配置文件", async () => {
  const { env, cleanup } = await tempEnv();
  try {
    await writeFileConfig(
      { apiKey: "sk-file", baseURL: "https://file.example", model: "file-model" },
      env,
    );
    const cfg = readConfig(env);
    assert.equal(cfg.apiKey, "sk-file");
    assert.equal(cfg.baseURL, "https://file.example");
    assert.equal(cfg.model, "file-model");
  } finally {
    await cleanup();
  }
});

test("两者都没有时用默认值，且不抛错", () => {
  const cfg = readConfig({
    LISH_CONFIG_FILE: "/tmp/lish-not-exist-xyz/config.json",
  } as NodeJS.ProcessEnv);
  assert.equal(cfg.apiKey, "");
  assert.equal(cfg.baseURL, "https://api.deepseek.com");
  assert.equal(cfg.model, "deepseek-chat");
});

test("环境变量为空串时不遮蔽配置文件", async () => {
  const { env, cleanup } = await tempEnv();
  try {
    await writeFileConfig({ apiKey: "sk-file" }, env);
    const cfg = readConfig({ ...env, LLM_API_KEY: "   " });
    assert.equal(cfg.apiKey, "sk-file");
  } finally {
    await cleanup();
  }
});

test("非法的 LLISH_MAX_STEPS 依然报 UsageError", () => {
  assert.throws(
    () =>
      readConfig({
        LISH_CONFIG_FILE: "/tmp/lish-not-exist-xyz/config.json",
        LLISH_MAX_STEPS: "abc",
      } as NodeJS.ProcessEnv),
    UsageError,
  );
});

// --- 无 Key 也要能跑 -----------------------------------------------------

test("无 Key 时不会被任何前置校验拦住", () => {
  const cfg = readConfig({
    LISH_CONFIG_FILE: "/tmp/lish-not-exist-xyz/config.json",
  } as NodeJS.ProcessEnv);
  // 若仍存在强制校验，上面这行会抛错；能走到这里即证明可裸启动
  assert.equal(cfg.apiKey, "");
});

test("UnconfiguredProvider 只在真正生成时报错，并给出可操作指引", async () => {
  const p = new UnconfiguredProvider();
  assert.equal(p.name, "unconfigured");
  await assert.rejects(() => p.generate(), (err: unknown) => {
    assert.ok(err instanceof UsageError);
    assert.match(err.message, /设置/);
    return true;
  });
});

// --- 模型列表解析 --------------------------------------------------------

test("解析 OpenAI / DeepSeek 的 data[].id", () => {
  assert.deepEqual(
    extractModelIds({ data: [{ id: "b-model" }, { id: "a-model" }] }),
    ["a-model", "b-model"],
  );
});

test("解析顶层数组与 Ollama 风格 name", () => {
  assert.deepEqual(extractModelIds([{ id: "x" }, "y"]), ["x", "y"]);
  assert.deepEqual(extractModelIds({ models: [{ name: "llama3" }] }), ["llama3"]);
});

test("无法识别的结构返回空数组，不抛错", () => {
  assert.deepEqual(extractModelIds(null), []);
  assert.deepEqual(extractModelIds({ error: "nope" }), []);
  assert.deepEqual(extractModelIds("text"), []);
  assert.deepEqual(extractModelIds({ data: [{ foo: 1 }] }), []);
});

test("重复模型 id 去重", () => {
  assert.deepEqual(extractModelIds({ data: [{ id: "a" }, { id: "a" }] }), ["a"]);
});

// --- 测试运行器 ----------------------------------------------------------

async function main(): Promise<void> {
  let passed = 0;
  const failures: string[] = [];

  for (const [name, fn] of tests) {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failures.push(name);
      console.error(`  ✗ ${name}`);
      console.error(
        `    ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`,
      );
    }
  }

  console.log(`\n${passed}/${tests.length} tests passed`);
  if (failures.length > 0) {
    console.error(`Failed: ${failures.join(", ")}`);
    process.exitCode = 1;
  }
}

void main();
