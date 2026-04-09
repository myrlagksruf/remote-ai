import assert from "node:assert/strict";
import test from "node:test";

import { buildResumeArgs } from "./codexRunner.js";

test("buildResumeArgs routes prompts through stdin for multiline safety", () => {
	const args = buildResumeArgs("session-123");

	assert.deepEqual(args, [
		"exec",
		"resume",
		"--dangerously-bypass-approvals-and-sandbox",
		"--json",
		"session-123",
		"-",
	]);
});
