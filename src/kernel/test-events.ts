/**
 * EventBus tests: five dispatch modes, listener lifecycle, Context integration.
 * Run with: npm run test:events
 */

import assert from "node:assert/strict";
import { Context } from "./context.js";
import { EventBus, WaterfallStalledError } from "./events.js";

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) =>
  tests.push([name, fn]);

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

// --- on / off basics ------------------------------------------------------

test("on registers and off removes a listener", () => {
  const bus = new EventBus();
  const seen: string[] = [];
  const listener = (v: string) => void seen.push(v);

  bus.on("greet", listener);
  assert.equal(bus.listenerCount("greet"), 1);
  bus.emit("greet", "hi");
  assert.deepEqual(seen, ["hi"]);

  bus.off("greet", listener);
  assert.equal(bus.listenerCount("greet"), 0);
  bus.emit("greet", "again");
  assert.deepEqual(seen, ["hi"]);
});

test("off on an unknown listener or event is a no-op", () => {
  const bus = new EventBus();
  assert.doesNotThrow(() => bus.off("nope", () => {}));
  bus.on("e", () => {});
  assert.doesNotThrow(() => bus.off("e", () => {}));
  assert.equal(bus.listenerCount("e"), 1);
});

test("duplicate registration creates two subscriptions, off removes one", () => {
  const bus = new EventBus();
  let calls = 0;
  const fn = () => void calls++;
  bus.on("e", fn);
  bus.on("e", fn);
  bus.emit("e");
  assert.equal(calls, 2);
  bus.off("e", fn);
  bus.emit("e");
  assert.equal(calls, 3);
});

test("on returns a working unsubscribe function", () => {
  const bus = new EventBus();
  let calls = 0;
  const unsub = bus.on("e", () => void calls++);
  bus.emit("e");
  unsub();
  bus.emit("e");
  assert.equal(calls, 1);
});

test("empty event maps are cleaned up (no leaked keys)", () => {
  const bus = new EventBus();
  const fn = () => {};
  bus.on("temp", fn);
  bus.off("temp", fn);
  assert.equal(bus.has("temp"), false);
  assert.equal(bus.listenerCount("temp"), 0);
});

// --- emit ----------------------------------------------------------------

test("emit notifies synchronously and in registration order", () => {
  const bus = new EventBus();
  const order: string[] = [];
  bus.on("e", () => void order.push("a"));
  bus.on("e", () => void order.push("b"));
  bus.emit("e");
  assert.deepEqual(order, ["a", "b"]); // already done, no await
});

test("emit passes every argument and ignores return values", () => {
  const bus = new EventBus();
  let captured: unknown[] = [];
  bus.on("e", (...args: unknown[]) => {
    captured = args;
    return "ignored";
  });
  assert.equal(bus.emit("e", 1, "two", { three: 3 }), undefined);
  assert.deepEqual(captured, [1, "two", { three: 3 }]);
});

test("emit does not await async listeners", () => {
  const bus = new EventBus();
  let done = false;
  bus.on("e", async () => {
    await tick(10);
    done = true;
  });
  bus.emit("e");
  assert.equal(done, false);
});

test("emit swallows listener errors and keeps going", () => {
  const bus = new EventBus();
  const order: string[] = [];
  bus.on("e", () => {
    throw new Error("boom");
  });
  bus.on("e", () => void order.push("after"));
  assert.doesNotThrow(() => bus.emit("e"));
  assert.deepEqual(order, ["after"]);
});

test("emit on an event with no listeners is a no-op", () => {
  const bus = new EventBus();
  assert.doesNotThrow(() => bus.emit("nothing", 1, 2));
});

// --- parallel ------------------------------------------------------------

test("parallel runs listeners concurrently", async () => {
  const bus = new EventBus();
  const order: string[] = [];
  bus.on("e", async () => {
    await tick(15);
    order.push("slow");
  });
  bus.on("e", async () => {
    await tick(1);
    order.push("fast");
  });

  const start = Date.now();
  await bus.parallel("e");
  const elapsed = Date.now() - start;

  assert.deepEqual(order, ["fast", "slow"]); // completes out of order
  assert.ok(elapsed < 15 + 12, `expected concurrent (~15ms), got ${elapsed}ms`);
});

