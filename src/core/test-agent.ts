/**
 * M1 end-to-end tests: tool pipeline + agent loop.
 *
 * The headline case drives a full model -> tool -> model cycle through the
 * MockProvider and asserts the session log recorded every step.
 * Run with: npm run test:agent
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "../kernel/context.js";
import { loadPlugin } from "../kernel/plugin.js";
import { Session, SessionCorruptLogError, hoistSystemPrompt } from "./session.js";
import { SessionService } from "./sessions.js";
import {
  AGENT_ABORTED,
  AGENT_COMPLETE,
  AgentLoop,
  type AgentRunResult,
} from "./agent-loop.js";
import {
  LlmRuntime,
  MockProvider,
  type GenerateOptions,
  type GenerateResult,
  type LlmProvider,
  type Message,
} from "./llm.js";
import {
  TOOLS_POST_EXECUTE,
  TOOLS_PRE_EXECUTE,
  ToolBlockedError,
  ToolRegistry,
  ToolNotFoundError,
  type PostExecutePayload,
  type PreExecutePayload,
} from "./tools.js";
import { mountCore, type CorePluginOptions } from "./index.js";

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) =>
  tests.push([name, fn]);

const tmp = () => mkdtemp(join(tmpdir(), "lish-m1b-"));

/** Build a context with the full core stack and an echo tool. */
function makeStack(options: { provider?: LlmProvider; agent?: CorePluginOptions["agent"] } = {}) {
  const ctx = new Context();
  mountCore(ctx, { llm: { provider: options.provider ?? new MockProvider() }, agent: options.agent });
  const tools = ctx.resolve<ToolRegistry>("tools");
  tools.register({
    name: "echo",
    description: "Echo the given text back",
    parameters: { type: "object", properties: { text: { type: "string" } } },
    handler: (args) => String(args.text ?? ""),
  });
  return { ctx, tools, sessions: ctx.resolve<SessionService>("sessions"), llm: ctx.resolve<LlmRuntime>("llm") };
}

// --- System prompt hoisting ----------------------------------------------

test("hoistSystemPrompt merges system messages into one leading message", () => {
  const input: Message[] = [
    { role: "system", content: "rule one" },
    { role: "user", content: "hi" },
    { role: "system", content: "rule two" },
    { role: "assistant", content: "hello" },
  ];
  const out = hoistSystemPrompt(input);
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], { role: "system", content: "rule one\n\nrule two" });
  assert.equal(out[1]?.content, "hi");
  assert.equal(out[2]?.role, "assistant");
});

test("hoistSystemPrompt drops empty system messages but keeps the rest", () => {
  const out = hoistSystemPrompt([
    { role: "system", content: "" },
    { role: "user", content: "hi" },
  ]);
  assert.deepEqual(out, [{ role: "user", content: "hi" }]);
});

test("hoistSystemPrompt is a no-op ordering-wise without system messages", () => {
  const input: Message[] = [
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
  ];
  assert.deepEqual(hoistSystemPrompt(input), input);
});

test("System messages added mid-conversation are hoisted to the front", () => {
  const session = new Session({ emitCreated: false });
  session.appendUserMessage("first");
  session.appendAssistantMessage("reply");
  session.appendSystemMessage("late instruction");

  const plain = session.deriveMessages();
  assert.deepEqual(
    plain.map((m) => m.role),
    ["user", "assistant", "system"],
  );

  const hoisted = session.deriveMessages({ hoistSystem: true });
  assert.deepEqual(
    hoisted.map((m) => m.role),
    ["system", "user", "assistant"],
  );
  assert.equal(hoisted[0]?.content, "late instruction");
});

test("deriveApiMessages is the hoisted convenience form", () => {
  const session = new Session({ emitCreated: false });
  session.appendSystemMessage("sys");
  session.appendUserMessage("u");
  assert.deepEqual(session.deriveApiMessages(), session.deriveMessages({ hoistSystem: true }));
});

test("every system prompt survives hoisting (none silently dropped)", () => {
  const session = new Session({ emitCreated: false });
  session.appendSystemMessage("one");
  session.appendSystemMessage("two");
  session.appendSystemMessage("three");
  session.appendUserMessage("go");

  const out = session.deriveMessages({ hoistSystem: true });
  assert.equal(out.length, 2);
  assert.equal(out[0]?.content, "one\n\ntwo\n\nthree");
});

