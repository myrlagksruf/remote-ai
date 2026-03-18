import type { Dirent } from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { FastifyBaseLogger } from "fastify";

import type { BridgeConfig } from "../shared/config.js";
import type { CodexWatcherDiagnostics } from "../shared/types.js";
import { buildBridgeEvent } from "./eventParser.js";
import { notifyBot } from "./inputRouter.js";
import type { SessionManager } from "./sessionManager.js";

interface FileState {
	offset: number;
	remainder: string;
	sessionId?: string;
}

interface SessionSnapshot {
	sessionId?: string;
	sessionName?: string;
	cwd?: string;
	mode: "default" | "plan";
	lastQuestionKey?: string;
	lastResponseKey?: string;
}

interface SessionMetaPayload {
	id?: unknown;
	cwd?: unknown;
}

interface CodexQuestion {
	question?: string;
	header?: string;
	options?: Array<{
		label?: string;
		description?: string;
	}>;
}

interface RequestUserInputArgs {
	questions?: CodexQuestion[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function buildSessionName(sessionId: string, cwd?: string): string {
	const folderName = cwd ? path.basename(cwd) : undefined;
	if (folderName) {
		return `${folderName}-${sessionId.slice(0, 8)}`;
	}

	return `codex-${sessionId.slice(0, 8)}`;
}

function extractOutputText(content: unknown): string {
	if (!Array.isArray(content)) {
		return "";
	}

	return content
		.map((item) => {
			if (!isRecord(item)) {
				return "";
			}

			return readString(item.text) ?? "";
		})
		.filter(Boolean)
		.join("\n")
		.trim();
}

function parseRequestUserInputMessage(argumentsText: string): string | null {
	try {
		const parsed = JSON.parse(argumentsText) as RequestUserInputArgs;
		if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) {
			return null;
		}

		return parsed.questions
			.map((question, index) => {
				const prompt =
					typeof question.question === "string" ? question.question.trim() : "";
				if (!prompt) {
					return null;
				}

				const header =
					typeof question.header === "string" ? question.header.trim() : "";
				const options = Array.isArray(question.options)
					? question.options
							.map((option) => {
								if (!option || typeof option !== "object") {
									return null;
								}

								const label =
									typeof option.label === "string" ? option.label.trim() : "";
								const description =
									typeof option.description === "string"
										? option.description.trim()
										: "";
								if (!label) {
									return null;
								}

								return description
									? `- ${label}: ${description}`
									: `- ${label}`;
							})
							.filter((value): value is string => value !== null)
					: [];

				return [
					header ? `${index + 1}. ${header}` : `${index + 1}. 질문`,
					prompt,
					...options,
				]
					.filter(Boolean)
					.join("\n");
			})
			.filter((value): value is string => value !== null)
			.join("\n\n")
			.trim();
	} catch {
		return null;
	}
}

function isQuestionLike(text: string): boolean {
	if (!text.trim() || text.includes("<proposed_plan>")) {
		return false;
	}

	return (
		/[?？]\s*$/.test(text) ||
		/\b(what|which|when|where|why|how|can you|could you|do you|should i)\b/i.test(
			text,
		) ||
		/(무엇|어떤|어느|할까요|인가요|필요한가요|선택해 주세요)\s*[?？]?$/.test(
			text,
		)
	);
}

async function collectJsonlFiles(rootDir: string): Promise<string[]> {
	const results: string[] = [];
	let entries: Dirent[];
	try {
		entries = await readdir(rootDir, { withFileTypes: true });
	} catch {
		return results;
	}

	for (const entry of entries) {
		const entryPath = path.join(rootDir, entry.name);
		if (entry.isDirectory()) {
			results.push(...(await collectJsonlFiles(entryPath)));
			continue;
		}

		if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			results.push(entryPath);
		}
	}

	return results;
}

async function readFirstLine(filePath: string): Promise<string | null> {
	const handle = await open(filePath, "r");
	try {
		const { size } = await handle.stat();
		if (size === 0) {
			return null;
		}

		const chunkSize = 4096;
		let offset = 0;
		let text = "";

		while (offset < size) {
			const bytesToRead = Math.min(chunkSize, size - offset);
			const buffer = Buffer.alloc(bytesToRead);
			const { bytesRead } = await handle.read(buffer, 0, bytesToRead, offset);
			if (bytesRead <= 0) {
				break;
			}

			offset += bytesRead;
			text += buffer.subarray(0, bytesRead).toString("utf8");
			const newlineIndex = text.indexOf("\n");
			if (newlineIndex >= 0) {
				return text.slice(0, newlineIndex).trim() || null;
			}
		}

		return text.trim() || null;
	} finally {
		await handle.close();
	}
}