test("parallel collects all results in listener order", async () => {
  const bus = new EventBus();
  bus.on("e", async (n: number) => {
    await tick(10);
    return n + 1;
  });
  bus.on("e", async (n: number) => n + 2);
  assert.deepEqual(await bus.parallel("e", 10), [11, 12]);
});

test("parallel rejects if any listener rejects", async () => {
  const bus = new EventBus();
  bus.on("e", async () => {
    throw new Error("nope");
  });
  await assert.rejects(() => bus.parallel("e"), /nope/);
});

// --- serial --------------------------------------------------------------

test("serial awaits each listener in registration order", async () => {
  const bus = new EventBus();
  const order: string[] = [];
  bus.on("e", async () => {
    await tick(10);
    order.push("a");
  });
  bus.on("e", async () => {
    await tick(1);
    order.push("b");
  });
  await bus.serial("e");
  assert.deepEqual(order, ["a", "b"]);
});

test("serial passes args and collects results", async () => {
  const bus = new EventBus();
  bus.on("e", async (n: number) => {
    await tick(1);
    return n * 2;
  });
  bus.on("e", (n: number) => n + 100);
  assert.deepEqual(await bus.serial("e", 5), [10, 105]);
});

test("serial stops at the first rejection", async () => {
  const bus = new EventBus();
  const order: string[] = [];
  bus.on("e", () => void order.push("a"));
  bus.on("e", () => {
    throw new Error("stop");
  });
  bus.on("e", () => void order.push("c"));
  await assert.rejects(() => bus.serial("e"), /stop/);
  assert.deepEqual(order, ["a"]);
});

// --- waterfall -----------------------------------------------------------

test("waterfall threads the value through every listener", async () => {
  const bus = new EventBus();
  bus.on("calc", (v: number, next: (n: number) => void) => next(v + 1));
  bus.on("calc", (v: number, next: (n: number) => void) => next(v * 10));
  assert.equal(await bus.waterfall("calc", 5), 60); // (5+1)*10
});

test("waterfall runs listeners in order", async () => {
  const bus = new EventBus();
  const order: string[] = [];
  bus.on("e", (v: number, next: (n: number) => void) => {
    order.push(`a:${v}`);
    next(v + 1);
  });
  bus.on("e", (v: number, next: (n: number) => void) => {
    order.push(`b:${v}`);
    next(v + 1);
  });
  await bus.waterfall("e", 0);
  assert.deepEqual(order, ["a:0", "b:1"]);
});

test("waterfall short-circuits when a listener returns a value", async () => {
  const bus = new EventBus();
  const order: string[] = [];
  bus.on("e", (v: number, next: (n: number) => void) => {
    order.push("first");
    next(v + 1);
  });
  bus.on("e", (v: number) => {
    order.push("second-returns");
    return v * 100; // short-circuit
  });
  bus.on("e", (v: number, next: (n: number) => void) => {
    order.push("third-should-not-run");
    next(v);
  });

  assert.equal(await bus.waterfall("e", 1), 200); // (1+1)*100
  assert.deepEqual(order, ["first", "second-returns"]);
});

test("waterfall short-circuit on the first listener skips all others", async () => {
  const bus = new EventBus();
  let downstream = false;
  bus.on("e", () => "immediate");
  bus.on("e", () => {
    downstream = true;
  });
  assert.equal(await bus.waterfall("e", "start"), "immediate");
  assert.equal(downstream, false);
});

test("waterfall supports async listeners", async () => {
  const bus = new EventBus();
  bus.on("e", async (v: number, next: (n: number) => void) => {
    await tick(5);
    next(v + 10);
  });
  bus.on("e", async (v: number, next: (n: number) => void) => {
    await tick(5);
    next(v * 2);
  });
  assert.equal(await bus.waterfall("e", 1), 22);
});

