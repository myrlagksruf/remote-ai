import assert from "node:assert/strict";
import test from "node:test";

import type { BridgeConfig } from "../shared/config.js";
import { SessionManager } from "./sessionManager.js";
import { CodexSessionWatcher } from "./codexSessionWatcher.js";

function createWatcherHarness() {
	const events: unknown[] = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async (_input, init) => {
		if (init?.body && typeof init.body === "string") {
			events.push(JSON.parse(init.body));
		}

		return new Response(JSON.stringify({ ok: true }), {
			status: 202,
			headers: { "content-type": "application/json" },
		});
	}) as typeof fetch;

	const config: BridgeConfig = {
		bridgeHost: "127.0.0.1",
		bridgePort: 3000,
		bridgeSecret: "secret",
		bridgeBaseUrl: "http://127.0.0.1:3000",
		botBaseUrl: "http://127.0.0.1:3001",
		codexHome: "C:\\Users\\myrla\\.codex",
		codexSessionsDir: "C:\\Users\\myrla\\.codex\\sessions",
		codexWatchIntervalMs: 1000,
	};

	const watcher = new CodexSessionWatcher(
		config,
		new SessionManager(),
		{
			info() {},
			warn() {},
			error() {},
			debug() {},
			fatal() {},
			trace() {},
			child() {
				return this;
			},
		} as never,
	);

	return {
		events,
		fileState: {
			offset: 0,
			remainder: "",
		},
		snapshotCleanup() {
			globalThis.fetch = originalFetch;
		},
		watcher,
	};
}

test("emits session_start from session_meta", async () => {
	const harness = createWatcherHarness();

	try {
		await (harness.watcher as any).processLine(
			JSON.stringify({
				type: "session_meta",
				payload: {
					id: "session-12345678",
					cwd: "C:\\Users\\myrla\\remote-ai",
				},
			}),
			harness.fileState,
			true,
		);

		assert.equal(harness.events.length, 1);
		assert.deepEqual(
			(harness.events[0] as { event: string; sessionId: string }).event,
			"session_start",
		);
		assert.deepEqual(
			(harness.events[0] as { event: string; sessionId: string }).sessionId,
			"session-12345678",
		);
	} finally {
		harness.snapshotCleanup();
	}
});

test("emits ai_question for request_user_input tool calls", async () => {
	const harness = createWatcherHarness();

	try {
		await (harness.watcher as any).processLine(
			JSON.stringify({
				type: "session_meta",
				payload: {
					id: "session-ask-1234",
					cwd: "C:\\Users\\myrla\\remote-ai",
				},
			}),
			harness.fileState,
			false,
		);

		await (harness.watcher as any).processLine(
			JSON.stringify({
				type: "response_item",
				payload: {
					type: "function_call",
					name: "request_user_input",
					call_id: "call-1",
					arguments: JSON.stringify({
						questions: [
							{
								header: "질문",
								question: "어떤 모드로 진행할까요?",
								options: [
									{
										label: "빠르게",
										description: "질문을 줄이고 바로 진행합니다.",
									},
								],
							},
						],
					}),
				},
			}),
			harness.fileState,
			true,
		);

		assert.equal(harness.events.length, 2);
		assert.equal((harness.events[0] as { event: string }).event, "session_start");
		const event = harness.events[1] as {
			event: string;
			data: { message?: string };
		};
		assert.equal(event.event, "ai_question");
		assert.match(event.data.message ?? "", /어떤 모드로 진행할까요/);
		assert.match(event.data.message ?? "", /빠르게/);
	} finally {
		harness.snapshotCleanup();
	}
});

test("emits response_complete once for duplicated final answers", async () => {
	const harness = createWatcherHarness();

	try {
		await (harness.watcher as any).processLine(
			JSON.stringify({
				type: "session_meta",
				payload: {
					id: "session-final-1234",
					cwd: "C:\\Users\\myrla\\remote-ai",
				},
			}),
			harness.fileState,
			false,
		);

		const finalLine = JSON.stringify({
			type: "response_item",
			payload: {
				type: "message",
				role: "assistant",
				phase: "final_answer",
				content: [{ type: "output_text", text: "최종 응답입니다." }],
			},
		});

		await (harness.watcher as any).processLine(
			finalLine,
			harness.fileState,
			true,
		);
		await (harness.watcher as any).processLine(
			finalLine,
			harness.fileState,
			true,
		);

		assert.equal(harness.events.length, 2);
		assert.equal((harness.events[0] as { event: string }).event, "session_start");
		const event = harness.events[1] as {
			event: string;
			data: { message?: string };
		};
		assert.equal(event.event, "response_complete");
		assert.equal(event.data.message, "최종 응답입니다.");
	} finally {
		harness.snapshotCleanup();
	}
});
