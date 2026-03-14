# 07. 구현 단계별 계획

## 기술 스택 확정

| 항목 | 선택 |
|------|------|
| 언어 | TypeScript |
| HTTP 서버 | Fastify v5 |
| Discord | discord.js v14 |
| 런타임 (개발) | tsx watch |
| 빌드 | tsc |

---

## 구현 순서 개요

```
Step 1: 프로젝트 초기 설정 (TypeScript + Fastify 환경)
Step 2: Bridge Server 기본 구현 (Fastify)
Step 3: Claude Code Hook 연동
Step 4: Discord Bot 기본 구현 + Thread 관리
Step 5: 이벤트 라우팅 연결 (Bridge ↔ Bot)
Step 6: 권한 시스템 구현 (Claude)
Step 7: Codex Hook 연동
Step 8: 슬래시 커맨드 및 UI 개선
Step 9: 테스트 및 안정화
```

---

## Step 1: 프로젝트 초기 설정

**목표:** TypeScript + Fastify 개발 환경 구성

**작업:**
- [ ] `package.json` 생성
  - 의존성: `discord.js`, `fastify`, `dotenv`
  - 개발 의존성: `typescript`, `tsx`, `@types/node`
- [ ] `tsconfig.json` 생성 (target: ES2022, moduleResolution: NodeNext)
- [ ] `.env` 및 `.env.example` 생성
- [ ] 디렉토리 구조 생성 (`src/bridge/`, `src/bot/`, `src/shared/`, `hooks/`, `.codex/`)
- [ ] `src/shared/config.ts` — 환경변수 로드 및 타입 정의
- [ ] `src/shared/types.ts` — 공통 인터페이스 정의 (`BridgeEvent`, `Session`, `PendingRequest` 등)
- [ ] Discord Bot 토큰 발급 및 서버에 봇 초대 (권한: Thread 생성, 메시지 전송, 버튼 인터랙션)
- [ ] `#ai-sessions` 채널 생성

**검증:**
```bash
npx tsx src/shared/config.ts  # 설정 로드 확인
```

---

## Step 2: Bridge Server 기본 구현

**목표:** Fastify 기반 이벤트 수신 서버 및 세션 관리

**작업:**
- [ ] `src/bridge/index.ts` — Fastify 서버 기본 구조
  - `POST /hook/claude` — Claude hook 이벤트 수신
  - `POST /hook/codex` — Codex hook 이벤트 수신
  - `POST /input` — Discord에서 오는 사용자 응답
  - `GET /sessions` — 활성 세션 목록 (디버깅용)
  - `X-Bridge-Secret` 헤더 검증 hook (`fastify.addHook('preHandler', ...)`)
- [ ] `src/bridge/sessionManager.ts` — 세션 CRUD
  - `createSession(id: string, tool: 'claude' | 'codex', name: string): Session`
  - `getSession(id: string): Session | undefined`
  - `updateSession(id: string, data: Partial<Session>): void`
  - `endSession(id: string): void`
  - `getAllSessions(): Session[]`
- [ ] `src/bridge/eventParser.ts` — 이벤트 정규화
  - Claude raw hook JSON → `BridgeEvent`
  - Codex raw hook JSON → `BridgeEvent`

**검증:**
```bash
npx tsx src/bridge/index.ts

curl -X POST http://localhost:3000/hook/claude \
  -H "Content-Type: application/json" \
  -H "X-Bridge-Secret: test" \
  -d '{"event":"stop","sessionId":"test-123","data":{}}'
```

---

## Step 3: Claude Code Hook 연동

**목표:** Claude Code의 이벤트를 Bridge Server로 전달

**작업:**
- [ ] `hooks/claude-hook.sh` 작성
  - 이벤트 타입: `stop`, `notification`, `pretool`, `posttool`
  - stdin JSON 읽기 → Bridge `POST /hook/claude`
  - `CLAUDE_SESSION_ID` 환경변수 포함
- [ ] `~/.claude/settings.json`에 4개 hook 등록
- [ ] `src/bridge/eventParser.ts`에 Claude transcript 파싱 추가
  - `~/.claude/projects/` 에서 세션 JSONL 파일 탐색
  - 마지막 `role: "assistant"` 메시지 추출
  - 첫 `role: "user"` 메시지로 세션 이름 추출

