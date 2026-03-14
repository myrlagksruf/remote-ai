# 01. 시스템 아키텍처

## 전체 데이터 흐름

```
[Claude Code]          [Codex CLI]
    │                      │
    │ (hook 이벤트)         │ (hook 이벤트)
    │ ~/.claude/settings   │ .codex/hooks.json
    ▼                      ▼
┌──────────────────────────────────┐
│         Bridge Server            │
│    TypeScript + Fastify          │
│         localhost:3000           │
│                                  │
│  ┌────────────┐  ┌────────────┐  │
│  │  Session   │  │  Event     │  │
│  │  Manager   │  │  Parser    │  │
│  └────────────┘  └────────────┘  │
│  ┌────────────┐  ┌────────────┐  │
│  │  Input     │  │  State     │  │
│  │  Router    │  │  Store     │  │
│  └────────────┘  └────────────┘  │
└──────────────┬───────────────────┘
               │
               │ HTTP POST (이벤트 전달)
               ▼
┌──────────────────────────────────┐
│         Discord Bot              │
│    TypeScript + discord.js v14   │
│         + Fastify (수신용)        │
│                                  │
│  ┌────────────┐  ┌────────────┐  │
│  │  Thread    │  │  Message   │  │
│  │  Manager   │  │  Formatter │  │
│  └────────────┘  └────────────┘  │
│  ┌────────────┐  ┌────────────┐  │
│  │  Command   │  │  Pending   │  │
│  │  Handler   │  │  Requests  │  │
│  └────────────┘  └────────────┘  │
└──────────────────────────────────┘
               │
               ▼
         [Discord 채널]
         [Thread per Session]
```

---

## 컴포넌트 상세

### 1. Bridge Server (`/src/bridge/`)

Bridge Server는 로컬에서 실행되는 Fastify HTTP 서버로, AI 툴과 Discord Bot 사이의 중개자 역할을 한다.

**역할:**
- Claude Code hooks로부터 이벤트 수신 (`POST /hook/claude`)
- Codex CLI hooks로부터 이벤트 수신 (`POST /hook/codex`)
- Discord Bot에서 오는 사용자 입력 수신 (`POST /input`)
- 세션 상태 관리 (세션 ID → 메타데이터 매핑)
- 대기 중인 사용자 응답 처리 (Promise 기반 blocking)

**엔드포인트:**
```
POST /hook/claude  ← Claude Code hook 이벤트
POST /hook/codex   ← Codex CLI hook 이벤트
POST /input        ← Discord에서 오는 사용자 응답
GET  /sessions     ← 현재 활성 세션 목록 (디버깅용)
```

---

### 2. Session Manager

세션의 생명주기를 관리한다.

**세션 상태:**
```
created → active → waiting_input → active → completed
                       │
                  waiting_permission
```

**세션 데이터 구조 (TypeScript):**
```ts
interface Session {
  sessionId: string;
  tool: 'claude' | 'codex';
  name: string;
  discordThreadId: string | null;
  status: 'active' | 'waiting_input' | 'waiting_permission' | 'completed';
  pendingRequests: Map<string, PendingRequest>;
  createdAt: Date;
  lastActivity: Date;
}

interface PendingRequest {
  requestId: string;
  type: 'ai_question' | 'permission_request';
  resolve: (value: string | boolean) => void;
  reject: (reason?: unknown) => void;
  timeoutHandle: NodeJS.Timeout;
}
```

---

### 3. Discord Bot (`/src/bot/`)

discord.js v14 기반 봇. Fastify로 Bridge로부터 이벤트를 수신한다.

**역할:**
- Bridge Server로부터 이벤트 수신 (Fastify, `POST /bot/event`)
- Thread에 메시지 전송
- 사용자의 Thread 내 메시지를 Bridge Server로 전달
- 권한 요청 시 버튼(승인/거절) 포함 메시지 전송

---

### 4. 통신 프로토콜

Bridge → Bot: Bridge Server가 Bot의 Fastify endpoint에 POST 요청
Bot → Bridge: 사용자 메시지 수신 시 Bridge의 `/input`에 POST 요청

```
[Bridge Server] ──POST /bot/event──→ [Discord Bot Fastify endpoint]
[Discord Bot]   ──POST /input──────→ [Bridge Server]
```

> **단순성 우선**: WebSocket 없이 HTTP POST 방식을 사용.

---

## 디렉토리 구조

```
remote-ai/
├── src/
│   ├── bridge/
│   │   ├── index.ts            # Bridge Server 진입점 (Fastify)
│   │   ├── sessionManager.ts   # 세션 상태 관리
│   │   ├── eventParser.ts      # 이벤트 파싱 (Claude/Codex 공통)
│   │   └── inputRouter.ts      # 사용자 입력 → AI 세션 라우팅
│   │
│   ├── bot/
│   │   ├── index.ts            # Discord Bot 진입점
│   │   ├── server.ts           # Fastify 서버 (Bridge 이벤트 수신용)
│   │   ├── threadManager.ts    # Thread 생성/관리
│   │   ├── messageFormatter.ts # 메시지 포맷팅
│   │   ├── commandHandler.ts   # 슬래시 커맨드 처리
│   │   └── pendingRequests.ts  # 대기 중 요청 관리
│   │
│   └── shared/
│       ├── types.ts            # 공통 타입/인터페이스 정의
│       └── config.ts           # 환경 설정 로드
│
├── hooks/
│   └── claude-hook.sh          # Claude Code용 hook 스크립트 (bash)
│
├── .codex/
│   └── hooks.json              # Codex CLI용 hook 설정
│
├── .env
├── .env.example
├── package.json
├── tsconfig.json
└── docs/plan/                  # 계획서
```

---

## TypeScript 설정 (`tsconfig.json`)

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

---

## 주요 의존성 (`package.json`)

```json
{
  "dependencies": {
    "discord.js": "^14.x",
    "fastify": "^5.x",
    "dotenv": "^16.x"
  },
  "devDependencies": {
    "typescript": "^5.x",
    "tsx": "^4.x",
    "@types/node": "^22.x"
  },
  "scripts": {
    "dev:bridge": "tsx watch src/bridge/index.ts",
    "dev:bot": "tsx watch src/bot/index.ts",
    "build": "tsc",
    "start:bridge": "node dist/bridge/index.js",
    "start:bot": "node dist/bot/index.js"
  }
}
```

---

## 환경변수 (.env)

```env
# Discord
DISCORD_TOKEN=your_bot_token
DISCORD_GUILD_ID=your_server_id
DISCORD_CHANNEL_ID=your_channel_id   # thread 부모 채널
DISCORD_USER_ID=your_user_id         # 알림 받을 유저 ID

# Bridge Server
BRIDGE_PORT=3000
BRIDGE_SECRET=random_secret_key      # 간단한 인증용

# Bot HTTP endpoint (Bridge → Bot 통신용)
BOT_PORT=3001
```
