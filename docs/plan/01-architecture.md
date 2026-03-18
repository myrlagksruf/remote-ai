# 01. 시스템 아키텍처

## 현재 전체 흐름

```
[Claude Code]                      [Codex CLI]
    │                                  │
    │ (hook 이벤트)                     │ (세션 JSONL append)
    │ ~/.claude/settings.json          │ ~/.codex/sessions/**/*.jsonl
    ▼                                  ▼
┌──────────────────────────────────────────────────────┐
│                   Bridge Server                      │
│              TypeScript + Fastify                    │
│                   localhost:3000                     │
│                                                      │
│  ┌──────────────┐   ┌────────────────────────────┐   │
│  │ Session      │   │ Codex Session Watcher      │   │
│  │ Manager      │   │ - session_meta 감지        │   │
│  │ - 메모리 상태 │   │ - turn_context 감지        │   │
│  │ - resume 제어 │   │ - response_item 감지       │   │
│  └──────────────┘   └────────────────────────────┘   │
│  ┌──────────────┐   ┌────────────────────────────┐   │
│  │ Codex Runner │   │ Input Router               │   │
│  │ - exec resume│   │ - Bot으로 POST             │   │
│  └──────────────┘   └────────────────────────────┘   │
└───────────────────────┬──────────────────────────────┘
                        │
                        │ HTTP POST
                        ▼
┌──────────────────────────────────────────────────────┐
│                     Discord Bot                      │
│              discord.js v14 + Fastify                │
│                                                      │
│  ┌──────────────┐   ┌────────────────────────────┐   │
│  │ Thread       │   │ Command Handler            │   │
│  │ Manager      │   │ - thread 답장 전달         │   │
│  │ - thread 생성 │   │ - 버튼 응답 전달           │   │
│  │ - thread 복구 │   │ - /plan slash command     │   │
│  └──────────────┘   └────────────────────────────┘   │
│  ┌──────────────┐   ┌────────────────────────────┐   │
│  │ Pending      │   │ Persistent Session Store   │   │
│  │ Requests     │   │ - data/thread-bindings.json│   │
│  └──────────────┘   └────────────────────────────┘   │
└──────────────────────────────────────────────────────┘
                        │
                        ▼
                 [Discord 채널 / Thread]
```

---

## 현재 구현 기준 핵심 차이점

이 문서의 이전 버전은 Codex를 hooks 기반으로 설명했지만, **현재 실제 구현은 Codex hooks를 사용하지 않는다.**

- Claude: hook 기반
- Codex: `~/.codex/sessions/**/*.jsonl` watcher 기반
- Discord 후속 입력: `codex exec resume --json` 실행
- Codex 최종 응답 전송: `resume stdout`이 아니라, 세션 JSONL append를 watcher가 감지해서 Discord로 보냄

즉 Codex 쪽의 실제 데이터 소스는 `.codex/hooks.json` 이 아니라 **세션 JSONL 파일**이다.

---

## Bridge Server (`src/bridge/`)

### 역할

- Claude hook 이벤트 수신: `POST /hook/claude`
- Discord에서 온 사용자 입력 수신: `POST /input`
- Codex 세션 JSONL 파일 감시
- Codex 후속 입력 실행: `codex exec resume ... --json`
- 메모리 기반 세션 상태 관리
- 재시작 후 `data/thread-bindings.json` 에서 최소 Codex 세션 복구

### 실제 엔드포인트

```text
POST /hook/claude
POST /input
GET  /sessions
```

> `POST /hook/codex` 는 현재 구현되어 있지 않다.

---

## Codex 세션 JSONL 구조

현재 구현은 `~/.codex/sessions/**/*.jsonl` 파일을 한 줄씩 읽는다.
실제로 사용하는 레코드 타입은 아래 세 가지다.

### 1. `session_meta`

세션 식별자와 작업 디렉터리를 제공한다.

예시:

```json
{
  "timestamp": "2026-03-18T01:23:26.054Z",
  "type": "session_meta",
  "payload": {
    "id": "019cfe89-03bf-7183-b048-a41d1ecee468",
    "cwd": "C:\\Users\\myrla\\remote-ai",
    "originator": "Codex Desktop",
    "cli_version": "0.115.0-alpha.27"
  }
}
```

현재 구현에서 사용하는 필드:

- `payload.id`
- `payload.cwd`

### 2. `turn_context`

현재 turn의 collaboration mode를 담는다.

예시:

```json
{
  "type": "turn_context",
  "payload": {
    "collaboration_mode": {
      "mode": "plan"
    }
  }
}
```

현재 구현에서 사용하는 필드:

- `payload.collaboration_mode.mode`

### 3. `response_item`

실제 질문/응답 데이터가 들어온다.

계획 질문 감지 예시:

```json
{
  "type": "response_item",
  "payload": {
    "type": "function_call",
    "name": "request_user_input",
    "call_id": "call-1",
    "arguments": "{\"questions\":[...]}"
  }
}
```