export class CodexSessionWatcher {
	private readonly fileStates = new Map<string, FileState>();
	private readonly sessionSnapshots = new Map<string, SessionSnapshot>();
	private readonly diagnostics: CodexWatcherDiagnostics;
	private scanTimer?: NodeJS.Timeout;
	private initialized = false;

	constructor(
		private readonly config: BridgeConfig,
		private readonly sessionManager: SessionManager,
		private readonly logger: FastifyBaseLogger,
	) {
		this.diagnostics = {
			sessionsDir: config.codexSessionsDir,
			lastScanAt: null,
			trackedFiles: 0,
			lastProcessedFile: null,
			lastProcessedOffset: 0,
		};
	}

	async start(): Promise<void> {
		await this.scan();
		this.scanTimer = setInterval(() => {
			void this.scan();
		}, this.config.codexWatchIntervalMs);
	}

	stop(): void {
		if (this.scanTimer) {
			clearInterval(this.scanTimer);
			this.scanTimer = undefined;
		}
	}

	getDiagnostics(): CodexWatcherDiagnostics {
		return { ...this.diagnostics };
	}

	private getSessionSnapshot(sessionId: string): SessionSnapshot {
		const existing = this.sessionSnapshots.get(sessionId);
		if (existing) {
			return existing;
		}

		const created: SessionSnapshot = { mode: "default" };
		this.sessionSnapshots.set(sessionId, created);
		return created;
	}

	private async scan(): Promise<void> {
		const files = await collectJsonlFiles(this.config.codexSessionsDir);
		this.diagnostics.lastScanAt = new Date().toISOString();
		this.diagnostics.trackedFiles = files.length;

		for (const filePath of files) {
			await this.scanFile(filePath);
		}

		this.initialized = true;
	}