// --- Strict JSONL mode ---------------------------------------------------

async function writeTornLog(file: string) {
  const { appendFile } = await import("node:fs/promises");
  const session = new Session({ file, emitCreated: false });
  session.appendUserMessage("complete");
  await session.flush();
  await appendFile(file, '{"type":"message.user","content":"torn', "utf8");
}

test("strict:false skips a torn trailing line (default)", async () => {
  const dir = await tmp();
  const file = join(dir, "torn.jsonl");
  await writeTornLog(file);

  const loaded = await Session.load(file);
  assert.equal(loaded.strict, false);
  assert.equal(loaded.length, 1);
  assert.equal(loaded.deriveMessages()[0]?.content, "complete");
});

test("strict:true throws on a torn trailing line", async () => {
  const dir = await tmp();
  const file = join(dir, "torn.jsonl");
  await writeTornLog(file);

  await assert.rejects(
    () => Session.load(file, { strict: true }),
    (err: unknown) =>
      err instanceof SessionCorruptLogError &&
      err.line === 2 &&
      err.file === file,
  );
});

test("strict:true reports the exact line number of the first bad line", async () => {
  const dir = await tmp();
  const file = join(dir, "mid.jsonl");
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    file,
    '{"type":"message.user","content":"ok","seq":0,"ts":1}\nNOT JSON\n{"type":"message.user","content":"also ok","seq":1,"ts":2}\n',
    "utf8",
  );

  await assert.rejects(() => Session.load(file, { strict: true }), (err: unknown) => {
    assert.ok(err instanceof SessionCorruptLogError);
    assert.equal(err.line, 2);
    return true;
  });
});

test("a valid log loads identically in strict mode", async () => {
  const dir = await tmp();
  const file = join(dir, "good.jsonl");
  const original = new Session({ file, id: "good" });
  original.appendUserMessage("a");
  original.appendAssistantMessage("b");
  await original.flush();

  const strictLoaded = await Session.load(file, { strict: true });
  const lenient = await Session.load(file);
  assert.deepEqual(strictLoaded.deriveMessages(), lenient.deriveMessages());
  assert.equal(strictLoaded.id, "good");
});

// --- Session service -----------------------------------------------------

test("SessionService registers as ctx.sessions and tracks sessions", async () => {
  const { ctx, sessions } = makeStack();

  const a = sessions.create({ id: "a" });
  const b = sessions.create();
  assert.equal(sessions.size, 2);
  assert.equal(sessions.require("a"), a);
  assert.equal(sessions.get("missing"), undefined);
  assert.throws(() => sessions.require("missing"), /Unknown session: missing/);
  assert.deepEqual(sessions.list().sort(), [a.id, b.id].sort());

  await ctx.dispose();
});

test("SessionService emits sessions:created on the kernel bus", async () => {
  const { ctx, sessions } = makeStack();
  const seen: string[] = [];
  ctx.on(SessionService.CREATED, (payload: { sessionId: string }) => seen.push(payload.sessionId));

  const s = sessions.create();
  assert.deepEqual(seen, [s.id]);
  await ctx.dispose();
});

test("SessionService can write JSONL into a directory", async () => {
  const dir = await tmp();
  const ctx = new Context();
  mountCore(ctx, { sessions: { dir } });
  const sessions = ctx.resolve<SessionService>(SessionService.KEY);

  const session = sessions.create({ id: "dirtest" });
  session.appendUserMessage("written");
  await sessions.flushAll();

  const raw = await readFile(join(dir, "dirtest.jsonl"), "utf8");
  assert.match(raw, /written/);
  await ctx.dispose();
});

// --- Core plugin mounting -------------------------------------------------

test("mountCore provides all four services", async () => {
  const { ctx } = makeStack();
  for (const key of ["sessions", "llm", "tools", "agent"]) {
    assert.equal(ctx.has(key), true, `${key} should be provided`);
  }
  await ctx.dispose();
});

test("mountCore is idempotent (does not throw on a second call)", async () => {
  const ctx = new Context();
  mountCore(ctx);
  assert.doesNotThrow(() => mountCore(ctx));
  assert.equal(ctx.has("agent"), true);
  await ctx.dispose();
});

