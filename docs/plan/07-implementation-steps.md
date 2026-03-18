# 07. 구현 단계별 계획 / 현재 상태

## 요약

이 문서는 원래 구현 계획서였지만, 현재는 **실제 구현 상태 체크 문서**로 보는 편이 맞다.
아래 항목은 현재 코드 기준으로 정리했다.

---

## 완료된 항목

### 기반 구조

- [x] TypeScript 프로젝트 구성
- [x] Fastify 기반 bridge/bot 서버
- [x] Discord bot 기본 수신/전송
- [x] 공통 타입 및 config 로더

### Claude

- [x] `POST /hook/claude` 수신
- [x] Claude 이벤트 정규화
- [x] Discord thread 메시지 전송
- [x] permission 버튼 응답 전달

### Codex

- [x] `~/.codex/sessions/**/*.jsonl` watcher 기반 연동
- [x] `session_meta` 감지
- [x] `turn_context` 감지
- [x] `response_item` 기반 질문/최종응답 감지
- [x] Discord thread 답장 → `codex exec resume`
- [x] 동시 resume 방지
- [x] Windows `codex.cmd` 실행 보정
- [x] 긴 `session_meta` 첫 줄 복구 보정

### Discord UX

- [x] 세션별 thread 생성/재사용
- [x] 긴 응답 파일 첨부
- [x] `/plan` slash command
- [x] 기존 mapped thread에서만 `/plan` 허용

### 재시작 복구

- [x] `data/thread-bindings.json` 저장
- [x] 사람이 편집 가능한 JSON 포맷
- [x] bot의 thread-session 복구
- [x] bridge의 최소 Codex 세션 복구
- [x] 잘못된 레코드 개별 skip

### 테스트

- [x] watcher 핵심 동작 테스트
- [x] persistent store 테스트
- [x] bridge 세션 복구 테스트
- [x] `/plan` 프롬프트 래핑 테스트

---

## 아직 남아 있는 항목

### Codex hooks 관련

- [ ] `POST /hook/codex`
- [ ] `.codex/hooks.json` 기반 공식 hook 연동
- [ ] Codex hooks 문서와 실제 구현의 완전한 일치 정리

### 권한/복구

- [ ] Codex pending request 상태 복구
- [ ] Discord 전체 thread 재스캔 기반 자동 복구
- [ ] Codex tool-level permission relay

### Discord UX 확장

- [ ] `/ai sessions`
- [ ] `/ai mode`
- [ ] Discord에서 Codex 새 세션 시작 UX

### 운영 안정화

- [ ] bot/bridge 장기 실행 시 로그 로테이션 전략
- [ ] 재시작 직후 watcher 상태 진단 명령 정리
- [ ] Discord rate limit / retry 정책 강화

---

## 현재 권장 검증 절차

### Codex 기본 흐름

1. `npm run start:bridge`
2. `npm run start:bot`
3. Codex 세션 실행
4. watcher가 `session_start` 를 Discord에 보냈는지 확인
5. thread에 답장
6. bridge에서 `codex_resume` 시작 로그 확인
7. watcher가 final answer를 다시 Discord로 보냈는지 확인

### 재시작 복구

1. 기존 Codex thread가 하나 있는 상태 확인
2. `data/thread-bindings.json` 에 mapping 저장 확인
3. bridge/bot 재시작
4. bot이 binding을 hydrate 했는지 로그 확인
5. bridge가 기존 Codex 세션을 복구했는지 확인
6. 예전 thread에 답장
7. watcher가 해당 세션 JSONL에서 append를 다시 추적하는지 확인

### `/plan`

1. 기존 Codex mapped thread에서 `/plan prompt:...` 실행
2. bot이 `direct_prompt` 를 bridge로 전달했는지 확인
3. Codex가 질문형 응답을 하면 `ai_question` 으로 오는지 확인
4. 최종 계획 응답이 `response_complete` 로 오는지 확인

---

## 현재 source of truth

문서보다 실제 코드 기준으로 볼 파일:

- `src/bridge/index.ts`
- `src/bridge/codexSessionWatcher.ts`
- `src/bridge/codexRunner.ts`
- `src/bridge/sessionManager.ts`
- `src/bot/index.ts`
- `src/bot/threadManager.ts`
- `src/bot/commandHandler.ts`
- `src/shared/persistentSessionStore.ts`
