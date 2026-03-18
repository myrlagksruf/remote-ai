import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { BridgeConfig } from "../shared/config.js";
import { CodexSessionWatcher } from "./codexSessionWatcher.js";
import { SessionManager } from "./sessionManager.js";

type TestFileState = {
	offset: number;
	remainder: string;
	sessionId?: string;
};

type WatcherTestApi = {
	processLine(
		line: string,
		fileState: TestFileState,
		notify: boolean,
	): Promise<void>;
};

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

	const projectRoot = path.resolve(process.cwd());
	const codexHome = path.join(homedir(), ".codex");
	const cwd = projectRoot;
	const config: BridgeConfig = {
		bridgeHost: "127.0.0.1",
		bridgePort: 3000,
		bridgeSecret: "secret",
		bridgeBaseUrl: "http://127.0.0.1:3000",
		botBaseUrl: "http://127.0.0.1:3001",
		codexHome,
		codexSessionsDir: path.join(codexHome, "sessions"),
		codexWatchIntervalMs: 1000,
		projectDataDir: path.join(projectRoot, "data"),
		threadBindingsFile: path.join(projectRoot, "data", "thread-bindings.json"),
	};

	const watcher = new CodexSessionWatcher(config, new SessionManager(), {
		info() {},
		warn() {},
		error() {},
		debug() {},
		fatal() {},
		trace() {},
		child() {
			return this;
		},
	} as never);

	return {
		cwd,
		events,
		fileState: {
			offset: 0,
			remainder: "",
		} satisfies TestFileState,
		snapshotCleanup() {
			globalThis.fetch = originalFetch;
		},
		watcher,
	};
}

async function processLine(
	watcher: CodexSessionWatcher,
	line: string,
	fileState: TestFileState,
	notify: boolean,
): Promise<void> {
	await (watcher as unknown as WatcherTestApi).processLine(
		line,
		fileState,
		notify,
	);
}

async function primeFile(
	watcher: CodexSessionWatcher,
	filePath: string,
): Promise<void> {
	await (
		watcher as unknown as {
			primeFile(path: string): Promise<void>;
		}
	).primeFile(filePath);
}

test("emits session_start from session_meta", async () => {
	const harness = createWatcherHarness();

	try {
		await processLine(
			harness.watcher,
			JSON.stringify({
				type: "session_meta",
				payload: {
					id: "session-12345678",
					cwd: harness.cwd,
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
		await processLine(
			harness.watcher,
			JSON.stringify({
				type: "session_meta",
				payload: {
					id: "session-ask-1234",
					cwd: harness.cwd,
				},
			}),
			harness.fileState,
			false,
		);

		await processLine(
			harness.watcher,
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
		assert.equal(
			(harness.events[0] as { event: string }).event,
			"session_start",
		);
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
		await processLine(
			harness.watcher,
			JSON.stringify({
				type: "session_meta",
				payload: {
					id: "session-final-1234",
					cwd: harness.cwd,
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

		await processLine(harness.watcher, finalLine, harness.fileState, true);
		await processLine(harness.watcher, finalLine, harness.fileState, true);

		assert.equal(harness.events.length, 2);
		assert.equal(
			(harness.events[0] as { event: string }).event,
			"session_start",
		);
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

test("primeFile reads long session_meta lines without truncating session id", async () => {
	const harness = createWatcherHarness();
	const tempDir = await mkdtemp(path.join(tmpdir(), "remote-ai-watcher-"));
	const filePath = path.join(tempDir, "session.jsonl");
	const longInstructions = "x".repeat(8000);

	try {
		await writeFile(
			filePath,
			`${JSON.stringify({
				timestamp: "2026-03-18T00:00:00.000Z",
				type: "session_meta",
				payload: {
					id: "session-long-1234",
					cwd: harness.cwd,
					base_instructions: { text: longInstructions },
				},
			})}\n`,
			"utf8",
		);

		await primeFile(harness.watcher, filePath);

		assert.equal(harness.events.length, 0);
		const fileStates = (
			harness.watcher as unknown as {
				fileStates: Map<string, TestFileState>;
			}
		).fileStates;
		assert.equal(fileStates.get(filePath)?.sessionId, "session-long-1234");
	} finally {
		harness.snapshotCleanup();
	}
});
