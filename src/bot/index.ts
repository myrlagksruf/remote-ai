import { Client, Events, GatewayIntentBits, Partials } from "discord.js";

import { loadBotConfig } from "../shared/config.js";
import { PersistentSessionStore } from "../shared/persistentSessionStore.js";
import type { BridgeEvent } from "../shared/types.js";
import { registerCommandHandlers } from "./commandHandler.js";
import { formatEventMessage } from "./messageFormatter.js";
import { PendingRequestStore } from "./pendingRequests.js";
import { createBotServer } from "./server.js";
import { registerSlashCommands } from "./slashCommands.js";
import { ThreadManager } from "./threadManager.js";

const config = loadBotConfig();

const client = new Client({
	intents: [
		GatewayIntentBits.Guilds,
		GatewayIntentBits.GuildMessages,
		GatewayIntentBits.MessageContent,
	],
	partials: [Partials.Channel],
});

const persistentStore = new PersistentSessionStore(config.threadBindingsFile);
const threadManager = new ThreadManager(
	client,
	config.discordChannelId,
	persistentStore,
);
const pendingRequests = new PendingRequestStore();

registerCommandHandlers({
	client,
	config,
	threadManager,
	pendingRequests,
});

async function handleBridgeEvent(event: BridgeEvent): Promise<void> {
	console.log(
		JSON.stringify({
			scope: "bot_event",
			stage: "received",
			event: event.event,
			tool: event.tool,
			sessionId: event.sessionId,
			sessionName: event.sessionName,
			messagePreview: event.data.message?.slice(0, 160),
		}),
	);

	const thread = await threadManager.ensureThread(
		event.sessionId,
		event.sessionName,
		event.tool,
	);

	if (event.event === "ai_question" && event.requestId) {
		pendingRequests.setAwaitingText(thread.id, event.requestId);
	}

	await thread.send(formatEventMessage(event));
	console.log(
		JSON.stringify({
			scope: "bot_event",
			stage: "sent",
			event: event.event,
			tool: event.tool,
			sessionId: event.sessionId,
			threadId: thread.id,
		}),
	);

	if (event.event === "session_end") {
		pendingRequests.clearThread(thread.id);
		await threadManager.archiveThread(event.sessionId);
	}
}

client.once(Events.ClientReady, (readyClient) => {
	console.log(`Discord bot logged in as ${readyClient.user.tag}`);
});

const server = createBotServer({
	config,
	onEvent: handleBridgeEvent,
});

await client.login(config.discordToken);
await threadManager.validateParentChannelAccess();
await threadManager.hydratePersistedBindings();
await registerSlashCommands(client, config);
const address = await server.listen({
	host: config.botHost,
	port: config.botPort,
});

console.log(`Bot receiver listening on ${address}`);
