# 프로젝트 개요: Remote AI Bridge via Discord

## 프로젝트 목적

데스크탑에서 실행 중인 **Claude Code** 및 **OpenAI Codex CLI** 세션을 **Discord 봇**을 통해 원격으로 조종하고 모니터링할 수 있는 브릿지 시스템을 구축한다.

---

## 핵심 구성 요소

```
┌──────────────────────────────────────────────────────────────┐
│                       로컬 데스크탑                            │
│                                                              │
│  ┌─────────────┐    ┌─────────────┐                         │
│  │ Claude Code │    │  Codex CLI  │                         │
│  │  (Session)  │    │  (Session)  │                         │
│  └──────┬──────┘    └──────┬──────┘                         │
│         │ hooks            │ hooks (.codex/hooks.json)      │
│         └────────┬─────────┘                                │
│                  ▼                                           │
│         ┌────────────────┐                                  │
│         │  Bridge Server │  (Node.js + TypeScript, local)   │
│         │  - 세션 관리    │                                  │
│         │  - 이벤트 파싱  │                                  │
│         │  - 상태 관리    │                                  │
│         └────────┬───────┘                                  │
│                  │ WebSocket / HTTP                          │
└──────────────────┼───────────────────────────────────────────┘
                   │ Internet
                   ▼
          ┌────────────────┐
          │  Discord Bot   │  (discord.js)
          │  - Thread 관리  │
          │  - 메시지 라우팅 │
          │  - 명령어 처리  │
          └────────┬───────┘
                   │
                   ▼
          ┌────────────────┐
          │  Discord 채널   │
          │  (사용자 DM     │
          │   또는 채널)    │
          └────────────────┘
```

---

## 주요 기능 요약

### Bot → 사용자 (전송)
| 이벤트 | 설명 |
|--------|------|
| 최종 응답 | AI가 작업을 완료했을 때의 결과 |
| AI의 질문 | Plan 수립, Implementation 여부 등 사용자 입력 필요 시 |
| 권한 요청 | 파일 수정, 명령 실행 등 권한 승인 필요 시 |

### 사용자 → Bot (수신)
| 명령 | 설명 |
|------|------|
| 세션 응답 | 특정 세션에 메시지/답변 전송 |
| 직접 질문 | 세션에 새로운 프롬프트 입력 |
| 권한 모드 설정 | auto/manual 등 권한 모드 변경 |
| 권한 승인/거절 | 권한 요청에 대한 응답 |

### 세션 ↔ Discord Thread 매핑
- 각 AI 세션마다 Discord Thread 1개 생성
- Thread 이름 = 세션 이름 (또는 세션 ID)
- 세션 종료 시 Thread 아카이브

---

## 기술 스택

| 영역 | 기술 |
|------|------|
| 언어 | TypeScript |
| Discord 봇 | discord.js v14 (최신) |
| Bridge Server | Node.js + Fastify |
| Claude 연동 | Claude Code Hooks 시스템 |
| Codex 연동 | Codex CLI Hooks 시스템 (`.codex/hooks.json`) |
| 통신 | HTTP (Bridge ↔ Bot) |
| 설정 | .env + JSON config |
| 빌드 | tsx (개발) / tsc (프로덕션) |

---

## 계획서 파일 목록

| 파일 | 내용 |
|------|------|
| `01-architecture.md` | 시스템 아키텍처 상세 및 데이터 흐름 |
| `02-claude-integration.md` | Claude Code Hooks 연동 방법 |
| `03-codex-integration.md` | Codex CLI Hooks 연동 방법 및 권한 제어 차이점 |
| `04-discord-bot.md` | Discord Bot 구조 및 Thread 관리 |
| `05-message-types.md` | 메시지 타입 정의 및 파싱 로직 |
| `06-permission-system.md` | 권한 요청/승인 처리 흐름 |
| `07-implementation-steps.md` | 단계별 구현 순서 |
