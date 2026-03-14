import type {
	BridgeEvent,
	BridgeEventData,
	BridgeEventType,
	PendingRequestType,
	Session,
	ToolName,
} from "../shared/types.js";

interface HookEnvelope {
	tool: ToolName;
	event: string;
	sessionId: string;
	sessionName: string;
	data: BridgeEventData;
	normalizedEvent: BridgeEventType | "after_tool";
	pendingRequestType?: PendingRequestType;
	shouldNotifyBot: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeEventName(value: string): string {
	return value.replace(/[_\s-]/g, "").toLowerCase();
}

function fallbackSessionName(tool: ToolName, sessionId: string): string {
	return `${tool}-${sessionId.slice(0, 8)}`;
}

function toBridgeEventData(data: Record<string, unknown>): BridgeEventData {
	const toolInput = isRecord(data.tool_input) ? data.tool_input : undefined;
	return {
		message:
			readString(data.message) ??
			readString(data.output) ??
			readString(data.response),
		toolName: readString(data.tool_name),
		toolInput,
	};
}

function readSessionId(
	body: Record<string, unknown>,
	data: Record<string, unknown>,
): string {
	const sessionId =
		readString(body.sessionId) ??
		readString(body.session_id) ??
		readString(data.session_id);

	if (!sessionId) {
		throw new Error("Hook payload is missing sessionId.");
	}

	return sessionId;
}

function readSessionName(
	tool: ToolName,
	sessionId: string,
	body: Record<string, unknown>,
	data: Record<string, unknown>,
	existingSession?: Session,
): string {
	return (
		readString(body.sessionName) ??
		readString(data.session_name) ??
		readString(data.context) ??
		existingSession?.name ??
		fallbackSessionName(tool, sessionId)
	);
}

function normalizeClaudeEvent(
	rawEvent: string,
	sessionId: string,
	sessionName: string,
	data: Record<string, unknown>,
): HookEnvelope {
	const bridgeData = toBridgeEventData(data);
	switch (normalizeEventName(rawEvent)) {
		case "notification":
			return {
				tool: "claude",
				event: rawEvent,
				sessionId,
				sessionName,
				normalizedEvent: "ai_question",
				data: {
					...bridgeData,
					message: bridgeData.message ?? "Claude requires user input.",
				},
				pendingRequestType: "ai_question",
				shouldNotifyBot: true,
			};
		case "pretool":
		case "pretooluse":
			return {
				tool: "claude",
				event: rawEvent,
				sessionId,
				sessionName,
				normalizedEvent: "permission_request",
				data: bridgeData,
				pendingRequestType: "permission_request",
				shouldNotifyBot: true,
			};
		case "posttool":
		case "posttooluse":
			return {
				tool: "claude",
				event: rawEvent,
				sessionId,
				sessionName,
				normalizedEvent: "after_tool",
				data: bridgeData,
				shouldNotifyBot: false,
			};
		case "sessionend":
			return {
				tool: "claude",
				event: rawEvent,
				sessionId,
				sessionName,
				normalizedEvent: "session_end",
				data: bridgeData,
				shouldNotifyBot: true,
			};
		default:
			return {
				tool: "claude",
				event: rawEvent,
				sessionId,
				sessionName,
				normalizedEvent: "response_complete",
				data: {
					...bridgeData,
					message: bridgeData.message ?? "Claude turn completed.",
				},
				shouldNotifyBot: true,
			};
	}
}

function normalizeCodexEvent(
	rawEvent: string,
	sessionId: string,
	sessionName: string,
	data: Record<string, unknown>,
): HookEnvelope {
	const bridgeData = toBridgeEventData(data);
	switch (normalizeEventName(rawEvent)) {
		case "sessionstart":
			return {
				tool: "codex",
				event: rawEvent,
				sessionId,
				sessionName,
				normalizedEvent: "session_start",
				data: bridgeData,
				shouldNotifyBot: true,
			};
		case "aftertool":
		case "aftertooluse":
			return {
				tool: "codex",
				event: rawEvent,
				sessionId,
				sessionName,
				normalizedEvent: "after_tool",
				data: bridgeData,
				shouldNotifyBot: false,
			};
		case "sessionend":
			return {
				tool: "codex",
				event: rawEvent,
				sessionId,
				sessionName,
				normalizedEvent: "session_end",
				data: bridgeData,
				shouldNotifyBot: true,
			};
		default:
			return {
				tool: "codex",
				event: rawEvent,
				sessionId,
				sessionName,
				normalizedEvent: "response_complete",
				data: {
					...bridgeData,
					message: bridgeData.message ?? "Codex turn completed.",
				},
				shouldNotifyBot: true,
			};
	}
}

export function parseHookEvent(
	body: unknown,
	existingSession?: Session,
): HookEnvelope {
	if (!isRecord(body)) {
		throw new Error("Hook payload must be an object.");
	}

	const tool = readString(body.tool);
	if (tool !== "claude" && tool !== "codex") {
		throw new Error("Hook payload must include tool: 'claude' | 'codex'.");
	}

	const event = readString(body.event);
	if (!event) {
		throw new Error("Hook payload must include event.");
	}

	const data = isRecord(body.data) ? body.data : {};
	const sessionId = readSessionId(body, data);
	const sessionName = readSessionName(
		tool,
		sessionId,
		body,
		data,
		existingSession,
	);

	return tool === "claude"
		? normalizeClaudeEvent(event, sessionId, sessionName, data)
		: normalizeCodexEvent(event, sessionId, sessionName, data);
}

export function buildBridgeEvent(params: {
	tool: ToolName;
	sessionId: string;
	sessionName: string;
	event: BridgeEventType;
	data?: BridgeEventData;
	requestId?: string;
}): BridgeEvent {
	return {
		tool: params.tool,
		sessionId: params.sessionId,
		sessionName: params.sessionName,
		event: params.event,
		data: params.data ?? {},
		timestamp: new Date().toISOString(),
		requestId: params.requestId,
	};
}
