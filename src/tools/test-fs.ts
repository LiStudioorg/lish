/**
 * 文件系统工具测试。
 *
 * 重点：路径沙箱必须能拦住 `../outside.txt` 这类越界写入/读取，
 * 并且拦截发生在**真正落盘之前**（越界时工作区外不应出现任何文件）。
 * 运行方式：npm run test:fs
 */

import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Context } from "../kernel/context.js";
import { ToolRegistry } from "../core/tools.js";
import {
  createFsTools,
  PathEscapeError,
  registerFsTools,
  resolveInsideWorkspace,
} from "./fs.js";

const tests: Array<[string, () => Promise<void> | void]> = [];
const test = (name: string, fn: () => Promise<void> | void) =>
  tests.push([name, fn]);

/** 建立一个干净的沙箱：<tmp>/workspace + <tmp>/outside.txt 的父级 */
async function sandbox(): Promise<{ root: string; outsideDir: string }> {
  const base = await mkdtemp(join(tmpdir(), "lish-fs-"));
  const root = join(base, "workspace");
  await mkdir(root, { recursive: true });
  return { root, outsideDir: base };
}

const exists = (p: string) => access(p).then(() => true, () => false);

// --- 正常路径 -------------------------------------------------------------

test("fs.write 写入合法路径并自动创建父目录", async () => {
  const { root } = await sandbox();
  const { read, write } = createFsTools(root);

  const outcome = await write.handler({
    path: "notes/2026/todo.md",
    content: "第一条",
  });

  assert.deepEqual(outcome, { path: "notes/2026/todo.md", bytes: Buffer.byteLength("第一条") });
  const onDisk = await readFile(join(root, "notes/2026/todo.md"), "utf8");
  assert.equal(onDisk, "第一条");
  assert.ok(read);
});

test("fs.read 读回刚写入的内容", async () => {
  const { root } = await sandbox();
  const { read, write } = createFsTools(root);

  await write.handler({ path: "a/b/c.txt", content: "层叠目录没问题" });
  const result = (await read.handler({ path: "a/b/c.txt" })) as {
    content: string;
    bytes: number;
    path: string;
  };

  assert.equal(result.content, "层叠目录没问题");
  assert.equal(result.path, "a/b/c.txt");
  assert.ok(result.bytes > 0);
});

test("fs.write 覆盖已有文件", async () => {
  const { root } = await sandbox();
  const { read, write } = createFsTools(root);

  await write.handler({ path: "x.txt", content: "old" });
  await write.handler({ path: "x.txt", content: "new" });
  const result = (await read.handler({ path: "x.txt" })) as { content: string };
  assert.equal(result.content, "new");
});

test("工具带有合法的 schema，可直接交给模型", async () => {
  const { root } = await sandbox();
  const { read, write } = createFsTools(root);
  for (const tool of [read, write]) {
    assert.equal(typeof tool.description, "string");
    assert.deepEqual((tool.parameters as { required: string[] }).required.includes("path"), true);
  }
  assert.equal(read.name, "fs.read");
  assert.equal(write.name, "fs.write");
});

test("工具可通过注册表调用（走完整管线）", async () => {
  const { root } = await sandbox();
  const ctx = new Context();
  const registry = new ToolRegistry(ctx);
  registerFsTools(registry, root);

  await registry.executeTool("fs.write", { path: "deep/one.txt", content: "hi" });
  const result = await registry.executeTool("fs.read", { path: "deep/one.txt" });

  assert.equal(result.isError, false);
  assert.match(result.content, /hi/);
  await ctx.dispose();
});

// --- 越界拦截（本次重点）-------------------------------------------------

test("fs.write 拒绝 ../outside.txt 越界写入，且不产生任何文件", async () => {
  const { root, outsideDir } = await sandbox();
  const { write } = createFsTools(root);
  const escapeTarget = join(outsideDir, "outside.txt");

  await assert.rejects(
    () => Promise.resolve(write.handler({ path: "../outside.txt", content: "pwned" })),
    (err: unknown) => err instanceof PathEscapeError && err.requestedPath === "../outside.txt",
  );

  assert.equal(await exists(escapeTarget), false, "越界文件绝不能落盘");
});

test("fs.read 拒绝 ../outside.txt 越界读取", async () => {
  const { root, outsideDir } = await sandbox();
  await writeFile(join(outsideDir, "outside.txt"), "机密内容", "utf8");
  const { read } = createFsTools(root);

  await assert.rejects(
    () => Promise.resolve(read.handler({ path: "../outside.txt" })),
    PathEscapeError,
  );
});

