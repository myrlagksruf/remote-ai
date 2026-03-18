export type ToolName = "claude" | "codex";

export type BridgeEventType =
	| "session_start"
	| "response_complete"
	| "ai_question"
	| "permission_request"
	| "session_end";

export type UserInputType =
	| "text_response"
	| "permission_response"
	| "direct_prompt";

export type PendingRequestType = "ai_question" | "permission_request";

export type PermissionMode = "default" | "auto" | "manual";

export type BridgeMessageLevel = "assistant" | "system_info" | "system_error";

export type SessionStatus =
	| "active"
	| "waiting_input"
	| "waiting_permission"
	| "completed";

export type PersistedThreadBindingStatus = SessionStatus | "inactive";

export interface BridgeEventData {
	message?: string;
	toolName?: string;
	toolInput?: Record<string, unknown>;
	messageLevel?: BridgeMessageLevel;
}

export interface BridgeEvent {
	tool: ToolName;
	sessionId: string;
	sessionName: string;
	event: BridgeEventType;
	data: BridgeEventData;
	timestamp: string;
	requestId?: string;
}

export interface UserInputPayload {
	sessionId: string;
	requestId?: string | null;
	type: UserInputType;
	content?: string;
	allowed?: boolean;
}

export interface PendingRequest {
	requestId: string;
	type: PendingRequestType;
	createdAt: string;
	resolvedAt?: string;
	status: "pending" | "resolved";
	content?: string;
	allowed?: boolean;
}

export interface CodexSessionState {
	cwd?: string;
	hasInFlightResume: boolean;
	lastResumeStartedAt?: string;
}

export interface CodexWatcherDiagnostics {
	sessionsDir: string;
	lastScanAt: string | null;
	trackedFiles: number;
	lastProcessedFile: string | null;
	lastProcessedOffset: number;
}

export interface Session {
	sessionId: string;
	tool: ToolName;
	name: string;
	discordThreadId: string | null;
	status: SessionStatus;
	permissionMode: PermissionMode;
	pendingRequests: Map<string, PendingRequest>;
	createdAt: string;
	lastActivity: string;
	codex?: CodexSessionState;
}

export interface SerializableSession extends Omit<Session, "pendingRequests"> {
	pendingRequests: PendingRequest[];
}

export interface BridgeInputResponse {
	ok: boolean;
	accepted?: boolean;
	started?: boolean;
	busy?: boolean;
	reason?: string;
	pendingRequest?: PendingRequest;
	note?: string;
}

export interface PersistedThreadBinding {
	sessionId: string;
	threadId: string;
	tool: ToolName;
	sessionName: string;
	status: PersistedThreadBindingStatus;
	lastActivity: string;
	archived: boolean;
	updatedAt: string;
}

export interface PersistentStorePayload {
	version: 1;
	bindings: PersistedThreadBinding[];
}
