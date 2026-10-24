/**
 * 插件系统测试：Patch 合并、Loader 生命周期、热更新与作用域回滚。
 *
 * 全部离线执行，使用临时目录与内置示例插件。
 * 运行方式：npm run test:plugins
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "../../kernel/context.js";
import { applyPatch, validatePatch, type PluginRow } from "./patch.js";
import { PluginLoader, readPatchFile } from "./loader.js";

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) => tests.push([name, fn]);

// --- Patch 合并 -----------------------------------------------------------

const base: PluginRow[] = [
  { id: "a", module: "./a.ts", name: "A", enabled: true },
  { id: "b", module: "./b.ts", name: "B", enabled: true },
];

test("replace 按 id 替换整行", () => {
  const r = applyPatch(base, validatePatch({
    operations: [{ op: "replace", row: { id: "a", module: "./a.ts", name: "A2" } }],
  }));
  assert.equal(r.rows.find((x) => x.id === "a")?.name, "A2");
  assert.equal(r.rows.length, 2);
});

test("replace 目标不存在时视为插入", () => {
  const r = applyPatch(base, validatePatch({
    operations: [{ op: "replace", row: { id: "z", module: "./z.ts" } }],
  }));
  assert.ok(r.rows.find((x) => x.id === "z"));
  assert.equal(r.rows.length, 3);
});

test("insert 新 id 追加到末尾", () => {
  const r = applyPatch(base, validatePatch({
    operations: [{ op: "insert", row: { id: "c", module: "./c.ts" } }],
  }));
  assert.equal(r.rows.at(-1)?.id, "c");
});

test("insert 已存在的 id 产生告警并按替换处理", () => {
  const r = applyPatch(base, validatePatch({
    operations: [{ op: "insert", row: { id: "a", module: "./a-new.ts" } }],
  }));
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows.find((x) => x.id === "a")?.module, "./a-new.ts");
  assert.match(r.warnings[0] ?? "", /已存在/);
});

test("remove 按 id 删除，不存在时静默", () => {
  const r1 = applyPatch(base, validatePatch({ operations: [{ op: "remove", id: "b" }] }));
  assert.deepEqual(r1.rows.map((x) => x.id), ["a"]);
  const r2 = applyPatch(base, validatePatch({ operations: [{ op: "remove", id: "nope" }] }));
  assert.equal(r2.rows.length, 2);
});

test("省略 op 时默认按 replace", () => {
  const r = applyPatch(base, validatePatch({
    operations: [{ row: { id: "a", module: "./x.ts" } }],
  }));
  assert.equal(r.rows.find((x) => x.id === "a")?.module, "./x.ts");
});

test("applyPatch 不修改入参（便于对比热更新差异）", () => {
  const before = JSON.stringify(base);
  applyPatch(base, validatePatch({ operations: [{ op: "remove", id: "a" }] }));
  assert.equal(JSON.stringify(base), before);
});

test("缺少 operations 的 patch 被拒绝", () => {
  assert.throws(() => validatePatch({ name: "x" }), /operations/);
});

// --- Loader 生命周期 ------------------------------------------------------

/** 生成一个临时插件目录，返回 patch 路径。 */
async function makePluginDir(
  opts: { id?: string; name?: string; greeting?: string; enabled?: boolean } = {},
): Promise<{ dir: string; patchFile: string }> {
  const dir = await mkdtemp(join(tmpdir(), "lish-plugin-"));
  const id = opts.id ?? "hello";
  await mkdir(dir, { recursive: true });

  await writeFile(
    join(dir, "index.ts"),
    `export function apply(ctx, config) {
       globalThis.__lishPluginApplies = (globalThis.__lishPluginApplies || 0) + 1;
       if (!ctx.has("${id}")) ctx.provide("${id}", config);
     }
     export function dispose() {
       globalThis.__lishPluginDisposes = (globalThis.__lishPluginDisposes || 0) + 1;
     }`,
    "utf8",
  );

  const patch = {
    name: "test-bundle",
    operations: [
      {
        op: "insert",
        row: {
          id,
          module: "./index.ts",
          name: opts.name ?? "Test Plugin",
          version: "1.0.0",
          enabled: opts.enabled ?? true,
          config: { greeting: opts.greeting ?? "hi" },
        },
      },
    ],
  };
  const patchFile = join(dir, "patch.json");
  await writeFile(patchFile, JSON.stringify(patch), "utf8");
  return { dir, patchFile };
}

