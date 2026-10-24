import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * 后端（src/、scripts/、examples/）ESLint 配置。
 *
 * 依据 AGENTS.md 第一部分第 6 条：全量严格模式、严禁 any、提交前必须通过 ESLint。
 * 前端 web/ 使用 Next.js 自带的 eslint 配置，不在此文件管辖范围。
 */
export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "web/**",
      "coverage/**",
      "*.config.js",
      "*.config.mjs",
      "*.config.ts",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
      globals: {
        // Node 全局
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        fetch: "readonly",
        Response: "readonly",
        Request: "readonly",
        Headers: "readonly",
        AbortController: "readonly",
        TextEncoder: "readonly",
        TextDecoder: "readonly",
        ReadableStream: "readonly",
        DOMException: "readonly",
        globalThis: "readonly",
        global: "readonly",
        __dirname: "readonly",
        NodeJS: "readonly",
        // 运行时全局（TypeScript 已识别，ESLint 需显式声明）
        structuredClone: "readonly",
        performance: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      // --- 严格性（AGENTS.md 第 6 条）---
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-unused-vars": "off", // 由 TS 版本接管，避免重复报错
      // TypeScript 编译器已完整检查未定义标识符（含 DOM/Node 类型），
      // ESLint 的 no-undef 无法识别类型位置，容易误报，故关闭。
      "no-undef": "off",

      // --- 安全（AGENTS.md 第 3 条）---
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",

      // --- 正确性 ---
      eqeqeq: ["error", "smart"],
      "no-console": "off", // 本项目 CLI 优先，允许日志
      "prefer-const": "error",
      "no-var": "error",
    },
  },
  {
    // 前端相关文件若被直接 lint（通常不经过这里），仍应用 hooks 规则
    files: ["**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    // 构建脚本（.mjs）：Node ESM 环境，需要 process/console 全局
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        process: "readonly",
        console: "readonly",
        URL: "readonly",
        __dirname: "readonly",
      },
    },
    rules: {
      "no-undef": "off",
    },
  },
  {
    // 测试文件放宽：允许非空断言与较宽松的结构
    files: ["**/test*.ts", "**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
];
