# 03. OpenAI Codex CLI 연동 (Hooks 시스템)

## Codex CLI Hooks 개요

OpenAI Codex CLI는 v0.114.0부터 **실험적 Hooks 시스템**을 제공한다.
Claude Code와 유사한 구조이지만 몇 가지 중요한 차이점이 있다.

### 활성화 방법

```bash
codex -c features.codex_hooks=true
```

또는 설정 파일에 영구 적용:

**`~/.codex/config.toml` (또는 프로젝트 `.codex/config.toml`):**
```toml
[features]
codex_hooks = true
```

---

## 지원 Hook 이벤트

| Hook 이름 | 발생 시점 | Claude 대응 Hook |
|-----------|-----------|-----------------|
| `SessionStart` | 세션 시작 시 | *(없음)* |
| `Stop` | 턴(응답) 완료 시 | `Stop` |
| `AfterToolUse` | 도구 실행 완료 후 | `PostToolUse` |

> **중요 차이점**: Codex는 **`PreToolUse`에 해당하는 Hook이 없다.**
> 도구 실행 전에 exit code로 차단하는 기능을 지원하지 않는다.
> 따라서 Codex의 **권한 제어는 Claude와 다른 방식**으로 처리해야 한다. ([06-permission-system.md](./06-permission-system.md) 참조)

---

## Hook 설정 파일

**위치:** `.codex/hooks.json` (프로젝트 루트 또는 홈 디렉토리)

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash /path/to/hooks/codex-hook.sh session_start",
            "timeout": 10
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash /path/to/hooks/codex-hook.sh stop",
            "timeout": 30
          }
        ]
      }
    ],
    "AfterToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "bash /path/to/hooks/codex-hook.sh after_tool",
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

---

## Hook 스크립트 (`hooks/codex-hook.sh`)

Codex도 Claude와 동일하게 **stdin으로 JSON 데이터**를 전달한다.

```bash
#!/bin/bash

EVENT_TYPE=$1
BRIDGE_URL="http://localhost:3000/hook/codex"
BRIDGE_SECRET="your_secret"

# stdin에서 Codex가 보내는 JSON 읽기
INPUT=$(cat)

# Bridge Server로 POST
curl -s -X POST "$BRIDGE_URL" \
  -H "Content-Type: application/json" \
  -H "X-Bridge-Secret: $BRIDGE_SECRET" \
  -d "{
    \"tool\": \"codex\",
    \"event\": \"$EVENT_TYPE\",
    \"sessionId\": \"$CODEX_SESSION_ID\",
    \"data\": $INPUT
  }"
```

---

## 각 Hook의 stdin JSON 구조

### SessionStart
```json
{
  "session_id": "xyz789",
  "context": "세션 시작 시 제공된 컨텍스트 정보"
}
```
→ Bridge: 세션 등록, Discord Thread 생성

**SessionStart의 특수 기능:**
Codex의 `SessionStart` hook은 stdout으로 출력한 내용이 모델 컨텍스트에 주입된다.
이를 활용해 Bridge가 현재 권한 모드 등의 정보를 Codex에 주입할 수 있다.

```bash
# hook 스크립트에서 모델에 컨텍스트 주입 예시
echo "현재 권한 모드: manual. 모든 도구 실행 전 사용자 승인 필요."
```

---

### Stop (최종 응답 완료)
```json
{
  "session_id": "xyz789",
  "output": "AI의 최종 응답 텍스트"
}
```
→ Bridge: Discord Thread에 최종 응답 전송

---

### AfterToolUse (도구 실행 후)
```json
{
  "session_id": "xyz789",
  "tool_name": "shell",
  "tool_input": { "command": "npm test" },
  "tool_output": { "stdout": "...", "exit_code": 0 }
}
```
→ Bridge: 기본적으로 Discord에 전송하지 않음 (Stop에서만 최종 결과 전송)

---

## Claude와의 핵심 차이 비교

| 항목 | Claude Code | Codex CLI |
|------|-------------|-----------|
| Hook 설정 위치 | `~/.claude/settings.json` | `.codex/hooks.json` |
| Session ID 환경변수 | `CLAUDE_SESSION_ID` | `CODEX_SESSION_ID` |
| PreToolUse (차단) | ✅ 지원 (exit code 2) | ❌ 미지원 |
| PostToolUse | ✅ `PostToolUse` | ✅ `AfterToolUse` |
| 세션 완료 | ✅ `Stop` | ✅ `Stop` |
| 세션 시작 | ❌ (첫 이벤트로 감지) | ✅ `SessionStart` |
| Hook 활성화 | 기본 활성 | `features.codex_hooks=true` 필요 |

---

## Codex 권한 제어 대안 방법

PreToolUse가 없으므로 Codex의 권한 제어는 다음 방식을 사용한다:

### 방법 1: Approval Policy 플래그
Codex CLI는 실행 시 권한 정책을 설정하는 플래그를 제공한다:

| 플래그 | 의미 |
|--------|------|
| `--approval-policy auto` | 모든 명령 자동 실행 |
| `--approval-policy on-failure` | 실패 시만 승인 |
| `--approval-policy never` | 항상 승인 요청 (기본) |

`never` 모드에서 Codex는 터미널에서 직접 `[y/N]` 프롬프트를 표시한다.
이 경우 wrapper 방식이 필요해질 수 있다.

### 방법 2: SessionStart 컨텍스트 주입
`SessionStart` hook stdout으로 권한 관련 지시를 모델에 주입한다:

```bash
# 현재 권한 설정을 모델에 알림
PERMISSION_MODE=$(cat ~/.remote-ai/codex-permission-mode 2>/dev/null || echo "default")
echo "권한 모드: $PERMISSION_MODE. 파괴적 작업 실행 전 사용자 확인 필요."
```

### 방법 3: 하이브리드 (권장)
- 권한 모드 `auto`: `--approval-policy auto` 플래그로 실행
- 권한 모드 `manual`: `--approval-policy never` 플래그로 실행 (터미널 직접 응답 필요)
- 상세 알림은 `Stop`, `AfterToolUse` hook으로 Discord에 전달

> **결론**: Codex에서의 세밀한 도구별 권한 차단은 현재 hooks로 불가능하다.
> `approval-policy` 플래그로 전체 모드만 제어하고, 실시간 알림에 집중한다.

---

## 세션 이름 추출

Codex는 `SessionStart` hook에서 세션 정보를 제공한다.
세션 이름 구성:
1. Codex 실행 시 첫 번째 인자(프롬프트) 앞 30자를 세션 이름으로 사용
2. 없으면 `codex-<session_id 앞 8자리>` 형태로 자동 생성

---

## 공통 이벤트 포맷 (Bridge 정규화)

Claude와 Codex 이벤트를 Bridge에서 동일한 포맷으로 정규화:

```ts
interface BridgeEvent {
  tool: 'claude' | 'codex';
  sessionId: string;
  sessionName: string;
  event: 'session_start' | 'session_end' | 'response_complete' | 'ai_question' | 'after_tool';
  data: {
    message?: string;
    toolName?: string;
    toolInput?: Record<string, unknown>;
    toolOutput?: Record<string, unknown>;
  };
  timestamp: string;
  requestId?: string;
}
```