test("多层 ../ 与嵌套越界都会被拦住", async () => {
  const { root, outsideDir } = await sandbox();
  await mkdir(join(root, "a/b"), { recursive: true });
  const { read, write } = createFsTools(root);

  const attempts = [
    "../outside.txt",
    "../../etc/passwd",
    "a/../../outside.txt",
    "a/b/../../../outside.txt",
    "./../outside.txt",
    join(outsideDir, "absolute-outside.txt"), // 绝对路径越界
  ];

  for (const path of attempts) {
    await assert.rejects(
      () => Promise.resolve(write.handler({ path, content: "x" })),
      PathEscapeError,
      `应当拦截: ${path}`,
    );
    await assert.rejects(
      () => Promise.resolve(read.handler({ path })),
      PathEscapeError,
      `应当拦截: ${path}`,
    );
  }

  assert.equal(await exists(join(outsideDir, "absolute-outside.txt")), false);
  assert.equal(await exists(join(outsideDir, "outside.txt")), false);
});

test("路径恰好等于工作区根是允许的边界情况", async () => {
  const { root } = await sandbox();
  const resolved = await resolveInsideWorkspace(root, ".");
  assert.equal(resolved, root);
});

test("工作区内使用 .. 但最终仍在根内的路径被允许", async () => {
  const { root } = await sandbox();
  await mkdir(join(root, "a/b"), { recursive: true });
  const { write } = createFsTools(root);

  // a/b/../c.txt -> a/c.txt，仍在工作区内
  await write.handler({ path: "a/b/../c.txt", content: "ok" });
  assert.equal(await readFile(join(root, "a/c.txt"), "utf8"), "ok");
});

test("前缀相似的兄弟目录不会被误判为工作区内", async () => {
  // 例如 root=/tmp/x/workspace，而 /tmp/x/workspace-evil 是它的兄弟
  const { root, outsideDir } = await sandbox();
  const evil = join(outsideDir, "workspace-evil");
  await mkdir(evil, { recursive: true });
  const { write } = createFsTools(root);

  await assert.rejects(
    () => Promise.resolve(write.handler({ path: "../workspace-evil/x.txt", content: "x" })),
    PathEscapeError,
  );
  assert.equal(await exists(join(evil, "x.txt")), false);
});

test("符号链接指向工作区外时同样被拦截", async () => {
  const { root, outsideDir } = await sandbox();
  await writeFile(join(outsideDir, "secret.txt"), "机密", "utf8");
  // 在工作区内建一个指向外部的软链
  await symlink(outsideDir, join(root, "link-out"));

  const { read } = createFsTools(root);
  await assert.rejects(
    () => Promise.resolve(read.handler({ path: "link-out/secret.txt" })),
    PathEscapeError,
  );
});

test("空路径与 NUL 字节被拒绝", async () => {
  const { root } = await sandbox();
  const { read } = createFsTools(root);
  await assert.rejects(() => Promise.resolve(read.handler({ path: "" })), /non-empty/);
  await assert.rejects(
    () => Promise.resolve(read.handler({ path: "a\0b" })),
    /NUL/,
  );
});

// --- 其它边界 -------------------------------------------------------------

test("读取不存在的文件时报错", async () => {
  const { root } = await sandbox();
  const { read } = createFsTools(root);
  await assert.rejects(() => Promise.resolve(read.handler({ path: "nope.txt" })), /not found/i);
});

test("读取目录时报错而不是返回内容", async () => {
  const { root } = await sandbox();
  await mkdir(join(root, "adir"));
  const { read } = createFsTools(root);
  await assert.rejects(() => Promise.resolve(read.handler({ path: "adir" })), /directory/i);
});

test("超过大小上限的写入被拒绝", async () => {
  const { root } = await sandbox();
  const { write } = createFsTools(root, { maxWriteBytes: 8 });
  await assert.rejects(
    () => Promise.resolve(write.handler({ path: "big.txt", content: "x".repeat(20) })),
    /too large/i,
  );
});

test("超过大小上限的读取被拒绝", async () => {
  const { root } = await sandbox();
  await writeFile(join(root, "big.txt"), "x".repeat(100), "utf8");
  const { read } = createFsTools(root, { maxReadBytes: 10 });
  await assert.rejects(() => Promise.resolve(read.handler({ path: "big.txt" })), /too large/i);
});

test("file:// URL 形式的工作区内路径可用", async () => {
  const { root } = await sandbox();
  await writeFile(join(root, "u.txt"), "url", "utf8");
  const { read } = createFsTools(root);
  const result = (await read.handler({ path: `file://${join(root, "u.txt")}` })) as {
    content: string;
  };
  assert.equal(result.content, "url");
});

// --- 测试运行器 --------

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
