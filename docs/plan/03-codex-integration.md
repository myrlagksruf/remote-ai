# 03. OpenAI Codex CLI 연동 (현재 구현 기준)

## 요약

초기 설계는 Codex hooks 기반이었지만, **현재 구현은 hooks를 사용하지 않고 세션 JSONL watcher 기반**이다.

현재 실제 흐름:

1. Codex가 `~/.codex/sessions/**/*.jsonl` 에 이벤트를 append
2. Bridge의 `CodexSessionWatcher` 가 이를 감지
3. `session_meta`, `turn_context`, `response_item` 을 파싱
4. Discord Bot으로 `session_start`, `ai_question`, `response_complete` 를 전달
5. Discord thread 답장은 Bridge가 `codex exec resume --json` 으로 다시 세션에 주입

---

## 현재 사용하는 Codex 인터페이스

### 1. 세션 파일 감시

감시 경로:

```text
~/.codex/sessions/**/*.jsonl
```

사용 이유:

- Codex hooks에 의존하지 않고도 세션 상태를 읽을 수 있음
- 최종 응답과 질문 감지를 JSONL append만으로 처리 가능
- `resume` 이후 결과도 같은 파일에서 이어서 추적 가능

### 2. 후속 입력 실행

Bridge는 Discord에서 온 답장을 아래 명령으로 실행한다.

```bash
codex exec resume --dangerously-bypass-approvals-and-sandbox --json <session_id> "<prompt>"
```

설명:

- 기존 Codex 세션에 다음 user prompt를 넣는다
- stdout 이벤트는 로깅만 하고, 실제 Discord 전송은 watcher가 JSONL append를 보고 처리한다
- 한 세션에서 동시 resume은 막는다

### 3. `/plan`

Discord의 `/plan` 은 새 Codex 세션을 만드는 기능이 아니다.

- 기존 mapped thread 안에서만 실행 가능
- 현재 thread에 연결된 Codex 세션으로 planning-only 프롬프트를 보냄
- 실제 응답은 기존과 동일하게 watcher가 Discord thread에 다시 보냄

---

## JSONL 레코드 구조

현재 구현에서 의미 있게 읽는 타입은 아래뿐이다.

### `session_meta`

역할:

- 세션 ID 식별
- working directory 식별
- 세션 이름 생성에 필요한 기본 정보 확보

주요 필드:

```json
{
  "type": "session_meta",
  "payload": {
    "id": "session-id",
    "cwd": "/workspace/path"
  }
}
```

### `turn_context`

역할:

- 현재 turn이 `default` 인지 `plan` 인지 구분

주요 필드:

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

### `response_item`

역할:

- `request_user_input` 호출 감지
- assistant final answer 감지

질문 감지 예시:

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
        "text": "최종 응답"
      }
    ]
  }
}
```

---

## 재시작 복구와의 관계

현재 Codex 재시작 복구는 두 층으로 나뉜다.

### 1. thread-session 매핑 복구

파일:

```text
data/thread-bindings.json
```

역할:

- 기존 Discord thread가 어떤 sessionId와 연결되어 있었는지 복구
- bot과 bridge가 재시작 후 최소 상태를 다시 세움

### 2. 세션 JSONL 추적 복구

필수 조건:

- watcher가 기존 세션 파일의 첫 줄 `session_meta` 를 읽어 sessionId를 다시 알아내야 함

주의:

- `data/thread-bindings.json` 만 있다고 끝이 아님
- watcher가 해당 Codex 세션 파일을 제대로 prime하지 못하면, `resume` 성공 후에도 Discord에 응답이 안 온다

---

## 현재 구현된 것

- 세션 JSONL watcher
- `session_meta` / `turn_context` / `response_item` 파싱
- `request_user_input` → `ai_question`
- assistant final answer → `response_complete`
- Discord 답장 → `codex exec resume`
- `/plan` slash command
- restart 후 JSON binding 복구
- 긴 `session_meta` 첫 줄도 newline까지 읽도록 보완

---

## 현재 미구현

- Codex hooks 기반 수신 (`POST /hook/codex`)
- `.codex/hooks.json` 기반 공식 hook 연동
- Codex tool-level permission 중계
- Codex 세션 생성 자체를 Discord에서 시작하는 기능
- pending request 상태의 restart 복구

---

## 문서 해석 주의

이 폴더 안의 다른 오래된 문서에는 Codex hooks 기반 설명이 남아 있을 수 있다.
현재 실제 코드의 source of truth는 아래 파일들이다.

- `src/bridge/codexSessionWatcher.ts`
- `src/bridge/codexRunner.ts`
- `src/bridge/sessionManager.ts`
- `src/bot/threadManager.ts`
- `src/bot/commandHandler.ts`
