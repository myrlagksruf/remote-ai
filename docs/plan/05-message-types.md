# 05. 메시지 타입 정의 및 라우팅 로직

## 공통 이벤트 스키마

모든 이벤트는 Bridge Server를 통해 아래 스키마로 정규화된다.

```ts
interface BridgeEvent {
  tool: "claude" | "codex";
  sessionId: string;
  sessionName: string;
  event: EventType;
  data: EventData;
  timestamp: string;        // ISO 8601
  requestId?: string;       // 응답 대기가 필요한 이벤트에 포함
}

type EventType =
  | "session_start"
  | "session_end"
  | "response_complete"
  | "ai_question"
  | "permission_request"
  | "permission_mode_changed";

interface EventData {
  message?: string;         // 표시할 텍스트
  tool_name?: string;       // PreToolUse: 도구 이름
  tool_input?: object;      // PreToolUse: 도구 입력
  permission_mode?: string; // 현재 권한 모드
}
```

---

## 이벤트별 처리 흐름

### 1. `session_start`

**트리거:** 세션 첫 이벤트 도착 (Claude: Stop/Notification/PreToolUse 중 최초 수신 시)

**Bridge 처리:**
- 세션 등록 및 메타데이터 초기화
- Bot에 `session_start` 이벤트 전달

**Bot 처리:**
- 부모 채널에 새 Thread 생성
- `sessionId → threadId` 매핑 저장
- Thread에 세션 시작 메시지 전송

---

### 2. `session_end`

**트리거:** Claude의 `Stop` hook 또는 Codex wrapper가 프로세스 종료 감지

**Bridge 처리:**
- 세션 상태 `completed`로 변경
- Bot에 `session_end` 이벤트 전달

**Bot 처리:**
- Thread에 세션 종료 메시지 전송
- Thread 아카이브 (선택적, 24시간 후 자동)

---

### 3. `response_complete`

**트리거:**
- Claude: `Stop` hook 수신 후 transcript 파싱 완료
- Codex: 응답 완료 패턴 감지

**Bridge 처리:**
- 최종 응답 텍스트 추출/정리
- Bot에 전달

**Bot 처리:**
- Thread에 응답 메시지 전송 (포맷: `✅ 작업 완료`)
- 2000자 초과 시 파일 첨부

**사용자 측 액션 불필요** (단방향 알림)

---

### 4. `ai_question`

**트리거:**
- Claude: `Notification` hook 수신 (사용자 확인/입력 필요)
- Codex: `[y/N]`, `Proceed?` 패턴 감지

**Bridge 처리:**
- `requestId` 생성
- 대기 큐에 request 등록
- Bot에 전달
- 사용자 응답을 **polling** (최대 300초)

**Bot 처리:**
- Thread에 질문 메시지 전송
- 사용자의 다음 Thread 메시지를 응답으로 처리
- 응답을 Bridge `/input` 엔드포인트로 전달

**Bridge → AI 전달:**
- Claude: stdin 또는 다음 프롬프트로 주입
- Codex: wrapper가 stdin에 사용자 응답 주입

```
[Bridge] requestId 대기 큐 등록
    ↓
[Bot] Discord Thread에 질문 전송
    ↓
[User] Thread에 답변 입력
    ↓
[Bot] Bridge /input POST
    ↓
[Bridge] 대기 중인 request 완료 처리
    ↓
[Hook/Wrapper] 응답 반환 → AI 계속 실행
```

---

### 5. `permission_request`

**트리거:**
- Claude: `PreToolUse` hook (exit code로 제어 가능)
- Codex: `Allow command:` 패턴 감지

**Bridge 처리:**
- `requestId` 생성
- 대기 큐에 permission request 등록
- Bot에 전달
- 사용자 응답을 **polling** (최대 60초, 미응답 시 자동 거절)

**Bot 처리:**
- Thread에 권한 요청 메시지 + [허용]/[거절] 버튼 전송
- 버튼 클릭 → Bridge `/input` POST

**Bridge → AI 전달:**
- Claude hook: `exit 0` (허용) or `exit 2` (거절)
- Codex wrapper: stdin에 `y` or `n` 주입

---

## 사용자 → Bot → Bridge 입력 타입

### 타입 1: 일반 텍스트 응답 (Thread 메시지)
```json
POST /input
{
  "sessionId": "abc123",
  "requestId": "req_456",
  "type": "text_response",
  "content": "네, 진행해주세요"
}
```

### 타입 2: 권한 응답 (버튼 클릭)
```json
POST /input
{
  "sessionId": "abc123",
  "requestId": "req_789",
  "type": "permission_response",
  "allowed": true
}
```

### 타입 3: 직접 프롬프트 (새 질문)
```json
POST /input
{
  "sessionId": "abc123",
  "requestId": null,
  "type": "direct_prompt",
  "content": "이제 테스트를 실행해줘"
}
```

### 타입 4: 권한 모드 변경
```json
POST /input
{
  "sessionId": "abc123",
  "requestId": null,
  "type": "set_permission_mode",
  "mode": "auto"
}
```

---

## 응답 대기 타임아웃

| 이벤트 타입 | 타임아웃 | 타임아웃 시 동작 |
|-------------|----------|-----------------|
| `ai_question` | 300초 (5분) | 빈 응답 반환 |
| `permission_request` | 60초 | 자동 거절 |
| `direct_prompt` | 해당 없음 | - |

타임아웃 시 Bot이 Thread에 알림:
```
⏰ 응답 대기 시간이 초과되었습니다. 자동으로 [거절/빈 응답]으로 처리되었습니다.
```