test("core plugin mounts via loadPlugin", async () => {
  const ctx = new Context();
  const { corePlugin } = await import("./index.js");
  await loadPlugin(ctx, corePlugin({ llm: { provider: new MockProvider() } }));
  assert.equal(ctx.has("tool") || ctx.has("tools"), true);
  assert.ok(ctx.resolve<LlmRuntime>("llm").currentProvider);
  await ctx.dispose();
});

// --- ToolRegistry ---------------------------------------------------------

test("register + executeTool runs the handler", async () => {
  const { ctx, tools } = makeStack();
  const result = await tools.executeTool("echo", { text: "hi" });
  assert.equal(result.content, "hi");
  assert.equal(result.isError, false);
  await ctx.dispose();
});

test("executeTool throws for an unknown tool", async () => {
  const { ctx, tools } = makeStack();
  await assert.rejects(() => tools.executeTool("nope", {}), ToolNotFoundError);
  await ctx.dispose();
});

test("a throwing handler becomes isError data, not a rejection", async () => {
  const { ctx, tools } = makeStack();
  tools.register({
    name: "explode",
    handler: () => {
      throw new Error("kaboom");
    },
  });
  const result = await tools.executeTool("explode");
  assert.equal(result.isError, true);
  assert.equal(result.content, "kaboom");
  await ctx.dispose();
});

test("tools/pre-execute can rewrite arguments", async () => {
  const { ctx, tools } = makeStack();
  ctx.on(TOOLS_PRE_EXECUTE, (payload: PreExecutePayload, next) => {
    next({ ...payload, args: { ...payload.args, text: `${payload.args.text}!` } });
  });

  const result = await tools.executeTool("echo", { text: "hi" });
  assert.equal(result.content, "hi!");
  await ctx.dispose();
});

test("multiple pre-execute hooks chain in order", async () => {
  const { ctx, tools } = makeStack();
  ctx.on(TOOLS_PRE_EXECUTE, (p: PreExecutePayload, next) =>
    next({ ...p, args: { ...p.args, text: `[${p.args.text}` } }),
  );
  ctx.on(TOOLS_PRE_EXECUTE, (p: PreExecutePayload, next) =>
    next({ ...p, args: { ...p.args, text: `${p.args.text}]` } }),
  );

  const result = await tools.executeTool("echo", { text: "x" });
  assert.equal(result.content, "[x]");
  await ctx.dispose();
});

test("a pre-execute hook can block execution by throwing", async () => {
  const { ctx, tools } = makeStack();
  let ran = false;
  tools.register({ name: "danger", handler: () => void (ran = true) });
  ctx.on(TOOLS_PRE_EXECUTE, (payload: PreExecutePayload) => {
    if (payload.name === "danger") throw new ToolBlockedError("danger", "policy");
  });

  await assert.rejects(() => tools.executeTool("danger"), ToolBlockedError);
  assert.equal(ran, false, "handler must not run when blocked");
  await ctx.dispose();
});

test("tools/post-execute can reshape the result content", async () => {
  const { ctx, tools } = makeStack();
  ctx.on(TOOLS_POST_EXECUTE, (payload: PostExecutePayload, next) => {
    next({ ...payload, content: `<${payload.content}>` });
  });

  const result = await tools.executeTool("echo", { text: "hi" });
  assert.equal(result.content, "<hi>");
  await ctx.dispose();
});

test("post-execute sees timing and the raw result", async () => {
  const { ctx, tools } = makeStack();
  let captured: PostExecutePayload | undefined;
  ctx.on(TOOLS_POST_EXECUTE, (payload: PostExecutePayload, next) => {
    captured = payload;
    next(payload);
  });

  await tools.executeTool("echo", { text: "hi" }, "call-1");
  assert.equal(captured?.name, "echo");
  assert.equal(captured?.result, "hi");
  assert.equal(captured?.callId, "call-1");
  assert.equal(typeof captured?.durationMs, "number");
  await ctx.dispose();
});

test("schemas() exposes registered tools to the model", async () => {
  const { ctx, tools } = makeStack();
  const [schema] = tools.schemas();
  assert.equal(schema?.name, "echo");
  assert.equal(schema?.description, "Echo the given text back");
  assert.ok(schema?.parameters);
  await ctx.dispose();
});

