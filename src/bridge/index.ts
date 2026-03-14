import Fastify from "fastify";

import { loadBridgeConfig } from "../shared/config.js";
import type { UserInputPayload } from "../shared/types.js";
import { buildBridgeEvent, parseHookEvent } from "./eventParser.js";
import { notifyBot } from "./inputRouter.js";
import { SessionManager } from "./sessionManager.js";

const config = loadBridgeConfig();
const sessionManager = new SessionManager();
const app = Fastify({ logger: true });

function readExistingSessionId(body: unknown): string | undefined {
	if (typeof body !== "object" || body === null) {
		return undefined;
	}

	const topLevel = body as {
		sessionId?: unknown;
		session_id?: unknown;
		data?: unknown;
	};
	if (typeof topLevel.sessionId === "string" && topLevel.sessionId.trim()) {
		return topLevel.sessionId;
	}
	if (typeof topLevel.session_id === "string" && topLevel.session_id.trim()) {
		return topLevel.session_id;
	}
	if (typeof topLevel.data === "object" && topLevel.data !== null) {
		const data = topLevel.data as { session_id?: unknown };
		if (typeof data.session_id === "string" && data.session_id.trim()) {
			return data.session_id;
		}
	}

	return undefined;
}

app.addHook("preHandler", async (request, reply) => {
	if (request.method !== "POST") {
		return;
	}

	const secret = request.headers["x-bridge-secret"];
	if (secret !== config.bridgeSecret) {
		reply.code(401);
		throw new Error("Unauthorized bridge request.");
	}
});

async function processHookPayload(body: unknown) {
	const existingSessionId = readExistingSessionId(body);
	const existingSession = existingSessionId
		? sessionManager.getSession(existingSessionId)
		: undefined;
	const parsed = parseHookEvent(body, existingSession);
	const { session, isNew } = sessionManager.getOrCreateSession({
		sessionId: parsed.sessionId,
		tool: parsed.tool,
		name: parsed.sessionName,
	});

	if (isNew && parsed.normalizedEvent !== "session_start") {
		const sessionStartEvent = buildBridgeEvent({
			tool: session.tool,
			sessionId: session.sessionId,
			sessionName: session.name,
			event: "session_start",
		});
		await notifyBot(config, sessionStartEvent);
	}

	let requestId: string | undefined;
	if (parsed.pendingRequestType) {
		const pendingRequest = sessionManager.registerPendingRequest(
			session.sessionId,
			parsed.pendingRequestType,
		);
		requestId = pendingRequest.requestId;
	} else if (parsed.normalizedEvent === "session_end") {
		sessionManager.endSession(session.sessionId);
	} else {
		sessionManager.setStatus(session.sessionId, "active");
	}

	if (parsed.normalizedEvent === "after_tool") {
		return {
			ok: true,
			event: parsed.normalizedEvent,
			requestId,
		};
	}

	const bridgeEvent = buildBridgeEvent({
		tool: session.tool,
		sessionId: session.sessionId,
		sessionName: session.name,
		event: parsed.normalizedEvent,
		data: parsed.data,
		requestId,
	});

	if (parsed.shouldNotifyBot) {
		await notifyBot(config, bridgeEvent);
	}

	return {
		ok: true,
		event: bridgeEvent.event,
		requestId,
	};
}

app.post("/hook/claude", async (request) => processHookPayload(request.body));
app.post("/hook/codex", async (request) => processHookPayload(request.body));

app.post<{ Body: UserInputPayload }>("/input", async (request, reply) => {
	const result = sessionManager.resolveInput(request.body);
	if (!result.ok) {
		reply.code(404);
		return result;
	}

	return {
		ok: true,
		accepted: true,
		pendingRequest: result.pendingRequest,
		note:
			request.body.type === "direct_prompt"
				? "Prompt accepted, but forwarding direct prompts to AI sessions is not implemented in this skeleton."
				: undefined,
	};
});

app.get("/sessions", async () => ({
	sessions: sessionManager.listSessions(),
}));

const address = await app.listen({
	host: config.bridgeHost,
	port: config.bridgePort,
});

app.log.info(`Bridge server listening on ${address}`);
