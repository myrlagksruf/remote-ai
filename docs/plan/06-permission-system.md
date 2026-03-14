# 06. 권한 시스템

## 권한 모드 개요

Claude Code와 Codex CLI의 권한 제어 방식은 구조가 다르다.
Claude는 `PreToolUse` hook으로 도구 실행을 차단할 수 있지만, Codex는 PreToolUse Hook이 없으므로 `approval-policy` 플래그와 `SessionStart` 컨텍스트 주입으로 제어한다.

---

## Claude Code 권한 모드

Claude Code의 권한 모드는 `settings.json`의 `permissions` 필드로 제어된다.

| 모드 | 설명 | 설정 방법 |
|------|------|-----------|
| `default` | 위험 도구는 허용 요청 | 기본값 |
| `auto` | 모든 도구 자동 허용 | `--dangerously-skip-permissions` 플래그 |
| `manual` | 모든 도구 수동 승인 | PreToolUse hook에서 전부 차단 후 응답 대기 |

**실용적 구현:**
- `auto` 모드: PreToolUse hook이 항상 `exit 0` 반환
- `manual` 모드: PreToolUse hook이 항상 Discord 승인 대기
- `default` 모드: 도구별로 선택적 Discord 승인 (Bash, Write 등 위험 도구만)

---

## Codex CLI 권한 모드

Codex는 `PreToolUse` Hook이 없어 도구별 실시간 차단이 불가능하다.
`approval-policy` 플래그로 전체 모드를 제어한다.

| 플래그 | 설명 | Discord 권한 모드 대응 |
|--------|------|----------------------|
| `--approval-policy auto` | 모든 명령 자동 실행 | `auto` |
| `--approval-policy on-failure` | 실패 시만 승인 | `default` |
| `--approval-policy never` | 항상 터미널에서 승인 요청 | `manual` (터미널 직접 응답) |

**제약사항**: `never` 모드에서 Codex는 터미널에 `[y/N]` 프롬프트를 출력한다.
원격 제어 중에는 이 응답을 Discord에서 받을 수 없으므로, 실질적으로 `auto` 모드 사용이 권장된다.

Bridge가 현재 권한 모드를 파일(`~/.remote-ai/codex-permission-mode`)에 저장하고, 다음 세션 시작 시 해당 모드에 맞는 플래그로 Codex를 실행한다.

---

## 권한 요청 흐름 (상세)

```
┌─────────────────────────────────────────────────────────────────┐
│ PreToolUse Hook / Codex Approval 발동                            │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
              ┌──────────────────────────┐
              │   현재 권한 모드 확인      │
              └──────────────────────────┘
                    │              │
               auto 모드       manual/default 모드
                    │              │
              exit 0 즉시      Discord로 권한 요청 전송
              허용 반환        (requestId 포함)
                               │
                               ▼
              ┌──────────────────────────┐
              │   Bridge: 응답 대기 큐    │
              │   (polling, 60초 타임아웃)│
              └──────────────────────────┘
                               │
              ┌────────────────┴──────────────────┐
              │                                   │
        사용자가 [허용] 클릭              사용자가 [거절] 클릭
              │                                   │
        Bridge에 allowed: true          Bridge에 allowed: false
              │                                   │
        Claude: exit 0 반환             Claude: exit 2 반환
        Codex: stdin에 'y' 주입         Codex: stdin에 'n' 주입
```

---

## 권한 요청 메시지 상세 형식

Discord Thread에 전송되는 권한 요청 메시지:

### Claude Code 예시
```
🔐 **권한 요청** (Claude Code)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
**도구:** `Bash`
**명령어:**
```bash
npm run build && npm test
```
**설명:** 빌드 후 테스트 실행
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⏳ 60초 내로 응답하지 않으면 자동 거절됩니다.
```

[✅ 허용] [❌ 거절] 버튼

### Codex 예시
```
🔐 **권한 요청** (Codex)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
**명령어:**
```bash
rm -rf node_modules
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⏳ 60초 내로 응답하지 않으면 자동 거절됩니다.
```

[✅ 허용] [❌ 거절] 버튼

---

## 위험 도구 분류 (default 모드)

`default` 모드에서 Discord 승인이 **필요한** 도구:

| 도구 | 위험 수준 | 이유 |
|------|-----------|------|
| `Bash` | 높음 | 임의 명령 실행 |
| `Write` | 중간 | 파일 덮어쓰기 |
| `Edit` | 낮음 | 기존 파일 수정 |
| `MultiEdit` | 낮음 | 다중 파일 수정 |

`default` 모드에서 Discord 승인이 **불필요한** (자동 허용) 도구:

| 도구 | 이유 |
|------|------|
| `Read` | 읽기 전용 |
| `Glob` | 읽기 전용 |
| `Grep` | 읽기 전용 |
| `TodoWrite` | 무해 |
| `WebSearch` | 읽기 전용 |

---

## Discord에서 권한 모드 변경

### Thread 내 텍스트 명령
```
/mode auto      → 이 세션을 auto 모드로 변경
/mode manual    → 이 세션을 manual 모드로 변경
/mode default   → 이 세션을 default 모드로 변경
```

### Bridge에서 처리
```json
POST /input
{
  "sessionId": "abc123",
  "type": "set_permission_mode",
  "mode": "auto"
}
```

Bridge가 해당 세션의 권한 모드 상태를 업데이트하고, 이후 PreToolUse hook에서 이 상태를 참조한다.

---

## 권한 상태 저장

Bridge Server의 메모리 상태:

```json
{
  "sessions": {
    "abc123": {
      "sessionId": "abc123",
      "tool": "claude",
      "permissionMode": "default",
      "pendingPermissions": {
        "req_001": {
          "requestId": "req_001",
          "toolName": "Bash",
          "toolInput": { "command": "npm test" },
          "createdAt": "2024-01-01T12:00:00Z",
          "expiresAt": "2024-01-01T12:01:00Z",
          "resolve": "[Function]",
          "reject": "[Function]"
        }
      }
    }
  }
}
```

`resolve`/`reject`는 Node.js Promise 콜백으로, 사용자가 응답하면 즉시 hook 프로세스에 결과를 반환한다.
