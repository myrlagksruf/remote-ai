# 04. Discord Bot 구조 (discord.js v14)

## 기본 설정

discord.js v14를 사용하며, **Thread** 기반으로 세션을 관리한다.

### 필요 Intent
```js
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ]
});
```

---

## Thread 구조

```
Discord 서버
  └── #ai-sessions (텍스트 채널, thread 부모 채널)
        ├── Thread: "claude-abc12345" (Claude 세션 1)
        │     ├── [Bot] ✅ 작업 완료: ...
        │     ├── [Bot] ❓ AI 질문: 계획을 진행할까요?
        │     │         [승인] [거절] 버튼
        │     └── [User] 네, 진행해주세요
        │
        ├── Thread: "codex-xyz78901" (Codex 세션 1)
        │     ├── [Bot] 🔐 권한 요청: `rm -rf /tmp`
        │     │         [허용] [거절] 버튼
        │     └── [User] 허용
        │
        └── Thread: "claude-def45678" (Claude 세션 2, 아카이브됨)
```

---

## Thread 관리 (`threadManager.js`)

### Thread 생성
세션 시작 이벤트 수신 시 자동 생성:

```js
async function createSessionThread(session) {
  const channel = await client.channels.fetch(DISCORD_CHANNEL_ID);
  const thread = await channel.threads.create({
    name: session.name,           // 세션 이름
    autoArchiveDuration: 1440,    // 24시간 후 자동 아카이브
    type: ChannelType.PublicThread,
    reason: `AI 세션: ${session.tool} - ${session.id}`
  });
  return thread;
}
```

### Thread 종료 (아카이브)
세션 종료 이벤트 수신 시:
```js
async function archiveSessionThread(threadId) {
  const thread = await client.channels.fetch(threadId);
  await thread.setArchived(true);
}
```

### Thread ↔ 세션 매핑
메모리 내 Map으로 관리:
```js
// sessionId → threadId
const sessionThreadMap = new Map();

// threadId → sessionId (역방향 - 사용자 메시지 처리용)
const threadSessionMap = new Map();
```

---

## 메시지 포맷 (`messageFormatter.js`)

### 1. 최종 응답 메시지

```
✅ **작업 완료**
━━━━━━━━━━━━━━━━━━━━
[AI의 최종 응답 내용]
━━━━━━━━━━━━━━━━━━━━
🕐 완료 시각: 14:23:05
```

길이가 2000자를 초과하면 파일 첨부 or 여러 메시지로 분할.

---

### 2. AI 질문 메시지 (사용자 응답 필요)

```
❓ **AI가 확인을 요청합니다**
━━━━━━━━━━━━━━━━━━━━
[AI의 질문 내용]
━━━━━━━━━━━━━━━━━━━━
💬 이 Thread에 답변을 입력하세요.
```

→ 사용자가 Thread에 텍스트 답변 입력

---

### 3. 권한 요청 메시지 (버튼 포함)

```
🔐 **권한 요청**
━━━━━━━━━━━━━━━━━━━━
도구: `Bash`
명령: `rm -rf /tmp/test`
설명: 임시 파일 삭제
━━━━━━━━━━━━━━━━━━━━
```
[✅ 허용] [❌ 거절] 버튼

→ discord.js `ActionRow` + `ButtonBuilder` 사용

---

### 4. 세션 시작 메시지

```
🚀 **새 세션 시작**
도구: Claude Code
세션 ID: abc12345
시작 시각: 14:20:00
```

---

### 5. 세션 종료 메시지

```
🏁 **세션 종료**
소요 시간: 3분 12초
```

---

## 사용자 입력 처리 (`commandHandler.js`)

### Thread 내 일반 메시지
```js
client.on(Events.MessageCreate, async (message) => {
  // 봇 메시지 무시
  if (message.author.bot) return;

  // Thread 메시지인지 확인
  if (!message.channel.isThread()) return;

  // 지정된 유저만 허용
  if (message.author.id !== DISCORD_USER_ID) return;

  // 해당 Thread가 어느 세션인지 찾기
  const sessionId = threadSessionMap.get(message.channelId);
  if (!sessionId) return;

  // Bridge Server로 사용자 메시지 전달
  await sendInputToBridge(sessionId, message.content);
});
```

### 버튼 인터랙션 처리
```js
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isButton()) return;

  const { customId, channelId } = interaction;
  // customId 형식: "permission_allow_<requestId>" or "permission_deny_<requestId>"

  const [action, type, requestId] = customId.split('_');
  const sessionId = threadSessionMap.get(channelId);

  // Bridge로 권한 응답 전달
  await sendPermissionResponse(sessionId, requestId, type === 'allow');

  // 버튼 비활성화 (한 번만 응답 가능)
  await interaction.update({
    components: [] // 버튼 제거
  });
});
```

---

## 슬래시 커맨드 (`/ai`)

복잡한 커맨드는 슬래시 커맨드로 제공. Thread 밖에서도 사용 가능.

### 커맨드 목록

| 커맨드 | 설명 |
|--------|------|
| `/ai sessions` | 현재 활성 세션 목록 표시 |
| `/ai mode <session> <auto\|manual>` | 특정 세션의 권한 모드 변경 |
| `/ai send <session> <message>` | 특정 세션에 메시지 직접 전송 |
| `/ai kill <session>` | 특정 세션 종료 |

> **단순성 우선**: 슬래시 커맨드는 최소화하고, 대부분의 상호작용은 Thread 내 메시지 + 버튼으로 처리.

---

## Bot HTTP Endpoint

Bridge로부터 이벤트를 수신하기 위한 Express 서버를 Bot 프로세스 내에 포함:

```
POST /bot/event
{
  "tool": "claude",
  "sessionId": "abc123",
  "event": "response_complete",
  "data": { "message": "작업이 완료되었습니다." }
}
```

Bot이 이 요청을 받으면:
1. `sessionId`로 Thread 찾기 (없으면 새 Thread 생성)
2. 이벤트 타입에 맞는 메시지 포맷 적용
3. Thread에 메시지 전송

---

## 메시지 길이 처리

Discord 메시지 최대 길이: **2000자**

긴 응답 처리 방법:
1. 2000자 이내: 단일 메시지 전송
2. 2000~4000자: 두 개 메시지로 분할
3. 4000자 초과: 텍스트 파일로 첨부 (`response.txt`)
