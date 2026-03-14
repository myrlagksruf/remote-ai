import "dotenv/config";

import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_BRIDGE_HOST = "127.0.0.1";
const DEFAULT_BRIDGE_PORT = 3000;
const DEFAULT_BOT_HOST = "127.0.0.1";
const DEFAULT_BOT_PORT = 3001;

export interface BridgeConfig {
	bridgeHost: string;
	bridgePort: number;
	bridgeSecret: string;
	bridgeBaseUrl: string;
	botBaseUrl: string;
}

export interface BotConfig {
	botHost: string;
	botPort: number;
	bridgeSecret: string;
	bridgeBaseUrl: string;
	botBaseUrl: string;
	discordToken: string;
	discordGuildId: string;
	discordChannelId: string;
	discordUserId: string;
}

function readRequiredEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}

	return value;
}

function readStringEnv(name: string, fallback: string): string {
	return process.env[name]?.trim() || fallback;
}

function readNumberEnv(name: string, fallback: number): number {
	const raw = process.env[name]?.trim();
	if (!raw) {
		return fallback;
	}

	const parsed = Number(raw);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		throw new Error(`Environment variable ${name} must be a positive integer.`);
	}

	return parsed;
}

function buildHttpUrl(host: string, port: number): string {
	return `http://${host}:${port}`;
}

export function loadBridgeConfig(): BridgeConfig {
	const bridgeHost = readStringEnv("BRIDGE_HOST", DEFAULT_BRIDGE_HOST);
	const bridgePort = readNumberEnv("BRIDGE_PORT", DEFAULT_BRIDGE_PORT);
	const botHost = readStringEnv("BOT_HOST", DEFAULT_BOT_HOST);
	const botPort = readNumberEnv("BOT_PORT", DEFAULT_BOT_PORT);
	const bridgeSecret = readRequiredEnv("BRIDGE_SECRET");

	return {
		bridgeHost,
		bridgePort,
		bridgeSecret,
		bridgeBaseUrl: buildHttpUrl(bridgeHost, bridgePort),
		botBaseUrl: buildHttpUrl(botHost, botPort),
	};
}

export function loadBotConfig(): BotConfig {
	const botHost = readStringEnv("BOT_HOST", DEFAULT_BOT_HOST);
	const botPort = readNumberEnv("BOT_PORT", DEFAULT_BOT_PORT);
	const bridgeHost = readStringEnv("BRIDGE_HOST", DEFAULT_BRIDGE_HOST);
	const bridgePort = readNumberEnv("BRIDGE_PORT", DEFAULT_BRIDGE_PORT);
	const bridgeSecret = readRequiredEnv("BRIDGE_SECRET");

	return {
		botHost,
		botPort,
		bridgeSecret,
		bridgeBaseUrl: buildHttpUrl(bridgeHost, bridgePort),
		botBaseUrl: buildHttpUrl(botHost, botPort),
		discordToken: readRequiredEnv("DISCORD_TOKEN"),
		discordGuildId: readRequiredEnv("DISCORD_GUILD_ID"),
		discordChannelId: readRequiredEnv("DISCORD_CHANNEL_ID"),
		discordUserId: readRequiredEnv("DISCORD_USER_ID"),
	};
}

function printConfigSummary(): void {
	const bridgeConfig = loadBridgeConfig();
	const botConfig = loadBotConfig();

	console.log(
		JSON.stringify(
			{
				bridge: {
					bridgeBaseUrl: bridgeConfig.bridgeBaseUrl,
					botBaseUrl: bridgeConfig.botBaseUrl,
				},
				bot: {
					botBaseUrl: botConfig.botBaseUrl,
					bridgeBaseUrl: botConfig.bridgeBaseUrl,
					discordGuildId: botConfig.discordGuildId,
					discordChannelId: botConfig.discordChannelId,
					discordUserId: botConfig.discordUserId,
				},
			},
			null,
			2,
		),
	);
}

const isDirectExecution =
	process.argv[1] !== undefined &&
	import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
	printConfigSummary();
}
