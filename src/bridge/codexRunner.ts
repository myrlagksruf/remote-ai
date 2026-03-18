import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
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

interface SpawnCommand {
	command: string;
	args: string[];
	resolvedCodexPath: string;
	windowsVerbatimArguments?: boolean;
}

function buildResumeArgs(
	sessionId: string,
	prompt: string,
): string[] {
	return [
		"exec",
		"resume",
		"--dangerously-bypass-approvals-and-sandbox",
		"--json",
		sessionId,
		prompt,
	];
}

function quoteWindowsArgument(argument: string): string {
	if (!argument.length) {
		return '""';
	}

	if (!/[\s"]/u.test(argument)) {
		return argument;
	}

	return `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}

function findFirstExistingPath(candidates: Array<string | undefined>): string | null {
	for (const candidate of candidates) {
		if (candidate && existsSync(candidate)) {
			return candidate;
		}
	}

	return null;
}

function resolveCodexExecutable(): string {
	const configured = process.env.CODEX_BIN?.trim();
	if (configured) {
		return configured;
	}

	if (process.platform !== "win32") {
		return "codex";
	}

	const localAppData = process.env.LOCALAPPDATA?.trim();
	const appData = process.env.APPDATA?.trim();

	return (
		findFirstExistingPath([
			localAppData
				? path.join(localAppData, "OpenAI", "Codex", "bin", "codex.cmd")
				: undefined,
			appData ? path.join(appData, "npm", "codex.cmd") : undefined,
			appData ? path.join(appData, "npm", "codex") : undefined,
			path.join(
				homedir(),
				"AppData",
				"Roaming",
				"npm",
				"codex.cmd",
			),
		]) ?? "codex"
	);
}

function buildSpawnCommand(resumeArgs: string[]): SpawnCommand {
	const resolvedCodexPath = resolveCodexExecutable();
	if (
		process.platform === "win32" &&
		/\.(cmd|bat)$/iu.test(resolvedCodexPath)
	) {
		const command = process.env.ComSpec?.trim() || "cmd.exe";
		const commandLine = [resolvedCodexPath, ...resumeArgs]
			.map(quoteWindowsArgument)
			.join(" ");
		return {
			command,
			args: ["/d", "/s", "/c", `"${commandLine}"`],
			resolvedCodexPath,
			windowsVerbatimArguments: true,
		};
	}

	return {
		command: resolvedCodexPath,
		args: resumeArgs,
		resolvedCodexPath,
		windowsVerbatimArguments: false,
	};
}

function logCodexResumeEvent(sessionId: string, line: string): void {
	try {
		const parsed = JSON.parse(line) as Record<string, unknown>;
		const eventType =
			typeof parsed.type === "string"
				? parsed.type
				: typeof parsed.event === "string"
					? parsed.event
					: "unknown";
		const message =
			typeof parsed.message === "string"
				? parsed.message
				: typeof parsed.text === "string"
					? parsed.text
					: undefined;

		console.log(
			JSON.stringify({
				scope: "codex_resume",
				sessionId,
				event: eventType,
				messagePreview: message?.slice(0, 160),
			}),
		);
	} catch {
		console.log(
			JSON.stringify({
				scope: "codex_resume",
				sessionId,
				event: "stdout",
				messagePreview: line.slice(0, 160),
			}),
		);
	}
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
	const resumeArgs = buildResumeArgs(sessionId, prompt);
	const spawnCommand = buildSpawnCommand(resumeArgs);
	let stderr = "";
	let stdoutRemainder = "";

	try {
		const child = spawn(spawnCommand.command, spawnCommand.args, {
			cwd: session.codex?.cwd,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
			windowsVerbatimArguments: spawnCommand.windowsVerbatimArguments,
		});

		console.log(
			JSON.stringify({
				scope: "codex_resume",
				sessionId,
				cwd: session.codex?.cwd,
				command: spawnCommand.command,
				args: spawnCommand.args,
				resolvedCodexPath: spawnCommand.resolvedCodexPath,
				message: "Starting Codex resume.",
			}),
		);

		child.stdout.on("data", (chunk: Buffer | string) => {
			stdoutRemainder += chunk.toString();
			const lines = stdoutRemainder.split(/\r?\n/);
			stdoutRemainder = lines.pop() ?? "";
			for (const line of lines) {
				const trimmed = line.trim();
				if (trimmed) {
					logCodexResumeEvent(sessionId, trimmed);
				}
			}
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
			if (stdoutRemainder.trim()) {
				logCodexResumeEvent(sessionId, stdoutRemainder.trim());
			}

			if (code === 0) {
				console.log(
					JSON.stringify({
						scope: "codex_resume",
						sessionId,
						exitCode: code,
						signal,
						message: "Codex resume completed.",
					}),
				);
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
