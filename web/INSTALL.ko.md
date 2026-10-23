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

# 설치 안내

`dsh-transition-webui`의 전제 요건·빌드·품질 보증 커맨드입니다.

## 전제 요건

- [Node.js](https://nodejs.org/) >= 18
- npm（Node.js에 포함）

## 빠른 시작

```bash
git clone https://github.com/drscrewdriver/dsh-transition-webui.git
cd dsh-transition-webui

npm install

npm run dev          # 개발 서버 → http://localhost:3081
npm run build        # 프로덕션 빌드 → dist/
npm run preview      # 빌드 산출물 미리보기
```

`npm run dev`를 실행하면 Vite 개발 서버가 시작됩니다. 표시된 URL을 브라우저에서 여세요.

## 품질 보증

```bash
npm run lint            # ESLint 검사
npm run typecheck       # TypeScript 타입 검사 (tsc --noEmit)
npm run test            # Vitest 단위 테스트 (jsdom)
npm run test:watch      # 감시 모드로 테스트 실행
```

## 백엔드 연동

[README.ko.md](./README.ko.md)의「스캐폴드 재사용 / 백엔드 연동」을 참조하세요. `App.tsx`의 목 `handleSend`를 Agent 백엔드(WS / HTTP / SSE)로의 실제 호출로 교체합니다. 시작 설정은 `window.__DASH_BOOT__` 로 주입할 수 있습니다.

## 문제 해결

- **포트 3081 사용 중** — 개발 서버는 `strictPort`를 사용합니다. 포트를 비우거나 `vite.config.ts`의 `server.port`를 변경하세요.
- **ESLint 명령을 찾을 수 없음** — 의존성이 완전하지 않을 수 있습니다. `npm install`을 다시 실행하세요.
- **`Button.test.tsx`를 찾을 수 없음** — 테스트 glob은 Vitest 기본값을 따릅니다. `vitest.config.ts`의 존재를 확인하세요.

## 라이선스

MIT（deepseek-harness와 동일）