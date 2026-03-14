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

export type SessionStatus =
	| "active"
	| "waiting_input"
	| "waiting_permission"
	| "completed";

export interface BridgeEventData {
	message?: string;
	toolName?: string;
	toolInput?: Record<string, unknown>;
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
}

export interface SerializableSession extends Omit<Session, "pendingRequests"> {
	pendingRequests: PendingRequest[];
}
