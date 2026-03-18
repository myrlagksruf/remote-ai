# remote-ai

Codex events are ingested by watching `~/.codex/sessions/**/*.jsonl`. Codex hooks are not used in this project.

## Prerequisites

- Node.js `>= 25`
- A configured `.env` based on [`.env.example`](C:\Users\myrla\remote-ai\.env.example)
- A reachable Discord bot with access to `DISCORD_CHANNEL_ID`
- Codex CLI installed locally

## Run

Run everything from the project root:

```bash
npm run check
npm run test
npm run build
npm run start:bridge
npm run start:bot
```

Start Codex in full-access mode only:

```bash
codex --dangerously-bypass-approvals-and-sandbox
```

The bridge also resumes Codex with `codex exec resume --dangerously-bypass-approvals-and-sandbox --json`, so resumed turns stay in the same mode.

## What Gets Sent To Discord

- Normal Codex final answers are sent as `response_complete`
- Plan-mode questions are sent as `ai_question`
- After you reply in the Discord thread, the bridge resumes the Codex session and the next final answer is sent again
- Commentary updates are not forwarded to Discord

## Log-Based Verification

Use logs as the source of truth for bridge behavior:

- `bridge_hook`: Claude hook payloads
- `codex_watcher`: Codex session-file events detected from `~/.codex/sessions`
- `bridge_input`: Discord replies accepted by the bridge
- `codex_resume`: `codex exec resume` lifecycle and JSONL stdout events
- `bot_event`: bridge-to-bot delivery and Discord send attempts
- `discord_thread`: thread create/reuse/archive
- `discord_input`: Discord user replies forwarded to `/input`

You can also inspect current watcher state:

```bash
curl http://127.0.0.1:3000/sessions
```

The response includes active sessions plus watcher diagnostics such as the sessions directory, last scan time, tracked file count, and last processed file/offset.

## Plan-Mode Verification

1. Start `bridge`, `bot`, and Codex as above.
2. Give Codex a prompt that forces a question first, for example:

```text
먼저 질문 1개만 하고 내 답을 기다려라.
```

3. Confirm an `ai_question` event appears in `codex_watcher` and `bot_event` logs.
4. Reply in the Discord thread.
5. Confirm `discord_input`, `bridge_input`, and `codex_resume` logs show the reply being forwarded and resume starting.
6. Confirm the follow-up final answer appears in `codex_watcher` and is sent by `bot_event`.

Discord delivery itself should be checked manually in the thread. The implementation-level success criterion is the log path above.
