import { randomUUID } from "node:crypto";

import type {
	PendingRequest,
	PendingRequestType,
	PermissionMode,
	SerializableSession,
	Session,
	SessionStatus,
	ToolName,
	UserInputPayload,
} from "../shared/types.js";

interface CreateSessionParams {
	sessionId: string;
	tool: ToolName;
	name: string;
	permissionMode?: PermissionMode;
}

interface ResolveInputResult {
	ok: boolean;
	reason?: string;
	pendingRequest?: PendingRequest;
}

interface CodexResumeStartResult {
	ok: boolean;
	reason?: string;
	session?: Session;
}

export class SessionManager {
	private readonly sessions = new Map<string, Session>();

	getSession(sessionId: string): Session | undefined {
		return this.sessions.get(sessionId);
	}

	getOrCreateSession(params: CreateSessionParams): {
		session: Session;
		isNew: boolean;
	} {
		const existing = this.sessions.get(params.sessionId);
		if (existing) {
			existing.name = params.name || existing.name;
			existing.lastActivity = new Date().toISOString();
			return { session: existing, isNew: false };
		}

		const now = new Date().toISOString();
		const session: Session = {
			sessionId: params.sessionId,
			tool: params.tool,
			name: params.name,
			discordThreadId: null,
			status: "active",
			permissionMode: params.permissionMode ?? "default",
			pendingRequests: new Map<string, PendingRequest>(),
			createdAt: now,
			lastActivity: now,
			codex:
				params.tool === "codex"
					? {
							hasInFlightResume: false,
						}
					: undefined,
		};

		this.sessions.set(params.sessionId, session);
		return { session, isNew: true };
	}

	setStatus(sessionId: string, status: SessionStatus): void {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return;
		}

		session.status = status;
		session.lastActivity = new Date().toISOString();
	}

	setCodexCwd(sessionId: string, cwd: string): void {
		const session = this.sessions.get(sessionId);
		if (!session || session.tool !== "codex") {
			return;
		}

		session.codex ??= { hasInFlightResume: false };
		session.codex.cwd = cwd;
		session.lastActivity = new Date().toISOString();
	}

	markCodexResumeStarted(sessionId: string): CodexResumeStartResult {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return { ok: false, reason: `Unknown session: ${sessionId}` };
		}

		if (session.tool !== "codex") {
			return {
				ok: false,
				reason: `Session ${sessionId} does not support Codex resume execution.`,
			};
		}

		session.codex ??= { hasInFlightResume: false };
		if (session.codex.hasInFlightResume) {
			return {
				ok: false,
				reason: `Codex session ${sessionId} is already processing another resume request.`,
			};
		}

		const now = new Date().toISOString();
		session.codex.hasInFlightResume = true;
		session.codex.lastResumeStartedAt = now;
		session.lastActivity = now;
		session.status = "active";

		return { ok: true, session };
	}

	markCodexResumeFinished(sessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (!session || session.tool !== "codex" || !session.codex) {
			return;
		}

		session.codex.hasInFlightResume = false;
		session.lastActivity = new Date().toISOString();
	}

	registerPendingRequest(
		sessionId: string,
		type: PendingRequestType,
	): PendingRequest {
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new Error(
				`Cannot register request for unknown session: ${sessionId}`,
			);
		}

		const createdAt = new Date().toISOString();
		const pendingRequest: PendingRequest = {
			requestId: randomUUID(),
			type,
			createdAt,
			status: "pending",
		};

		session.pendingRequests.set(pendingRequest.requestId, pendingRequest);
		session.status =
			type === "permission_request" ? "waiting_permission" : "waiting_input";
		session.lastActivity = createdAt;

		return pendingRequest;
	}

	resolveInput(payload: UserInputPayload): ResolveInputResult {
		const session = this.sessions.get(payload.sessionId);
		if (!session) {
			return { ok: false, reason: `Unknown session: ${payload.sessionId}` };
		}

		session.lastActivity = new Date().toISOString();

		if (payload.type === "direct_prompt") {
			session.status = "active";
			return { ok: true };
		}

		if (!payload.requestId) {
			return {
				ok: false,
				reason:
					"requestId is required for text_response and permission_response.",
			};
		}

		const pendingRequest = session.pendingRequests.get(payload.requestId);
		if (!pendingRequest) {
			return {
				ok: false,
				reason: `Unknown requestId for session ${payload.sessionId}: ${payload.requestId}`,
			};
		}

		pendingRequest.status = "resolved";
		pendingRequest.resolvedAt = new Date().toISOString();
		if (payload.type === "text_response") {
			pendingRequest.content = payload.content ?? "";
		}
		if (payload.type === "permission_response") {
			pendingRequest.allowed = Boolean(payload.allowed);
		}

		session.status = "active";
		return { ok: true, pendingRequest };
	}

	endSession(sessionId: string): Session | undefined {
		const session = this.sessions.get(sessionId);
		if (!session) {
			return undefined;
		}

		session.status = "completed";
		session.lastActivity = new Date().toISOString();
		return session;
	}

	listSessions(): SerializableSession[] {
		return Array.from(this.sessions.values()).map((session) => ({
			...session,
			pendingRequests: Array.from(session.pendingRequests.values()),
		}));
	}
}