**검증:**
```bash
# Claude Code에서 간단한 작업 실행
claude "현재 날짜를 알려줘"
# Bridge 로그에서 stop 이벤트 수신 확인
```

---

## Step 4: Discord Bot 기본 구현 + Thread 관리

**목표:** discord.js v14 봇 실행, Fastify로 Bridge 이벤트 수신, Thread 관리

**작업:**
- [ ] `src/bot/index.ts` — discord.js Client 초기화 및 이벤트 리스너
  - `GatewayIntentBits.Guilds`, `GuildMessages`, `MessageContent` 설정
  - `Events.Ready`, `Events.MessageCreate`, `Events.InteractionCreate` 리스너
- [ ] `src/bot/server.ts` — Fastify 서버 (Bridge 이벤트 수신)
  - `POST /bot/event` — Bridge로부터 이벤트 수신
  - 이벤트 타입별 핸들러 분기
- [ ] `src/bot/threadManager.ts` — Thread 생성/관리
  - `createThread(sessionId: string, sessionName: string, tool: string): Promise<ThreadChannel>`
  - `getThread(sessionId: string): ThreadChannel | undefined`
  - `archiveThread(sessionId: string): Promise<void>`
  - `sessionThreadMap: Map<string, string>` (sessionId → threadId)
  - `threadSessionMap: Map<string, string>` (threadId → sessionId)
- [ ] `src/bot/messageFormatter.ts` — 메시지 포맷팅
  - `formatResponseComplete(data): string`
  - `formatAIQuestion(data): string`
  - `formatPermissionRequest(data): { content: string; components: ActionRowBuilder[] }`
  - `formatSessionStart(data): string`
  - `formatSessionEnd(data): string`

**검증:**
```bash
npx tsx src/bot/index.ts
# Discord 서버에서 봇 Online 확인

curl -X POST http://localhost:3001/bot/event \
  -H "Content-Type: application/json" \
  -d '{"tool":"claude","sessionId":"test-123","sessionName":"테스트","event":"session_start","data":{}}'
# Discord에서 Thread 생성 확인
```

---

## Step 5: 이벤트 라우팅 연결 (Bridge ↔ Bot)

**목표:** 양방향 이벤트 흐름 연결

**작업:**
- [ ] `src/bridge/inputRouter.ts`
  - `notifyBot(event: BridgeEvent): Promise<void>` → `POST http://localhost:3001/bot/event`
  - 각 이벤트 타입별 Bot 알림 트리거 연결
- [ ] `src/bot/commandHandler.ts` — 사용자 메시지 처리
  - Thread 내 메시지 수신 시 `sessionId` 조회
  - 지정 유저(`DISCORD_USER_ID`)만 처리
  - Bridge `POST /input` 전달
- [ ] `src/bot/pendingRequests.ts`
  - 응답 대기 중인 Thread 목록 관리
  - 사용자 메시지 → 올바른 requestId 매핑

**검증:**
```bash
# Claude 세션 시작 → Thread 자동 생성
# Claude 작업 완료 → Thread에 결과 메시지
# Thread에 답변 → Bridge /input 수신 로그 확인
```

---

## Step 6: 권한 시스템 구현 (Claude)

**목표:** Claude의 PreToolUse hook으로 권한 요청 처리, Discord 버튼 응답

**작업:**
- [ ] `src/bridge/sessionManager.ts`에 pending permission 추가
  - `createPermissionRequest(sessionId, toolName, toolInput)` → Promise + requestId
  - `resolvePermission(requestId, allowed: boolean)` → Promise resolve/reject
  - 60초 타임아웃 시 자동 거절 + Bot에 타임아웃 알림
- [ ] `hooks/claude-hook.sh` pretool 이벤트
  - Bridge `POST /hook/claude` (event: `pretool`) 호출
  - Bridge 응답 대기 (최대 60초 polling: `GET /sessions/:id/permission/:requestId`)
  - 응답에 따라 `exit 0` 또는 `exit 2`
- [ ] Bot 버튼 인터랙션 처리 (`src/bot/commandHandler.ts`)
  - `ButtonBuilder`: `customId: "perm_allow_<requestId>"`, `"perm_deny_<requestId>"`
  - 클릭 시 Bridge `POST /input` (type: `permission_response`)
  - `interaction.update({ components: [] })` — 버튼 비활성화
- [ ] Thread 내 `/mode <auto|manual|default>` 텍스트 명령 파싱