test("registry without a Context still works (no pipeline)", async () => {
  const tools = new ToolRegistry();
  tools.register({ name: "add", handler: (a) => Number(a.x) + Number(a.y) });
  const result = await tools.executeTool("add", { x: 2, y: 3 });
  assert.equal(result.content, "5");
});

// --- Agent loop: the headline end-to-end case ----------------------------

test("agent loop completes model -> tool -> model and logs every step", async () => {
  const dir = await tmp();
  const { ctx, sessions } = makeStack();
  const session = sessions.create({ id: "e2e", file: join(dir, "agent.jsonl") });
  const agent = ctx.resolve<AgentLoop>(AgentLoop.KEY);

  const result = await agent.run(session, "please echo");

  // Loop outcome
  assert.equal(result.stopReason, "stop");
  assert.equal(result.toolCallsExecuted, 1);
  assert.equal(result.steps.length, 2);
  assert.equal(result.steps[0]?.finishReason, "tool_calls");
  assert.equal(result.steps[1]?.finishReason, "stop");
  assert.match(result.text, /Summary of tool results/);

  // The conversation the model saw
  const messages = session.deriveMessages();
  assert.deepEqual(
    messages.map((m) => m.role),
    ["user", "assistant", "tool", "assistant"],
  );
  assert.equal(messages[0]?.content, "please echo");
  assert.equal(messages[1]?.toolCalls?.[0]?.name, "echo");
  assert.equal(messages[2]?.tool?.content, "hello from mock");
  assert.match(messages[3]?.content ?? "", /echo: hello from mock/);

  // The log recorded the whole lifecycle
  const types = session.log.map((e) => e.type);
  assert.deepEqual(types, [
    "session.created",
    "message.user",
    "message.assistant",
    "tool.result",
    "message.assistant",
    "agent:complete",
  ]);
  const completed = session.log.at(-1) as Record<string, unknown>;
  assert.equal(completed.stopReason, "stop");
  assert.equal(completed.toolCallsExecuted, 1);

  // seq is contiguous and the file mirrors the log
  assert.deepEqual(
    session.log.map((e) => e.seq),
    Array.from({ length: session.log.length }, (_, i) => i),
  );
  await session.flush();
  const onDisk = (await readFile(join(dir, "agent.jsonl"), "utf8")).trimEnd().split("\n");
  assert.equal(onDisk.length, session.log.length);
  assert.deepEqual(
    JSON.parse(onDisk.at(-1) as string).type,
    "agent:complete",
  );

  await ctx.dispose();
});

test("agent loop emits step and completion events on the bus", async () => {
  const { ctx, sessions } = makeStack();
  const session = sessions.create();
  const agent = ctx.resolve<AgentLoop>(AgentLoop.KEY);

  const steps: number[] = [];
  let completed: unknown;
  ctx.on("agent:step", (p: { step: number }) => steps.push(p.step));
  ctx.on(AGENT_COMPLETE, (p: unknown) => (completed = p));

  await agent.run(session, "go");
  assert.deepEqual(steps, [1, 2]);
  assert.equal((completed as { stopReason: string }).stopReason, "stop");
  await ctx.dispose();
});

test("agent loop stops immediately when the model returns no tool calls", async () => {
  const plain: LlmProvider = {
    name: "plain",
    async generate(): Promise<GenerateResult> {
      return { text: "just answering", toolCalls: [], finishReason: "stop", provider: "plain" };
    },
  };
  const { ctx, sessions } = makeStack({ provider: plain });
  const agent = ctx.resolve<AgentLoop>(AgentLoop.KEY);
  const session = sessions.create();

  const result = await agent.run(session, "hi");
  assert.equal(result.stopReason, "stop");
  assert.equal(result.toolCallsExecuted, 0);
  assert.equal(result.text, "just answering");
  assert.deepEqual(
    session.deriveMessages().map((m) => m.role),
    ["user", "assistant"],
  );
  await ctx.dispose();
});