최종 응답 감지 예시:

```json
{
  "type": "response_item",
  "payload": {
    "type": "message",
    "role": "assistant",
    "phase": "final_answer",
    "content": [
      {
        "type": "output_text",
        "text": "최종 응답입니다."
      }
    ]
  }
}
```

현재 구현에서 사용하는 필드:

- `payload.type`
- `payload.name`
- `payload.call_id`
- `payload.arguments`
- `payload.role`
- `payload.phase`
- `payload.content[*].text`

### 현재 watcher 동작 요약

- `session_meta` 감지 시 sessionId/cwd를 기억
- `turn_context` 감지 시 `default`/`plan` 모드 기억
- `response_item(function_call=request_user_input)` 감지 시 `ai_question` 전송
- `response_item(message/final_answer)` 감지 시 `response_complete` 전송
- 동일 final answer는 중복 전송하지 않음

### 주의사항

- `session_meta` 첫 줄이 길 수 있어서 첫 줄 전체를 newline까지 읽어야 한다.
- 재시작 후 기존 Codex 세션 파일을 다시 추적하려면 이 `session_meta`를 정상 복구해야 한다.

---

## Discord Bot (`src/bot/`)

### 역할

- Bridge 이벤트 수신: `POST /bot/event`
- 세션별 Discord thread 생성 및 재사용
- 사용자의 thread 답장을 Bridge `/input` 으로 전달
- 권한 버튼 응답 전달
- `/plan` slash command 처리
- `data/thread-bindings.json` 저장 및 재시작 복구

### 현재 저장 파일

프로젝트 로컬 파일:

```text
data/thread-bindings.json
```

저장 필드:

```json
{
  "version": 1,
  "bindings": [
    {
      "sessionId": "019cfea4-359f-79f3-88f2-90187d9539e6",
      "threadId": "1483644117081788467",
      "tool": "codex",
      "sessionName": "remote-ai-019cfea4",
      "status": "active",
      "lastActivity": "2026-03-18T01:55:50.363Z",
      "archived": false,
      "updatedAt": "2026-03-18T01:55:50.363Z"
    }
  ]
}
```

특징:

- 사람이 직접 편집 가능
- 잘못된 레코드는 개별 skip
- bot이 truth를 저장
- bridge는 읽기 전용 복구에 사용

---

## 디렉토리 구조

```text
remote-ai/
├── src/
│   ├── bridge/
│   │   ├── index.ts
│   │   ├── sessionManager.ts
│   │   ├── codexRunner.ts
│   │   ├── codexSessionWatcher.ts
│   │   ├── eventParser.ts
│   │   └── inputRouter.ts
│   ├── bot/
│   │   ├── index.ts
│   │   ├── server.ts
│   │   ├── threadManager.ts
│   │   ├── commandHandler.ts
│   │   ├── slashCommands.ts
│   │   ├── pendingRequests.ts
│   │   └── messageFormatter.ts
│   └── shared/
│       ├── types.ts
│       ├── config.ts
│       └── persistentSessionStore.ts
├── data/
│   └── thread-bindings.json
├── hooks/
│   └── claude-hook.sh
└── docs/plan/
```

---

## 구현된 것 / 구현되지 않은 것

### 현재 구현된 것

- Claude hook 이벤트 수신
- Codex 세션 JSONL watcher
- Discord thread 생성/재사용/종료
- Discord thread 답장 → `codex exec resume`
- Codex `request_user_input` → Discord 질문 전달
- Codex final answer → Discord 전송
- 재시작 후 `data/thread-bindings.json` 기반 thread-session 복구
- bridge의 최소 Codex 세션 복구
- Discord `/plan` slash command
- 사람이 직접 편집 가능한 JSON 저장소

### 아직 구현되지 않은 것

- `POST /hook/codex`
- Codex hooks 기반 연동 (`.codex/hooks.json`)
- Codex tool-level permission 중계
- 재시작 시 pending request 복구
- Discord 전체 thread 재스캔 기반 자동 추론 복구
- `/plan` 외 추가 slash command (`/ai sessions`, `/ai mode` 등)
- Codex 새 세션 시작을 Discord에서 직접 트리거하는 UX

---

## 운영 시 유의점

- Codex 응답이 안 왔는데 `codex exec resume` 는 성공했다면, watcher가 해당 세션 파일의 `session_meta`를 제대로 복구했는지 먼저 확인해야 한다.
- `data/thread-bindings.json` 이 살아 있어도, watcher가 세션 JSONL을 못 따라가면 Discord 응답은 다시 오지 않는다.
- Windows에서는 `codex.cmd` 실행을 위해 추가 quoting 처리가 필요하다.
- Linux/macOS에서는 기본적으로 `codex`가 `PATH`에 있으면 되고, 필요하면 `CODEX_BIN`으로 고정할 수 있다.
