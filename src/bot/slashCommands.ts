import {
	SlashCommandBuilder,
	type Client,
} from "discord.js";

import type { BotConfig } from "../shared/config.js";

const planCommand = new SlashCommandBuilder()
	.setName("plan")
	.setDescription("현재 thread의 Codex 세션에 계획 요청을 전달합니다.")
	.addStringOption((option) =>
		option
			.setName("prompt")
			.setDescription("Codex에게 전달할 계획 요청")
			.setRequired(true),
	)
	.toJSON();

export async function registerSlashCommands(
	client: Client,
	config: BotConfig,
): Promise<void> {
	const guild = await client.guilds.fetch(config.discordGuildId);
	await guild.commands.set([planCommand]);
	console.log(
		JSON.stringify({
			scope: "discord_commands",
			stage: "registered",
			guildId: config.discordGuildId,
			commands: ["plan"],
		}),
	);
}