test("waterfall returns the initial value with no listeners", async () => {
  const bus = new EventBus();
  assert.equal(await bus.waterfall("empty", "init"), "init");
});

test("waterfall rejects when a middle listener neither calls next nor returns", async () => {
  const bus = new EventBus();
  bus.on("e", (v: number, next: (n: number) => void) => next(v));
  bus.on("e", () => {
    /* forgot next() */
  });
  bus.on("e", () => "unreachable");

  await assert.rejects(
    () => bus.waterfall("e", 1),
    (err: unknown) =>
      err instanceof WaterfallStalledError &&
      err.event === "e" &&
      err.index === 1,
  );
});

test("waterfall tolerates a last listener that returns void", async () => {
  const bus = new EventBus();
  bus.on("e", (v: number, next: (n: number) => void) => next(v + 1));
  bus.on("e", () => {
    /* terminal listener, no next */
  });
  assert.equal(await bus.waterfall("e", 1), 2);
});

// --- bail ----------------------------------------------------------------

test("bail stops at the first non-undefined result", async () => {
  const bus = new EventBus();
  const order: string[] = [];
  bus.on("e", () => {
    order.push("a");
    return undefined;
  });
  bus.on("e", () => {
    order.push("b");
    return "found";
  });
  bus.on("e", () => {
    order.push("c-should-not-run");
    return "later";
  });

  assert.equal(await bus.bail("e"), "found");
  assert.deepEqual(order, ["a", "b"]);
});

test("bail returns undefined when every listener returns undefined", async () => {
  const bus = new EventBus();
  let count = 0;
  bus.on("e", () => void count++);
  bus.on("e", () => void count++);
  assert.equal(await bus.bail("e"), undefined);
  assert.equal(count, 2); // all of them ran
});

test("bail treats falsy results other than undefined as a match", async () => {
  for (const value of [0, "", false, null]) {
    const bus = new EventBus();
    let downstream = false;
    bus.on("e", () => value);
    bus.on("e", () => {
      downstream = true;
      return "x";
    });
    assert.equal(await bus.bail("e"), value);
    assert.equal(downstream, false, `value ${String(value)} should stop the chain`);
  }
});

test("bail awaits async listeners", async () => {
  const bus = new EventBus();
  bus.on("e", async () => {
    await tick(5);
    return undefined;
  });
  bus.on("e", async () => {
    await tick(1);
    return "async-hit";
  });
  assert.equal(await bus.bail("e"), "async-hit");
});

test("bail passes arguments through to every listener", async () => {
  const bus = new EventBus();
  const seen: unknown[][] = [];
  bus.on("e", (...args: unknown[]) => void seen.push(args));
  bus.on("e", (...args: unknown[]) => void seen.push(args));
  await bus.bail("e", 1, 2);
  assert.deepEqual(seen, [
    [1, 2],
    [1, 2],
  ]);
});

// --- dispatch safety -----------------------------------------------------

test("unsubscribing during dispatch does not skip listeners", () => {
  const bus = new EventBus();
  const order: string[] = [];
  const b = () => void order.push("b");
  bus.on("e", () => {
    order.push("a");
    bus.off("e", b);
  });
  bus.on("e", b);
  bus.on("e", () => void order.push("c"));
  bus.emit("e");
  // snapshot semantics: b still runs this round, c is not lost
  assert.deepEqual(order, ["a", "b", "c"]);
});

test("subscribing during dispatch does not affect the current round", () => {
  const bus = new EventBus();
  const order: string[] = [];
  bus.on("e", () => {
    order.push("a");
    bus.on("e", () => void order.push("late"));
  });
  bus.emit("e");
  assert.deepEqual(order, ["a"]);
  bus.emit("e");
  assert.deepEqual(order, ["a", "a", "late"]);
});

// --- Context integration -------------------------------------------------

test("Context exposes an EventBus via resolve('events')", () => {
  const ctx = new Context();
  const fromService = ctx.resolve<EventBus>("events");
  assert.ok(fromService instanceof EventBus);
  assert.equal(fromService, ctx.events);
});