**검증:**
```bash
# Claude가 Bash 명령 실행 시도
# Discord Thread에 [허용]/[거절] 버튼 메시지 확인
# 버튼 클릭 → Claude 실행 결과 확인
```

---

## Step 7: Codex Hook 연동

**목표:** Codex CLI의 공식 Hooks 시스템으로 이벤트 캡처

**작업:**
- [ ] `hooks/codex-hook.sh` 작성
  - 이벤트 타입: `session_start`, `stop`, `after_tool`
  - stdin JSON 읽기 → Bridge `POST /hook/codex`
  - `CODEX_SESSION_ID` 환경변수 포함
- [ ] `.codex/hooks.json` 생성
  - `SessionStart`, `Stop`, `AfterToolUse` hook 등록
  - `features.codex_hooks=true` 활성화 방법 문서화
- [ ] `src/bridge/eventParser.ts`에 Codex 이벤트 파싱 추가
  - `SessionStart`: 세션 생성, Discord Thread 생성
  - `Stop`: 최종 응답 추출 → Discord 전송
  - `AfterToolUse`: 기본 무시 (Stop에서만 전송)
- [ ] 권한 모드 파일 (`~/.remote-ai/codex-permission-mode`) 관리

**참고:** Codex는 PreToolUse Hook이 없으므로 도구별 실시간 권한 차단 불가.
권한 제어는 세션 시작 시 `--approval-policy` 플래그로만 적용.

**검증:**
```bash
codex --config features.codex_hooks=true "현재 디렉토리 파일 목록 보여줘"
# Bridge 로그에서 session_start, stop 이벤트 확인
# Discord Thread 생성 및 결과 메시지 확인
```

---

## Step 8: 슬래시 커맨드 및 UI 개선

**목표:** 편의 기능 추가

**작업:**
- [ ] 슬래시 커맨드 등록 (discord.js REST API)
  - `/ai sessions` — 활성 세션 목록 Embed
  - `/ai send <session_id> <message>` — 세션에 직접 메시지
  - `/ai mode <session_id> <auto|manual|default>` — 권한 모드 변경
- [ ] 메시지 길이 처리
  - 2000자 이내: 단일 메시지
  - 2000자 초과: `.txt` 파일 첨부 (`AttachmentBuilder`)
- [ ] 타임아웃 알림 메시지 (Thread에 전송)
- [ ] 세션 목록 `EmbedBuilder` 포맷

---

## Step 9: 테스트 및 안정화

**체크리스트:**
- [ ] Claude Code 전체 흐름 (시작 → 작업 → 권한 요청 → 완료)
- [ ] Codex 전체 흐름 (SessionStart → Stop)
- [ ] 동시 다중 세션 (Claude + Codex 동시 실행)
- [ ] Bridge 재시작 시 명확한 실패 처리 (세션 끊김 알림)
- [ ] Discord Rate Limit 처리 (메시지 실패 재시도)
- [ ] Bridge ↔ Bot 통신 실패 에러 처리
- [ ] 2000자 초과 응답 파일 첨부 테스트

---

## 최종 실행 방법

```bash
# 개발 모드 (tsx watch)
npm run dev:bridge   # Terminal 1: Bridge Server
npm run dev:bot      # Terminal 2: Discord Bot

# Claude Code 사용 (hooks 자동 동작)
claude "작업 내용"

# Codex 사용 (hooks 활성화 필요)
codex -c features.codex_hooks=true "작업 내용"

# 프로덕션 빌드
npm run build
npm run start:bridge
npm run start:bot
```

---

## 구현 완료 기준

| 기능 | 완료 조건 |
|------|-----------|
| Claude 세션 감지 | Claude 실행 시 Discord Thread 자동 생성 |
| 최종 응답 전송 | 작업 완료 시 Thread에 결과 메시지 |
| AI 질문 전달 | Notification hook → Thread 질문 메시지 |
| 권한 요청 (Claude) | Bash 실행 시 [허용]/[거절] 버튼 메시지 |
| 사용자 응답 | Thread 답변 → Claude/Codex 전달 |
| 권한 모드 변경 | `/mode auto` Thread 명령 동작 |
| Codex 연동 | SessionStart/Stop hook → Thread 생성 및 결과 |
| 다중 세션 | Thread가 세션별로 독립 관리 |
| TypeScript 빌드 | `npm run build` 에러 없이 완료 |
