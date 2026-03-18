import Fastify from "fastify";

import { loadBridgeConfig } from "../shared/config.js";
import { PersistentSessionStore } from "../shared/persistentSessionStore.js";
import type { BridgeInputResponse, UserInputPayload } from "../shared/types.js";
import { startCodexResume } from "./codexRunner.js";
import { CodexSessionWatcher } from "./codexSessionWatcher.js";
import { buildBridgeEvent, parseHookEvent } from "./eventParser.js";
import { notifyBot } from "./inputRouter.js";
import { SessionManager } from "./sessionManager.js";

const config = loadBridgeConfig();
const sessionManager = new SessionManager();
const app = Fastify({ logger: true });
const codexWatcher = new CodexSessionWatcher(config, sessionManager, app.log);
const persistentStore = new PersistentSessionStore(config.threadBindingsFile);

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
		tool: "claude",
		name: parsed.sessionName,
	});

	if (isNew && parsed.normalizedEvent !== "session_start") {
		const sessionStartEvent = buildBridgeEvent({
			tool: "claude",
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
		tool: "claude",
		sessionId: session.sessionId,
		sessionName: session.name,
		event: parsed.normalizedEvent,
		data: parsed.data,
		requestId,
	});

	if (parsed.shouldNotifyBot) {
		await notifyBot(config, bridgeEvent);
	}
	app.log.info(
		{
			scope: "bridge_hook",
			tool: bridgeEvent.tool,
			event: bridgeEvent.event,
			sessionId: bridgeEvent.sessionId,
			sessionName: bridgeEvent.sessionName,
			requestId,
			messagePreview: bridgeEvent.data.message?.slice(0, 160),
		},
		"Processed bridge hook payload.",
	);

	return {
		ok: true,
		event: bridgeEvent.event,
		requestId,
	};
}

const persistedBindings = await persistentStore.load();
sessionManager.hydratePersistedCodexBindings(persistedBindings.bindings);

app.post("/hook/claude", async (request) => processHookPayload(request.body));

app.post<{ Body: UserInputPayload }>("/input", async (request, reply) => {
	app.log.info(
		{
			scope: "bridge_input",
			type: request.body.type,
			sessionId: request.body.sessionId,
			requestId: request.body.requestId,
			messagePreview: request.body.content?.slice(0, 160),
		},
		"Received bridge input.",
	);

	if (request.body.type === "direct_prompt") {
		const session = sessionManager.getSession(request.body.sessionId);
		if (!session) {
			reply.code(404);
			return {
				ok: false,
				reason: `Unknown session: ${request.body.sessionId}`,
			} satisfies BridgeInputResponse;
		}

		if (session.tool !== "codex") {
			reply.code(400);
			return {
				ok: false,
				reason: `Direct prompts are only supported for Codex sessions in this bridge.`,
			} satisfies BridgeInputResponse;
		}

		if (!request.body.content?.trim()) {
			reply.code(400);
			return {
				ok: false,
				reason: "Prompt content is required for Codex resume execution.",
			} satisfies BridgeInputResponse;
		}

		const startResult = await startCodexResume({
			config,
			sessionManager,
			sessionId: session.sessionId,
			prompt: request.body.content,
		});

		if (!startResult.ok) {
			reply.code(startResult.busy ? 409 : 500);
			return {
				ok: false,
				busy: startResult.busy,
				reason: startResult.reason,
			} satisfies BridgeInputResponse;
		}

		reply.code(202);
		app.log.info(
			{
				scope: "bridge_input",
				type: request.body.type,
				sessionId: request.body.sessionId,
				started: true,
			},
			"Accepted Codex direct prompt.",
		);
		return {
			ok: true,
			accepted: true,
			started: true,
		} satisfies BridgeInputResponse;
	}

	const result = sessionManager.resolveInput(request.body);
	if (!result.ok) {
		reply.code(404);
		return result satisfies BridgeInputResponse;
	}
	app.log.info(
		{
			scope: "bridge_input",
			type: request.body.type,
			sessionId: request.body.sessionId,
			requestId: request.body.requestId,
			resolved: true,
		},
		"Resolved pending bridge input.",
	);

	return {
		ok: true,
		accepted: true,
		pendingRequest: result.pendingRequest,
	} satisfies BridgeInputResponse;
});

app.get("/sessions", async () => ({
	sessions: sessionManager.listSessions(),
	codexWatcher: codexWatcher.getDiagnostics(),
}));

await codexWatcher.start();
const address = await app.listen({
	host: config.bridgeHost,
	port: config.bridgePort,
});

app.log.info(`Bridge server listening on ${address}`);
