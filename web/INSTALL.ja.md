- [English README](./README.md)
- [中文 README](./README.zh.md)
- [日本語 README](./README.ja.md)
- [한국어 README](./README.ko.md)
- [Installation guide](./INSTALL.md)
- [中文安装指南](./INSTALL.zh.md)
- [日本語インストールガイド](./INSTALL.ja.md)
- [한국어 설치 안내](./INSTALL.ko.md)
- [Changelog](./CHANGELOG.md)
- [日本語 changelog](./CHANGELOG.ja.md)
- [한국어 changelog](./CHANGELOG.ko.md)

# インストールガイド

`dsh-transition-webui` の前提要件・ビルド・品質保証コマンド。

## 前提要件

- [Node.js](https://nodejs.org/) >= 18
- npm（Node.js 同梱）

## クイックスタート

```bash
git clone https://github.com/drscrewdriver/dsh-transition-webui.git
cd dsh-transition-webui

npm install

npm run dev          # 開発サーバー → http://localhost:3081
npm run build        # プロダクションビルド → dist/
npm run preview      # ビルド成果物のプレビュー
```

`npm run dev` で Vite 開発サーバーが起動します。表示される URL をブラウザで開いてください。

## 品質保証

```bash
npm run lint            # ESLint チェック
npm run typecheck       # TypeScript 型チェック (tsc --noEmit)
npm run test            # Vitest 単体テスト (jsdom)
npm run test:watch      # 監視モードでテスト実行
```

## バックエンド接続

[README.ja.md](./README.ja.md) の「スキャフォールドとして再利用 / バックエンド接続」を参照。`App.tsx` のモック `handleSend` を Agent バックエンド（WS / HTTP / SSE）への実際の呼び出しに差し替えます。起動設定は `window.__DASH_BOOT__` で注入可能です。

## トラブルシューティング

- **ポート 3081 が使用中** — 開発サーバーは `strictPort` を使用します。ポートを解放するか、`vite.config.ts` の `server.port` を変更してください。
- **ESLint コマンドが見つからない** — 依存が未完了の可能性があります。`npm install` を再実行してください。
- **`Button.test.tsx` が見つからない** — テスト glob は Vitest デフォルトを継承します。`vitest.config.ts` の存在を確認してください。

## ライセンス

MIT（deepseek-harness と同様）