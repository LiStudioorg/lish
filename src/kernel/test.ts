/**
 * Kernel smoke tests: dependency injection + LIFO disposal + plugin loading.
 * Run with: npm run test:kernel
 */

import assert from "node:assert/strict";
import { Context } from "./context.js";
import { loadPlugin, loadPlugins, PluginDependencyError } from "./plugin.js";

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) =>
  tests.push([name, fn]);

// --- Context: provide / resolve -------------------------------------------

test("provide + resolve returns the same instance", () => {
  const ctx = new Context();
  const db = { query: () => "rows" };
  ctx.provide("db", db);
  assert.equal(ctx.resolve<typeof db>("db"), db);
  assert.equal(ctx.resolve<typeof db>("db").query(), "rows");
});

test("resolve throws for an unknown key", () => {
  const ctx = new Context();
  assert.throws(() => ctx.resolve("nope"), /Service not registered: nope/);
});

test("duplicate provide is rejected", () => {
  const ctx = new Context();
  ctx.provide("db", {});
  assert.throws(() => ctx.provide("db", {}), /already provided: db/);
});

test("symbol keys are supported", () => {
  const ctx = new Context();
  const key = Symbol("logger");
  ctx.provide(key, "log");
  assert.equal(ctx.resolve<string>(key), "log");
});

test("provide returns the registered service", () => {
  const ctx = new Context();
  const svc = { id: 1 };
  assert.equal(ctx.provide("svc", svc), svc);
});

// --- Context: LIFO disposal -----------------------------------------------

test("dispose runs disposers in reverse (LIFO) order", async () => {
  const ctx = new Context();
  const order: string[] = [];

  ctx.provide("a", "A", () => void order.push("a"));
  ctx.provide("b", "B", () => void order.push("b"));
  ctx.effect(() => void order.push("effect-1"));
  ctx.effect(() => void order.push("effect-2"));

  await ctx.dispose();
  assert.deepEqual(order, ["effect-2", "effect-1", "b", "a"]);
});

test("service disposers and effects share one LIFO stack", async () => {
  const ctx = new Context();
  const order: string[] = [];

  ctx.effect(() => void order.push("first-effect"));
  ctx.provide("x", 1, () => void order.push("x"));
  ctx.effect(() => void order.push("second-effect"));

  await ctx.dispose();
  assert.deepEqual(order, ["second-effect", "x", "first-effect"]);
});

test("dispose is idempotent", async () => {
  const ctx = new Context();
  let calls = 0;
  ctx.effect(() => void calls++);
  await ctx.dispose();
  await ctx.dispose();
  assert.equal(calls, 1);
  assert.equal(ctx.isDisposed, true);
});

test("async disposers are awaited in order", async () => {
  const ctx = new Context();
  const order: string[] = [];
  ctx.effect(async () => {
    await new Promise((r) => setTimeout(r, 10));
    order.push("slow");
  });
  ctx.effect(() => void order.push("fast"));
  await ctx.dispose();
  assert.deepEqual(order, ["fast", "slow"]);
});

test("a throwing disposer does not block the rest", async () => {
  const ctx = new Context();
  const order: string[] = [];
  ctx.effect(() => void order.push("bottom"));
  ctx.effect(() => {
    throw new Error("boom");
  });
  ctx.effect(() => void order.push("top"));

  await assert.rejects(() => ctx.dispose(), /boom/);
  assert.deepEqual(order, ["top", "bottom"]);
});

test("services are cleared after dispose", async () => {
  const ctx = new Context();
  ctx.provide("db", {});
  await ctx.dispose();
  assert.equal(ctx.has("db"), false);
  assert.throws(() => ctx.resolve("db"), /Service not registered/);
});

test("provide / effect after dispose throw", async () => {
  const ctx = new Context();
  await ctx.dispose();
  assert.throws(() => ctx.provide("late", 1), /already been disposed/);
  assert.throws(() => ctx.effect(() => {}), /already been disposed/);
});

// --- Plugin loading -------------------------------------------------------

test("loadPlugin applies a plugin with satisfied dependencies", async () => {
  const ctx = new Context();
  ctx.provide("db", { name: "db" });
  const applied: string[] = [];

  await loadPlugin(ctx, {
    name: "reporter",
    inject: ["db"],
    apply(c) {
      applied.push(c.resolve<{ name: string }>("db").name);
    },
  });

  assert.deepEqual(applied, ["db"]);
});

test("loadPlugin rejects and does not apply when a dependency is missing", async () => {
  const ctx = new Context();
  let applied = false;
  const plugin = {
    name: "needy",
    inject: ["db", "cache"],
    apply() {
      applied = true;
    },
  };

  await assert.rejects(
    () => loadPlugin(ctx, plugin),
    (err: unknown) =>
      err instanceof PluginDependencyError &&
      err.plugin === "needy" &&
      err.missing.length === 2,
  );
  assert.equal(applied, false);
});

test("plugin without inject loads directly", async () => {
  const ctx = new Context();
  let applied = false;
  await loadPlugin(ctx, { name: "simple", apply: () => void (applied = true) });
  assert.equal(applied, true);
});

test("plugins can register services and effects for later cleanup", async () => {
  const ctx = new Context();
  const order: string[] = [];

  await loadPlugins(ctx, [
    {
      name: "db-plugin",
      apply(c) {
        c.provide("db", { ok: true }, () => void order.push("db closed"));
      },
    },
    {
      name: "api-plugin",
      inject: ["db"],
      apply(c) {
        c.effect(() => void order.push("api stopped"));
        assert.equal(c.resolve<{ ok: boolean }>("db").ok, true);
      },
    },
  ]);

  assert.equal(ctx.has("db"), true);
  await ctx.dispose();
  assert.deepEqual(order, ["api stopped", "db closed"]);
});

test("dependency order is enforced across a plugin list", async () => {
  const ctx = new Context();
  await assert.rejects(
    () =>
      loadPlugins(ctx, [
        { name: "api", inject: ["db"], apply: () => {} },
        { name: "db", apply: () => {} },
      ]),
    /Plugin "api" is missing dependencies: db/,
  );
});

// --- Runner ---------------------------------------------------------------

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