test("agent loop surfaces an unknown tool to the model as an error result", async () => {
  const picky: LlmProvider = {
    name: "picky",
    async generate(messages: Message[]): Promise<GenerateResult> {
      const sawTool = messages.some((m) => m.role === "tool");
      if (!sawTool) {
        return {
          text: "",
          toolCalls: [{ id: "c1", name: "ghost_tool", arguments: {} }],
          finishReason: "tool_calls",
          provider: "picky",
        };
      }
      return { text: "recovered", toolCalls: [], finishReason: "stop", provider: "picky" };
    },
  };
  const { ctx, sessions } = makeStack({ provider: picky });
  const agent = ctx.resolve<AgentLoop>(AgentLoop.KEY);
  const session = sessions.create();

  const result = await agent.run(session, "use a ghost");
  assert.equal(result.stopReason, "stop");
  assert.equal(result.text, "recovered");
  const toolMsg = session.deriveMessages().find((m) => m.role === "tool");
  assert.equal(toolMsg?.tool?.isError, true);
  assert.match(toolMsg?.tool?.content ?? "", /Unknown tool: ghost_tool/);
  await ctx.dispose();
});

// --- Agent loop: loop protection -----------------------------------------

test("maxSteps halts a provider that always asks for tools", async () => {
  let n = 0;
  const greedy: LlmProvider = {
    name: "greedy",
    async generate(): Promise<GenerateResult> {
      n++;
      return {
        text: "",
        toolCalls: [{ id: `c${n}`, name: "echo", arguments: { text: `t${n}` } }],
        finishReason: "tool_calls",
        provider: "greedy",
      };
    },
  };
  const { ctx, sessions } = makeStack({ provider: greedy, agent: { maxSteps: 3, maxRepeatedCalls: 100 } });
  const agent = ctx.resolve<AgentLoop>(AgentLoop.KEY);
  const session = sessions.create();

  const result = await agent.run(session, "loop forever");
  assert.equal(result.stopReason, "max_steps");
  assert.equal(result.steps.length, 3);
  assert.equal(n, 3, "must not exceed maxSteps model calls");
  assert.match(result.error ?? "", /max steps/i);
  await ctx.dispose();
});

test("maxToolCalls caps tool executions", async () => {
  let n = 0;
  const burst: LlmProvider = {
    name: "burst",
    async generate(): Promise<GenerateResult> {
      n++;
      return {
        text: "",
        toolCalls: Array.from({ length: 5 }, (_, i) => ({
          id: `c${n}_${i}`,
          name: "echo",
          arguments: { text: `t${n}_${i}` },
        })),
        finishReason: "tool_calls",
        provider: "burst",
      };
    },
  };
  const { ctx, sessions } = makeStack({
    provider: burst,
    agent: { maxSteps: 10, maxToolCalls: 4, maxRepeatedCalls: 100 },
  });
  const agent = ctx.resolve<AgentLoop>(AgentLoop.KEY);
  const session = sessions.create();

  const result = await agent.run(session, "burst");
  assert.equal(result.stopReason, "max_tool_calls");
  assert.ok(result.toolCallsExecuted <= 4, `executed ${result.toolCallsExecuted}`);
  await ctx.dispose();
});

test("repeated identical calls are detected before the step budget runs out", async () => {
  const loop: LlmProvider = {
    name: "loop",
    async generate(): Promise<GenerateResult> {
      return {
        text: "",
        toolCalls: [{ id: `id_${Math.random()}`, name: "echo", arguments: { text: "same" } }],
        finishReason: "tool_calls",
        provider: "loop",
      };
    },
  };
  const { ctx, sessions } = makeStack({
    provider: loop,
    agent: { maxSteps: 20, maxRepeatedCalls: 2 },
  });
  const agent = ctx.resolve<AgentLoop>(AgentLoop.KEY);
  const session = sessions.create();

  const result = await agent.run(session, "oscillate");
  assert.equal(result.stopReason, "repeated_call");
  assert.ok(result.steps.length <= 3, `stopped after ${result.steps.length} steps`);
  await ctx.dispose();
});

