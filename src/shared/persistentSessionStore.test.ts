import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { PersistentSessionStore } from "./persistentSessionStore.js";

test("persists bindings as editable JSON", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "remote-ai-store-"));
	const filePath = path.join(dir, "thread-bindings.json");
	const store = new PersistentSessionStore(filePath);

	await store.save({
		version: 1,
		bindings: [
			{
				sessionId: "session-1",
				threadId: "thread-1",
				tool: "codex",
				sessionName: "remote-ai-test",
				status: "active",
				lastActivity: "2026-03-18T00:00:00.000Z",
				archived: false,
				updatedAt: "2026-03-18T00:00:00.000Z",
			},
		],
	});

	const raw = await readFile(filePath, "utf8");
	const parsed = JSON.parse(raw) as { bindings: Array<{ sessionId: string }> };
	assert.equal(parsed.bindings[0]?.sessionId, "session-1");
});

test("skips malformed bindings while loading", async () => {
	const dir = await mkdtemp(path.join(tmpdir(), "remote-ai-store-"));
	const filePath = path.join(dir, "thread-bindings.json");
	await writeFile(
		filePath,
		JSON.stringify({
			version: 1,
			bindings: [
				{
					sessionId: "session-1",
					threadId: "thread-1",
					tool: "codex",
					sessionName: "remote-ai-test",
					status: "active",
					lastActivity: "2026-03-18T00:00:00.000Z",
					archived: false,
					updatedAt: "2026-03-18T00:00:00.000Z",
				},
				{
					sessionId: "broken",
					tool: "codex",
				},
			],
		}),
		"utf8",
	);

	const store = new PersistentSessionStore(filePath);
	const payload = await store.load();

	assert.equal(payload.bindings.length, 1);
	assert.equal(payload.bindings[0]?.sessionId, "session-1");
});
