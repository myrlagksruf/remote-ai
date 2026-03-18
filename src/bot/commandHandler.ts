import {
	type ButtonInteraction,
	type ChatInputCommandInteraction,
	type Client,
	Events,
	type Message,
} from "discord.js";

import type { BotConfig } from "../shared/config.js";
import type { BridgeInputResponse, UserInputPayload } from "../shared/types.js";
import type { PendingRequestStore } from "./pendingRequests.js";
import type { ThreadManager } from "./threadManager.js";

interface CommandHandlerDeps {
	client: Client;
	config: BotConfig;
	threadManager: ThreadManager;
	pendingRequests: PendingRequestStore;
}

export function buildPlanPrompt(prompt: string): string {
	return [
		"Treat the following user request as a planning task for the current session.",
		"Do not implement changes yet.",
		"If any high-impact ambiguity remains, ask focused follow-up questions first.",
		"When the spec is decision-complete, finish with a concise structured implementation plan.",
		"",
		prompt.trim(),
	].join("\n");
}

async function postUserInput(
	config: BotConfig,
	payload: UserInputPayload,
): Promise<{
	ok: boolean;
	status: number;
	body: BridgeInputResponse;
}> {
	const response = await fetch(`${config.bridgeBaseUrl}/input`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-bridge-secret": config.bridgeSecret,
		},
		body: JSON.stringify(payload),
	});
	const contentType = response.headers.get("content-type") ?? "";
	const body = contentType.includes("application/json")
		? ((await response.json()) as BridgeInputResponse)
		: {
				ok: response.ok,
				reason: await response.text(),
			};

	return {
		ok: response.ok,
		status: response.status,
		body,
	};
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
	console.log(
		JSON.stringify({
			scope: "discord_input",
			stage: "received",
			sessionId,
			threadId: message.channelId,
			inputType: requestId ? "text_response" : "direct_prompt",
			messagePreview: message.content.slice(0, 160),
		}),
	);

	const inputResult = await postUserInput(config, {
		sessionId,
		requestId,
		type: requestId ? "text_response" : "direct_prompt",
		content: message.content,
	});
	console.log(
		JSON.stringify({
			scope: "discord_input",
			stage: "forwarded",
			sessionId,
			threadId: message.channelId,
			inputType: requestId ? "text_response" : "direct_prompt",
			ok: inputResult.ok,
			status: inputResult.status,
			busy: inputResult.body.busy ?? false,
			reason: inputResult.body.reason,
		}),
	);

	if (requestId || inputResult.ok) {
		return;
	}

	const reason =
		inputResult.body.reason ?? "Bridge가 요청을 처리하지 못했습니다.";
	if (inputResult.body.busy) {
		await message.channel.send(
			"⏳ Codex 세션이 이미 다른 후속 요청을 처리 중입니다. 현재 turn이 끝난 뒤 다시 보내주세요.",
		);
		return;
	}

	await message.channel.send(`⚠️ 요청을 전달하지 못했습니다.\n${reason}`);
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
	console.log(
		JSON.stringify({
			scope: "discord_input",
			stage: "permission_response",
			sessionId,
			threadId: interaction.channelId,
			requestId,
			allowed,
		}),
	);

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

async function handlePlanInteraction(
	config: BotConfig,
	threadManager: ThreadManager,
	interaction: ChatInputCommandInteraction,
): Promise<void> {
	if (interaction.commandName !== "plan") {
		return;
	}

	if (!interaction.inGuild() || !interaction.channel?.isThread()) {
		await interaction.reply({
			content: "기존 session thread 안에서만 `/plan` 을 사용할 수 있습니다.",
			ephemeral: true,
		});
		return;
	}

	if (interaction.user.id !== config.discordUserId) {
		await interaction.reply({
			content: "이 명령은 지정된 사용자만 사용할 수 있습니다.",
			ephemeral: true,
		});
		return;
	}

	const sessionId = threadManager.getSessionIdForThread(interaction.channelId);
	if (!sessionId) {
		await interaction.reply({
			content: "이 thread에 연결된 Codex 세션을 찾지 못했습니다.",
			ephemeral: true,
		});
		return;
	}

	const prompt = interaction.options.getString("prompt", true).trim();
	const inputResult = await postUserInput(config, {
		sessionId,
		type: "direct_prompt",
		content: buildPlanPrompt(prompt),
	});
	console.log(
		JSON.stringify({
			scope: "discord_input",
			stage: "plan_forwarded",
			sessionId,
			threadId: interaction.channelId,
			ok: inputResult.ok,
			status: inputResult.status,
			busy: inputResult.body.busy ?? false,
			reason: inputResult.body.reason,
		}),
	);

	if (inputResult.ok) {
		await interaction.reply({
			content:
				"계획 요청을 현재 Codex 세션으로 전달했습니다. 응답은 이 thread에 이어집니다.",
			ephemeral: true,
		});
		return;
	}

	const reason =
		inputResult.body.reason ?? "Bridge가 요청을 처리하지 못했습니다.";
	await interaction.reply({
		content: inputResult.body.busy
			? "Codex 세션이 이미 다른 후속 요청을 처리 중입니다. 현재 turn이 끝난 뒤 다시 시도해주세요."
			: `계획 요청을 전달하지 못했습니다.\n${reason}`,
		ephemeral: true,
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
		try {
			if (interaction.isButton()) {
				await handleButtonInteraction(config, threadManager, interaction);
				return;
			}

			if (interaction.isChatInputCommand()) {
				await handlePlanInteraction(config, threadManager, interaction);
			}
		} catch (error) {
			console.error("Failed to handle interaction:", error);
			if (
				interaction.isRepliable() &&
				!interaction.replied &&
				!interaction.deferred
			) {
				await interaction.reply({
					content: "Bridge에 응답을 전달하지 못했습니다.",
					ephemeral: true,
				});
			}
		}
	});
}
