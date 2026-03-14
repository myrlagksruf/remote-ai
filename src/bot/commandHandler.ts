import {
	type ButtonInteraction,
	type Client,
	Events,
	type Message,
} from "discord.js";

import type { BotConfig } from "../shared/config.js";
import type { UserInputPayload } from "../shared/types.js";
import type { PendingRequestStore } from "./pendingRequests.js";
import type { ThreadManager } from "./threadManager.js";

interface CommandHandlerDeps {
	client: Client;
	config: BotConfig;
	threadManager: ThreadManager;
	pendingRequests: PendingRequestStore;
}

async function postUserInput(
	config: BotConfig,
	payload: UserInputPayload,
): Promise<void> {
	const response = await fetch(`${config.bridgeBaseUrl}/input`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-bridge-secret": config.bridgeSecret,
		},
		body: JSON.stringify(payload),
	});

	if (!response.ok) {
		const details = await response.text();
		throw new Error(
			`Bridge input delivery failed (${response.status} ${response.statusText}): ${details}`,
		);
	}
}

async function handleThreadMessage(
	config: BotConfig,
	threadManager: ThreadManager,
	pendingRequests: PendingRequestStore,
	message: Message,
): Promise<void> {
	if (message.author.bot || !message.inGuild() || !message.channel.isThread()) {
		return;
	}

	if (message.author.id !== config.discordUserId) {
		return;
	}

	const sessionId = threadManager.getSessionIdForThread(message.channelId);
	if (!sessionId) {
		return;
	}

	const requestId = pendingRequests.consumeAwaitingText(message.channelId);
	await postUserInput(config, {
		sessionId,
		requestId,
		type: requestId ? "text_response" : "direct_prompt",
		content: message.content,
	});
}

async function handleButtonInteraction(
	config: BotConfig,
	threadManager: ThreadManager,
	interaction: ButtonInteraction,
): Promise<void> {
	if (!interaction.inGuild() || !interaction.channel?.isThread()) {
		return;
	}

	if (interaction.user.id !== config.discordUserId) {
		await interaction.reply({
			content: "이 권한 요청은 지정된 사용자만 처리할 수 있습니다.",
			ephemeral: true,
		});
		return;
	}

	const sessionId = threadManager.getSessionIdForThread(interaction.channelId);
	if (!sessionId) {
		await interaction.reply({
			content: "세션 매핑을 찾지 못했습니다.",
			ephemeral: true,
		});
		return;
	}

	const parts = interaction.customId.split(":");
	if (parts.length !== 3 || parts[0] !== "permission") {
		return;
	}

	const action = parts[1];
	const requestId = parts[2];
	const allowed = action === "allow";

	await postUserInput(config, {
		sessionId,
		requestId,
		type: "permission_response",
		allowed,
	});

	await interaction.update({
		components: [],
	});
}

export function registerCommandHandlers({
	client,
	config,
	threadManager,
	pendingRequests,
}: CommandHandlerDeps): void {
	client.on(Events.MessageCreate, async (message) => {
		try {
			await handleThreadMessage(
				config,
				threadManager,
				pendingRequests,
				message,
			);
		} catch (error) {
			console.error("Failed to handle thread message:", error);
		}
	});

	client.on(Events.InteractionCreate, async (interaction) => {
		if (!interaction.isButton()) {
			return;
		}

		try {
			await handleButtonInteraction(config, threadManager, interaction);
		} catch (error) {
			console.error("Failed to handle button interaction:", error);
			if (!interaction.replied && !interaction.deferred) {
				await interaction.reply({
					content: "Bridge에 응답을 전달하지 못했습니다.",
					ephemeral: true,
				});
			}
		}
	});
}