test("Loader 加载插件并调用 apply", async () => {
  const { dir, patchFile } = await makePluginDir();
  const ctx = new Context();
  (globalThis as any).__lishPluginApplies = 0;

  const loader = await PluginLoader.create({
    ctx,
    patchFiles: [patchFile],
    resolveBase: dir,
    logger: () => {},
  });

  assert.equal((globalThis as any).__lishPluginApplies, 1);
  const info = loader.list()[0];
  assert.equal(info?.status, "loaded");
  assert.ok(ctx.has("hello"));

  await loader.disposeAll();
  await ctx.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("enabled:false 的插件不加载", async () => {
  const { dir, patchFile } = await makePluginDir({ enabled: false });
  const ctx = new Context();
  const loader = await PluginLoader.create({
    ctx, patchFiles: [patchFile], resolveBase: dir, logger: () => {},
  });
  assert.equal(loader.list()[0]?.status, "disabled");
  assert.equal(ctx.has("hello"), false);
  await loader.disposeAll();
  await ctx.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("热更新：重新 apply 并回滚旧服务", async () => {
  const { dir, patchFile } = await makePluginDir({ greeting: "旧值" });
  const ctx = new Context();
  const loader = await PluginLoader.create({
    ctx, patchFiles: [patchFile], resolveBase: dir, logger: () => {},
  });
  assert.deepEqual(ctx.resolve<any>("hello"), { greeting: "旧值" });

  const updated = await loader.update("hello", { config: { greeting: "新值" } });
  assert.equal(updated.status, "loaded");
  // 关键：作用域回滚让同一个 key 能被重新 provide
  assert.deepEqual(ctx.resolve<any>("hello"), { greeting: "新值" });

  await loader.disposeAll();
  await ctx.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("remove 之后服务被回滚", async () => {
  const { dir, patchFile } = await makePluginDir();
  const ctx = new Context();
  const loader = await PluginLoader.create({
    ctx, patchFiles: [patchFile], resolveBase: dir, logger: () => {},
  });
  assert.equal(ctx.has("hello"), true);

  const removed = await loader.remove("hello");
  assert.equal(removed, true);
  assert.equal(ctx.has("hello"), false);
  assert.equal(loader.list().length, 0);

  await ctx.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("插件模块不存在时记录 error 状态而不崩溃", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lish-plugin-bad-"));
  const patchFile = join(dir, "patch.json");
  await writeFile(
    patchFile,
    JSON.stringify({
      operations: [{ op: "insert", row: { id: "ghost", module: "./nope.ts" } }],
    }),
    "utf8",
  );
  const ctx = new Context();
  const loader = await PluginLoader.create({
    ctx, patchFiles: [patchFile], resolveBase: dir, logger: () => {},
  });
  const info = loader.list()[0];
  assert.equal(info?.status, "error");
  assert.ok(info?.error);

  await ctx.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("插件 apply 抛错时记录 error 状态", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lish-plugin-throw-"));
  await writeFile(
    join(dir, "index.ts"),
    `export function apply() { throw new Error("boom"); }`,
    "utf8",
  );
  const patchFile = join(dir, "patch.json");
  await writeFile(
    patchFile,
    JSON.stringify({ operations: [{ op: "insert", row: { id: "bad", module: "./index.ts" } }] }),
    "utf8",
  );

  const ctx = new Context();
  const loader = await PluginLoader.create({
    ctx, patchFiles: [patchFile], resolveBase: dir, logger: () => {},
  });
  const info = loader.list()[0];
  assert.equal(info?.status, "error");
  assert.match(info?.error ?? "", /boom/);

  await ctx.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("多个 patch 按顺序叠加", async () => {
  const { dir, patchFile } = await makePluginDir({ greeting: "第一层" });
  const second = join(dir, "patch2.json");
  await writeFile(
    second,
    JSON.stringify({
      operations: [{ op: "replace", row: { id: "hello", module: "./index.ts", config: { greeting: "第二层" } } }],
    }),
    "utf8",
  );

  const ctx = new Context();
  const loader = await PluginLoader.create({
    ctx, patchFiles: [patchFile, second], resolveBase: dir, logger: () => {},
  });
  assert.deepEqual(ctx.resolve<any>("hello"), { greeting: "第二层" });

  await loader.disposeAll();
  await ctx.dispose();
  await rm(dir, { recursive: true, force: true });
});

test("readPatchFile 对 YAML 给出明确提示", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lish-patch-"));
  const file = join(dir, "patch.yml");
  await writeFile(file, "name: test\noperations: []\n", "utf8");
  await assert.rejects(() => readPatchFile(file), /js-yaml/);
  await rm(dir, { recursive: true, force: true });
});

test("readPatchFile 支持 JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "lish-patch-"));
  const file = join(dir, "patch.json");
  await writeFile(file, JSON.stringify({ operations: [] }), "utf8");
  const parsed = await readPatchFile(file);
  assert.deepEqual(parsed, { operations: [] });
  await rm(dir, { recursive: true, force: true });
});

// --- 运行器 ---------------------------------------------------------------

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
      console.error(`    ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`);
    }
  }

  console.log(`\n${passed}/${tests.length} tests passed`);
  if (failures.length > 0) {
    console.error(`Failed: ${failures.join(", ")}`);
    process.exitCode = 1;
  }
}

void main();
