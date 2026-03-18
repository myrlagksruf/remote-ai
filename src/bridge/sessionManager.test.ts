import assert from "node:assert/strict";
import test from "node:test";

import { SessionManager } from "./sessionManager.js";

test("hydrates persisted codex bindings as resumable sessions", () => {
	const sessionManager = new SessionManager();

	sessionManager.hydratePersistedCodexBindings([
		{
			sessionId: "session-1",
			threadId: "thread-1",
			tool: "codex",
			sessionName: "remote-ai-test",
			status: "active",
			lastActivity: "2026-03-18T00:00:00.000Z",
			archived: false,
			updatedAt: "2026-03-18T00:00:01.000Z",
		},
	]);

	const session = sessionManager.getSession("session-1");
	assert.ok(session);
	assert.equal(session?.tool, "codex");
	assert.equal(session?.discordThreadId, "thread-1");
	assert.equal(session?.codex?.hasInFlightResume, false);
});
