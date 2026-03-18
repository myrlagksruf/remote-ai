import assert from "node:assert/strict";
import test from "node:test";

import { buildPlanPrompt } from "./commandHandler.js";

test("buildPlanPrompt wraps the user prompt for planning mode", () => {
	const prompt = buildPlanPrompt("좋은 방법이군");

	assert.match(prompt, /planning task/i);
	assert.match(prompt, /Do not implement changes yet\./);
	assert.match(prompt, /좋은 방법이군/);
});