test("aborted runs emit agent:aborted and record the reason in the log", async () => {
  const loop: LlmProvider = {
    name: "loop",
    async generate(): Promise<GenerateResult> {
      return {
        text: "",
        toolCalls: [{ id: "x", name: "echo", arguments: { text: "again" } }],
        finishReason: "tool_calls",
        provider: "loop",
      };
    },
  };
  const { ctx, sessions } = makeStack({ provider: loop, agent: { maxSteps: 4, maxRepeatedCalls: 50 } });
  const agent = ctx.resolve<AgentLoop>(AgentLoop.KEY);
  const session = sessions.create();

  let aborted: unknown;
  ctx.on(AGENT_ABORTED, (p: unknown) => (aborted = p));
  const result = await agent.run(session, "go");

  assert.equal(result.stopReason, "max_steps");
  assert.equal((aborted as { stopReason: string }).stopReason, "max_steps");
  const last = session.log.at(-1) as Record<string, unknown>;
  assert.equal(last.type, "agent:complete");
  assert.equal(last.stopReason, "max_steps");
  await ctx.dispose();
});

test("a provider error ends the run with stopReason error, not a throw", async () => {
  const broken: LlmProvider = {
    name: "broken",
    async generate(): Promise<GenerateResult> {
      throw new Error("upstream 500");
    },
  };
  const { ctx, sessions } = makeStack({ provider: broken });
  const agent = ctx.resolve<AgentLoop>(AgentLoop.KEY);
  const session = sessions.create();

  const result = await agent.run(session, "go");
  assert.equal(result.stopReason, "error");
  assert.match(result.error ?? "", /upstream 500/);
  const last = session.log.at(-1) as Record<string, unknown>;
  assert.equal(last.stopReason, "error");
  await ctx.dispose();
});

test("agent loop refuses to run without a provider", async () => {
  const ctx = new Context();
  mountCore(ctx);
  const sessions = ctx.resolve<SessionService>(SessionService.KEY);
  const agent = ctx.resolve<AgentLoop>(AgentLoop.KEY);

  const result = await agent.run(sessions.create(), "hi");
  assert.equal(result.stopReason, "error");
  assert.match(result.error ?? "", /No LLM provider/);
  await ctx.dispose();
});

// --- Agent loop: interception during execution ---------------------------

test("a blocking pre-execute hook is reported to the model, run continues", async () => {
  const { ctx, sessions } = makeStack();
  ctx.on(TOOLS_PRE_EXECUTE, (p: PreExecutePayload) => {
    if (p.name === "echo") throw new ToolBlockedError("echo", "blocked by test");
  });
  const agent = ctx.resolve<AgentLoop>(AgentLoop.KEY);
  const session = sessions.create();

  const result = await agent.run(session, "try echo");
  assert.equal(result.stopReason, "stop");
  const toolMsg = session.deriveMessages().find((m) => m.role === "tool");
  assert.equal(toolMsg?.tool?.isError, true);
  assert.match(toolMsg?.tool?.content ?? "", /blocked/);
  await ctx.dispose();
});

test("pre-execute hook can rewrite args inside the agent loop", async () => {
  const { ctx, sessions } = makeStack();
  ctx.on(TOOLS_PRE_EXECUTE, (p: PreExecutePayload, next) =>
    next({ ...p, args: { text: "rewritten" } }),
  );
  const agent = ctx.resolve<AgentLoop>(AgentLoop.KEY);
  const session = sessions.create();

  await agent.run(session, "go");
  const toolMsg = session.deriveMessages().find((m) => m.role === "tool");
  assert.equal(toolMsg?.tool?.content, "rewritten");
  await ctx.dispose();
});

test("agent loop sends hoisted system messages to the provider", async () => {
  let seen: Message[] = [];
  const spy: LlmProvider = {
    name: "spy",
    async generate(messages: Message[]): Promise<GenerateResult> {
      seen = messages;
      return { text: "ok", toolCalls: [], finishReason: "stop", provider: "spy" };
    },
  };
  const { ctx, sessions } = makeStack({ provider: spy });
  const agent = ctx.resolve<AgentLoop>(AgentLoop.KEY);
  const session = sessions.create();
  session.appendSystemMessage("sys one");
  session.appendSystemMessage("sys two");

  await agent.run(session, "hello");
  assert.equal(seen[0]?.role, "system");
  assert.equal(seen[0]?.content, "sys one\n\nsys two");
  assert.equal(seen.filter((m) => m.role === "system").length, 1);
  await ctx.dispose();
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
