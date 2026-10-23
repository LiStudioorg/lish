# Changelog

本プロジェクトの変更履歴。[Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に従います。

## [Unreleased]

### Added

- `dsh-transition-webui` のスキャフォールド（React 18 + Vite + TypeScript）
- DeepSeek Harness レイアウトのピクセル単位再現：ドラッグ可能なサイドバー(240–520px)・セッション/トレース/コンテキスト面板・多タブ下部面板・セッション管理
- DSH monorepo から切り離した独立ブートカーネル `boot.tsx`（`window.__DASH_BOOT__` / `__DASH_PLUGINS__`）
- 単体テスト：Vitest + Testing Library（jsdom）。最初のコンポーネントテストは `Button`
- ESLint flat config + 厳格な TypeScript 型チェック

### Changed

- `portable-dsh-shell` から `dsh-transition-webui` へ改名

### Fixed

- 設定変更時にダークテーマ属性が同期しない問題（`SettingsModal` の effect 依存を補完）
- lint のいくつかの問題：無意味な三項式・`let`→`const`・未使用パラメータ

## [1.0.0] - 2026-08-30

### Added

- 初回利用可能版：独自 Agent 画面を素早く構築するスキャフォールド demo として動作。