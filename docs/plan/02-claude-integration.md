# 02. Claude Code 연동 (Hooks 시스템)

## Claude Code Hooks 개요

Claude Code는 특정 이벤트 발생 시 외부 쉘 스크립트를 실행하는 **Hooks 시스템**을 제공한다.
이를 활용해 세션 이벤트를 Bridge Server로 전달한다.

### 사용 가능한 Hook 이벤트

| Hook 이름 | 발생 시점 | 활용 목적 |
|-----------|-----------|-----------|
| `PreToolUse` | 도구 실행 직전 | 권한 요청 감지 |
| `PostToolUse` | 도구 실행 완료 후 | 실행 결과 캡처 |
| `Notification` | Claude가 사용자에게 알림/질문 | AI 질문 감지 |
| `Stop` | 세션 응답 완료 시 | 최종 응답 캡처 |

---

## Hook 설정 위치

Claude Code의 글로벌 설정 파일:
```
~/.claude/settings.json
```

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bash /path/to/hooks/claude-hook.sh stop"
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bash /path/to/hooks/claude-hook.sh notification"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bash /path/to/hooks/claude-hook.sh pretool"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "bash /path/to/hooks/claude-hook.sh posttool"
          }
        ]
      }
    ]
  }
}
```

---

## Hook 스크립트 (`hooks/claude-hook.sh`)

Hook 실행 시 Claude가 **stdin**으로 JSON 데이터를 전달한다.

```bash
#!/bin/bash

EVENT_TYPE=$1
BRIDGE_URL="http://localhost:3000/hook/claude"
BRIDGE_SECRET="your_secret"

# stdin에서 Claude가 보내는 JSON 읽기
INPUT=$(cat)

# Bridge Server로 POST
curl -s -X POST "$BRIDGE_URL" \
  -H "Content-Type: application/json" \
  -H "X-Bridge-Secret: $BRIDGE_SECRET" \
  -d "{
    \"tool\": \"claude\",
    \"event\": \"$EVENT_TYPE\",
    \"sessionId\": \"$CLAUDE_SESSION_ID\",
    \"data\": $INPUT
  }"
```

### Hook에서 사용 가능한 환경변수

| 변수명 | 설명 |
|--------|------|
| `CLAUDE_SESSION_ID` | 현재 세션 고유 ID |
| `CLAUDE_SESSION_DIR` | 세션 디렉토리 경로 |

---

## 각 Hook 이벤트의 JSON 구조

### Stop (최종 응답 완료)
```json
{
  "session_id": "abc123",
  "stop_hook_active": true
}
```
→ Bridge가 이 이벤트를 받으면 **transcript 파일에서 마지막 assistant 메시지**를 읽어 Discord로 전송

### Notification (AI 질문/알림)
```json
{
  "session_id": "abc123",
  "message": "파일을 덮어쓸까요? plan mode를 진행할까요?"
}
```
→ Bridge가 Discord Thread에 질문 메시지 전송 + 사용자 응답 대기

### PreToolUse (도구 실행 전 - 권한 요청)
```json
{
  "session_id": "abc123",
  "tool_name": "Bash",
  "tool_input": {
    "command": "rm -rf /tmp/test",
    "description": "임시 파일 삭제"
  }
}
```
→ 권한 필요 도구(`Bash`, `Edit`, `Write` 등) 감지 시 Discord에 승인 요청 전송

### PostToolUse (도구 실행 후)
```json
{
  "session_id": "abc123",
  "tool_name": "Bash",
  "tool_input": { "command": "npm install" },
  "tool_response": { "output": "added 42 packages" }
}
```
→ 이 이벤트는 기본적으로 Discord에 보내지 않음 (Stop에서만 최종 결과 전송)

---

## 세션 이름 추출 방법

Claude Code는 세션 이름을 직접 제공하지 않는다.
아래 방법으로 세션 이름을 구성한다:

1. **첫 번째 사용자 메시지 첫 줄**을 세션 이름으로 사용
2. 또는 `CLAUDE_SESSION_ID` 앞 8자리 사용 (예: `claude-abc12345`)
3. Bridge Server에서 첫 `Stop` 이벤트 수신 시 transcript를 파싱해 이름 결정

---

## Transcript 파싱

최종 응답을 가져오기 위해 Claude의 transcript JSONL 파일을 파싱한다.

**파일 위치:** `~/.claude/projects/<project_path>/<session_id>.jsonl`

**파싱 대상:** 마지막 `role: "assistant"` 메시지의 `content`

```json
// JSONL 파일의 각 줄 형식
{"type": "message", "role": "user", "content": "..."}
{"type": "message", "role": "assistant", "content": "..."}
```

Bridge Server가 Stop hook 수신 시 해당 파일의 마지막 assistant 메시지를 추출해 Discord로 전송한다.

---

## PreToolUse에서 권한 제어

Claude Code의 PreToolUse hook은 **exit code**로 실행 여부를 제어할 수 있다.

| Exit Code | 의미 |
|-----------|------|
| `0` | 정상 진행 (도구 실행 허용) |
| `2` | 도구 실행 차단 (Claude에 에러 메시지 반환) |

권한 요청 흐름:
1. PreToolUse hook 발동 → Bridge에 전달
2. Bridge → Discord로 승인 요청 전송 (버튼 메시지)
3. Bridge는 사용자 응답을 **대기** (polling 방식, 최대 30초)
4. 승인 → exit 0 / 거절 → exit 2 (stderr로 거절 메시지)

> **주의**: Hook은 blocking 방식이므로 사용자가 응답할 때까지 Claude가 대기하게 된다.
