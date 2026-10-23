# Changelog

이 프로젝트의 변경 이력입니다.[Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)을 따릅니다.

## [Unreleased]

### Added

- `dsh-transition-webui` 스캐폴드（React 18 + Vite + TypeScript）
- DeepSeek Harness 레이아웃 픽셀 단위 재현：드래그 가능 사이드바(240–520px)·세션/트레이스/콘텍스트 패널·멀티탭 하단 패널·세션 관리
- DSH monorepo에서 분리된 독립 부트 커널 `boot.tsx`（`window.__DASH_BOOT__` / `__DASH_PLUGINS__`）
- 단위 테스트: Vitest + Testing Library（jsdom）。첫 컴포넌트 테스트는 `Button`
- ESLint flat config + 엄격한 TypeScript 타입 검사

### Changed

- `portable-dsh-shell`에서 `dsh-transition-webui`로 이름 변경

### Fixed

- 설정 변경 시 다크 테마 속성이 동기화되지 않는 문제（`SettingsModal` effect 의존성 보완）
- lint의 일부 문제: 무의미한 삼항식·`let`→`const`·미사용 파라미터

## [1.0.0] - 2026-08-30

### Added

- 첫 사용 가능 버전: 자체 Agent 화면을 빠르게 구축하기 위한 스캐폴드 데모로 동작.