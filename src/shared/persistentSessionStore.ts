import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
	PersistedThreadBinding,
	PersistentStorePayload,
	ToolName,
} from "./types.js";

function isToolName(value: unknown): value is ToolName {
	return value === "claude" || value === "codex";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readBoolean(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

function normalizeBinding(
	input: unknown,
): PersistedThreadBinding | null {
	if (!isRecord(input)) {
		return null;
	}

	const sessionId = readString(input.sessionId);
	const threadId = readString(input.threadId);
	const tool = input.tool;
	const sessionName = readString(input.sessionName);
	const status = readString(input.status);
	const lastActivity = readString(input.lastActivity);
	const archived = readBoolean(input.archived);
	const updatedAt = readString(input.updatedAt);

	if (
		!sessionId ||
		!threadId ||
		!isToolName(tool) ||
		!sessionName ||
		!status ||
		!lastActivity ||
		archived === null ||
		!updatedAt
	) {
		return null;
	}

	if (
		status !== "active" &&
		status !== "waiting_input" &&
		status !== "waiting_permission" &&
		status !== "completed" &&
		status !== "inactive"
	) {
		return null;
	}

	return {
		sessionId,
		threadId,
		tool,
		sessionName,
		status,
		lastActivity,
		archived,
		updatedAt,
	};
}

export class PersistentSessionStore {
	constructor(private readonly filePath: string) {}

	getFilePath(): string {
		return this.filePath;
	}

	async load(): Promise<PersistentStorePayload> {
		try {
			const raw = await readFile(this.filePath, "utf8");
			const parsed = JSON.parse(raw) as unknown;
			if (!isRecord(parsed) || parsed.version !== 1) {
				return { version: 1, bindings: [] };
			}

			const bindings = Array.isArray(parsed.bindings)
				? parsed.bindings
						.map((binding) => normalizeBinding(binding))
						.filter((binding): binding is PersistedThreadBinding => binding !== null)
				: [];

			return {
				version: 1,
				bindings,
			};
		} catch (error) {
			const code =
				error && typeof error === "object" && "code" in error
					? String((error as { code?: unknown }).code)
					: "";
			if (code === "ENOENT") {
				return { version: 1, bindings: [] };
			}

			return { version: 1, bindings: [] };
		}
	}

	async save(payload: PersistentStorePayload): Promise<void> {
		await mkdir(path.dirname(this.filePath), { recursive: true });
		await writeFile(
			this.filePath,
			`${JSON.stringify(payload, null, 2)}\n`,
			"utf8",
		);
	}
}