test("Context exists before any user service is provided", () => {
  const ctx = new Context();
  assert.equal(ctx.has("events"), true);
  assert.equal(ctx.events.listenerCount("anything"), 0);
});

test("ctx.on / ctx.emit work as proxies", () => {
  const ctx = new Context();
  const seen: unknown[] = [];
  ctx.on("ping", (v: unknown) => void seen.push(v));
  ctx.emit("ping", 42);
  assert.deepEqual(seen, [42]);
});

test("all five modes are reachable from Context", async () => {
  const ctx = new Context();

  // each mode gets a listener with a signature it can actually consume
  ctx.on("serial-ev", (a: number, b: number) => a + b);
  ctx.on("parallel-ev", (a: number) => a * 2);
  ctx.on("waterfall-ev", (v: number, next: (n: number) => void) => next(v + 1));
  ctx.on("bail-ev", () => "hit");
  let emitted: unknown;
  ctx.on("emit-ev", (v: unknown) => void (emitted = v));

  assert.deepEqual(await ctx.serial("serial-ev", 1, 2), [3]);
  assert.deepEqual(await ctx.parallel("parallel-ev", 4), [8]);
  assert.equal(await ctx.waterfall("waterfall-ev", 1), 2);
  assert.equal(await ctx.bail("bail-ev"), "hit");

  ctx.emit("emit-ev", "sync");
  assert.equal(emitted, "sync");
});

test("plugins can inject the events service", async () => {
  const { loadPlugin } = await import("./plugin.js");
  const ctx = new Context();
  let observed: unknown;

  await loadPlugin(ctx, {
    name: "listener-plugin",
    inject: ["events"],
    apply(c) {
      c.events.on("plugin-event", (v: unknown) => void (observed = v));
    },
  });

  ctx.emit("plugin-event", "hello");
  assert.equal(observed, "hello");
});

test("dispose clears all listeners, including those added via ctx.on", async () => {
  const ctx = new Context();
  const bus = ctx.events;
  const shared = () => {};

  ctx.on("a", shared);
  ctx.on("a", () => {});
  ctx.on("b", () => {});
  bus.on("c", () => {});
  // also register through a plugin-style external reference
  const unsubscribe = ctx.on("d", () => {});

  assert.equal(bus.listenerCount("a"), 2);
  assert.equal(bus.listenerCount("b"), 1);
  assert.equal(bus.listenerCount("c"), 1);
  assert.equal(bus.listenerCount("d"), 1);

  await ctx.dispose();

  for (const ev of ["a", "b", "c", "d"]) {
    assert.equal(bus.listenerCount(ev), 0, `listeners left on "${ev}"`);
  }
  assert.equal(bus.isDisposed, true);
  // A retained unsubscribe handle must be harmless after disposal.
  assert.doesNotThrow(() => unsubscribe());
});

test("listeners cannot fire after Context disposal", async () => {
  const ctx = new Context();
  const bus = ctx.events;
  let calls = 0;
  ctx.on("e", () => void calls++);

  await ctx.dispose();
  bus.emit("e"); // bus is disposed but emit stays a no-op
  assert.equal(calls, 0);
  assert.throws(() => ctx.on("e", () => {}), /EventBus has been disposed/);
});

test("the bus is disposed last (LIFO) so teardown can still emit", async () => {
  const ctx = new Context();
  const order: string[] = [];

  ctx.on("shutdown", () => void order.push("listener-saw-shutdown"));
  ctx.effect(() => {
    ctx.emit("shutdown"); // must still reach listeners
    order.push("disposer-ran");
  });

  await ctx.dispose();
  assert.deepEqual(order, ["listener-saw-shutdown", "disposer-ran"]);
});

test("dispose keeps working even if a disposer emits", async () => {
  const ctx = new Context();
  let emitted = false;
  ctx.effect(() => {
    ctx.emit("bye");
    emitted = true;
  });
  await ctx.dispose();
  assert.equal(emitted, true);
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
