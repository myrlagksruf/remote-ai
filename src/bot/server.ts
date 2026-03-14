import Fastify, { type FastifyInstance } from "fastify";

import type { BotConfig } from "../shared/config.js";
import type { BridgeEvent } from "../shared/types.js";

export function createBotServer(params: {
	config: BotConfig;
	onEvent: (event: BridgeEvent) => Promise<void>;
}): FastifyInstance {
	const app = Fastify({ logger: true });

	app.post<{ Body: BridgeEvent }>("/bot/event", async (request, reply) => {
		try {
			await params.onEvent(request.body);
			reply.code(202);
			return { ok: true };
		} catch (error) {
			request.log.error({ err: error }, "Failed to process bridge event.");
			reply.code(500);
			return { ok: false };
		}
	});

	app.addHook("onReady", async () => {
		app.log.info(
			`Bot receiver ready on ${params.config.botBaseUrl}, forwarding to ${params.config.bridgeBaseUrl}`,
		);
	});

	return app;
}
