import { spawn } from "node:child_process";
import process from "node:process";

import type { BridgeConfig } from "../shared/config.js";
import { buildBridgeEvent } from "./eventParser.js";
import { notifyBot } from "./inputRouter.js";
import type { SessionManager } from "./sessionManager.js";

interface StartCodexResumeParams {
	config: BridgeConfig;
	sessionManager: SessionManager;
	sessionId: string;
	prompt: string;
}

interface StartCodexResumeResult {
	ok: boolean;
	started?: boolean;
	busy?: boolean;
	reason?: string;
}

function buildResumeArgs(
	sessionId: string,
	prompt: string,
	cwd?: string,
): string[] {
	const args = ["exec", "resume", "--enable", "codex_hooks"];
	if (cwd) {
		args.push("-C", cwd);
	}

	args.push(sessionId, prompt);
	return args;
}

async function notifyCodexSystemMessage(params: {
	config: BridgeConfig;
	sessionId: string;
	sessionName: string;
	message: string;
}): Promise<void> {
	await notifyBot(
		params.config,
		buildBridgeEvent({
			tool: "codex",
			sessionId: params.sessionId,
			sessionName: params.sessionName,
			event: "response_complete",
			data: {
				message: params.message,
				messageLevel: "system_error",
			},
		}),
	);
}

export async function startCodexResume({
	config,
	sessionManager,
	sessionId,
	prompt,
}: StartCodexResumeParams): Promise<StartCodexResumeResult> {
	const startResult = sessionManager.markCodexResumeStarted(sessionId);
	if (!startResult.ok || !startResult.session) {
		return {
			ok: false,
			busy: startResult.reason?.includes("already processing") ?? false,
			reason: startResult.reason ?? "Unable to start Codex resume.",
		};
	}

	const { session } = startResult;
	const resumeArgs = buildResumeArgs(sessionId, prompt, session.codex?.cwd);
	let stderr = "";

	try {
		const child = spawn("codex", resumeArgs, {
			cwd: session.codex?.cwd,
			env: process.env,
			stdio: ["ignore", "ignore", "pipe"],
		});

		child.stderr.on("data", (chunk: Buffer | string) => {
			stderr += chunk.toString();
			if (stderr.length > 4000) {
				stderr = stderr.slice(-4000);
			}
		});

		child.on("error", (error) => {
			sessionManager.markCodexResumeFinished(sessionId);
			void notifyCodexSystemMessage({
				config,
				sessionId,
				sessionName: session.name,
				message: `Codex resume 실행을 시작하지 못했습니다.\n\`\`\`\n${error.message}\n\`\`\``,
			});
		});

		child.on("close", (code, signal) => {
			if (code === 0) {
				return;
			}

			sessionManager.markCodexResumeFinished(sessionId);
			const failureReason =
				stderr.trim() ||
				`codex exec resume exited with code ${code ?? "unknown"}${
					signal ? ` (signal: ${signal})` : ""
				}.`;
			void notifyCodexSystemMessage({
				config,
				sessionId,
				sessionName: session.name,
				message: `Codex resume 실행이 비정상 종료되었습니다.\n\`\`\`\n${failureReason}\n\`\`\``,
			});
		});

		return {
			ok: true,
			started: true,
		};
	} catch (error) {
		sessionManager.markCodexResumeFinished(sessionId);
		const message =
			error instanceof Error ? error.message : "Unknown Codex resume error.";
		return {
			ok: false,
			reason: message,
		};
	}
}