	private async scanFile(filePath: string): Promise<void> {
		const existing = this.fileStates.get(filePath);
		if (!existing) {
			if (!this.initialized) {
				await this.primeFile(filePath);
				return;
			}

			this.fileStates.set(filePath, {
				offset: 0,
				remainder: "",
			});
		}

		const state = this.fileStates.get(filePath);
		if (!state) {
			return;
		}

		const fileStats = await stat(filePath);
		if (fileStats.size < state.offset) {
			state.offset = 0;
			state.remainder = "";
		}

		if (fileStats.size === state.offset) {
			return;
		}

		const bytesToRead = fileStats.size - state.offset;
		const handle = await open(filePath, "r");
		try {
			const buffer = Buffer.alloc(bytesToRead);
			const { bytesRead } = await handle.read(
				buffer,
				0,
				bytesToRead,
				state.offset,
			);
			state.offset += bytesRead;
			this.diagnostics.lastProcessedFile = filePath;
			this.diagnostics.lastProcessedOffset = state.offset;

			const combined =
				state.remainder + buffer.subarray(0, bytesRead).toString("utf8");
			const lines = combined.split(/\r?\n/);
			state.remainder = lines.pop() ?? "";

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) {
					continue;
				}

				await this.processLine(trimmed, state, true);
			}
		} finally {
			await handle.close();
		}
	}

	private async primeFile(filePath: string): Promise<void> {
		const firstLine = await readFirstLine(filePath);
		const fileStats = await stat(filePath);
		const state: FileState = {
			offset: fileStats.size,
			remainder: "",
		};
		this.fileStates.set(filePath, state);
		if (!firstLine) {
			return;
		}

		await this.processLine(firstLine, state, false);
	}

	private async processLine(
		line: string,
		fileState: FileState,
		notify: boolean,
	): Promise<void> {
		let record: unknown;
		try {
			record = JSON.parse(line);
		} catch {
			this.logger.warn(
				{ scope: "codex_watcher", linePreview: line.slice(0, 160) },
				"Failed to parse Codex session line.",
			);
			return;
		}

		if (!isRecord(record)) {
			return;
		}

		const type = readString(record.type);
		if (!type) {
			return;
		}

		if (type === "session_meta") {
			await this.handleSessionMeta(record.payload, fileState, notify);
			return;
		}

		const sessionId = fileState.sessionId;
		if (!sessionId) {
			return;
		}

		const snapshot = this.getSessionSnapshot(sessionId);
		if (type === "turn_context") {
			this.handleTurnContext(record.payload, snapshot);
			return;
		}

		if (type !== "response_item") {
			return;
		}

		const payload = isRecord(record.payload) ? record.payload : undefined;
		if (!payload) {
			return;
		}

		await this.handleResponseItem(payload, sessionId, snapshot, notify);
	}

	private async handleSessionMeta(
		payload: unknown,
		fileState: FileState,
		notify: boolean,
	): Promise<void> {
		if (!isRecord(payload)) {
			return;
		}

		const sessionPayload = payload as SessionMetaPayload;
		const sessionId = readString(sessionPayload.id);
		if (!sessionId) {
			return;
		}

		const cwd = readString(sessionPayload.cwd);
		fileState.sessionId = sessionId;
		const snapshot = this.getSessionSnapshot(sessionId);
		snapshot.sessionId = sessionId;
		snapshot.cwd = cwd;
		snapshot.sessionName = buildSessionName(sessionId, cwd);

		if (notify) {
			await this.emitBotEvent({
				sessionId,
				sessionName: snapshot.sessionName,
				cwd,
				event: "session_start",
			});
		}
	}

	private handleTurnContext(payload: unknown, snapshot: SessionSnapshot): void {
		if (!isRecord(payload)) {
			return;
		}

		const collaborationMode = isRecord(payload.collaboration_mode)
			? payload.collaboration_mode
			: undefined;
		const mode = readString(collaborationMode?.mode);
		snapshot.mode = mode === "plan" ? "plan" : "default";
	}

	private async handleResponseItem(
		payload: Record<string, unknown>,
		sessionId: string,
		snapshot: SessionSnapshot,
		notify: boolean,
	): Promise<void> {
		const payloadType = readString(payload.type);
		if (payloadType === "function_call") {
			const toolName = readString(payload.name);
			if (toolName !== "request_user_input") {
				return;
			}

			const callId = readString(payload.call_id);
			if (!callId || snapshot.lastQuestionKey === callId) {
				return;
			}

			const message = parseRequestUserInputMessage(
				readString(payload.arguments) ?? "",
			);
			if (!message) {
				return;
			}

			snapshot.lastQuestionKey = callId;
			if (!notify) {
				return;
			}

			await this.emitBotEvent({
				sessionId,
				sessionName:
					snapshot.sessionName ?? buildSessionName(sessionId, snapshot.cwd),
				cwd: snapshot.cwd,
				event: "ai_question",
				message,
			});
			return;
		}

		if (payloadType !== "message" || readString(payload.role) !== "assistant") {
			return;
		}

		const phase = readString(payload.phase);
		if (phase !== "final_answer") {
			return;
		}

		const text = extractOutputText(payload.content).trim();
		if (!text) {
			return;
		}

		const dedupeKey = `${phase}:${text}`;
		if (snapshot.lastResponseKey === dedupeKey) {
			return;
		}

		if (
			snapshot.mode === "plan" &&
			isQuestionLike(text) &&
			snapshot.lastQuestionKey !== dedupeKey
		) {
			snapshot.lastQuestionKey = dedupeKey;
			if (!notify) {
				return;
			}

			await this.emitBotEvent({
				sessionId,
				sessionName:
					snapshot.sessionName ?? buildSessionName(sessionId, snapshot.cwd),
				cwd: snapshot.cwd,
				event: "ai_question",
				message: text,
			});
			return;
		}

		snapshot.lastResponseKey = dedupeKey;
		if (!notify) {
			return;
		}

		await this.emitBotEvent({
			sessionId,
			sessionName:
				snapshot.sessionName ?? buildSessionName(sessionId, snapshot.cwd),
			cwd: snapshot.cwd,
			event: "response_complete",
			message: text,
		});
	}

	private async emitBotEvent(params: {
		sessionId: string;
		sessionName: string;
		cwd?: string;
		event: "session_start" | "ai_question" | "response_complete";
		message?: string;
	}): Promise<void> {
		const { session, isNew } = this.sessionManager.getOrCreateSession({
			sessionId: params.sessionId,
			tool: "codex",
			name: params.sessionName,
		});
		if (params.cwd) {
			this.sessionManager.setCodexCwd(params.sessionId, params.cwd);
		}

		if (isNew && params.event !== "session_start") {
			await notifyBot(
				this.config,
				buildBridgeEvent({
					tool: "codex",
					sessionId: session.sessionId,
					sessionName: session.name,
					event: "session_start",
				}),
			);
		}

		if (params.event === "response_complete") {
			this.sessionManager.markCodexResumeFinished(params.sessionId);
		}

		const event = buildBridgeEvent({
			tool: "codex",
			sessionId: session.sessionId,
			sessionName: session.name,
			event: params.event,
			data: params.message
				? {
						message: params.message,
					}
				: {},
		});

		await notifyBot(this.config, event);
		this.logger.info(
			{
				scope: "codex_watcher",
				event: event.event,
				sessionId: event.sessionId,
				sessionName: event.sessionName,
				messagePreview: event.data.message?.slice(0, 160),
			},
			"Processed Codex session event.",
		);
	}
}

export { extractOutputText, isQuestionLike, parseRequestUserInputMessage };
