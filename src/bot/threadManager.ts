import {
	ChannelType,
	type Client,
	PermissionsBitField,
	TextChannel,
	ThreadAutoArchiveDuration,
	type ThreadChannel,
} from "discord.js";

import type { ToolName } from "../shared/types.js";

export class ThreadManager {
	private readonly sessionToThread = new Map<string, string>();
	private readonly threadToSession = new Map<string, string>();

	constructor(
		private readonly client: Client,
		private readonly parentChannelId: string,
	) {}

	getSessionIdForThread(threadId: string): string | undefined {
		return this.threadToSession.get(threadId);
	}

	async validateParentChannelAccess(): Promise<TextChannel> {
		const parentChannel = await this.client.channels.fetch(
			this.parentChannelId,
		);
		if (!(parentChannel instanceof TextChannel)) {
			throw new Error(
				`DISCORD_CHANNEL_ID must point to a guild text channel. Received ${parentChannel?.type ?? "unknown"}.`,
			);
		}

		const botUserId = this.client.user?.id;
		if (!botUserId) {
			throw new Error("Discord client is not ready.");
		}

		const permissions = parentChannel.permissionsFor(botUserId);
		if (!permissions) {
			throw new Error(
				`Unable to resolve permissions for bot user ${botUserId} in channel ${this.parentChannelId}.`,
			);
		}

		const requiredPermissions = [
			[PermissionsBitField.Flags.ViewChannel, "ViewChannel"],
			[PermissionsBitField.Flags.SendMessages, "SendMessages"],
			[PermissionsBitField.Flags.CreatePublicThreads, "CreatePublicThreads"],
			[
				PermissionsBitField.Flags.SendMessagesInThreads,
				"SendMessagesInThreads",
			],
		] as const;
		const missingPermissions = requiredPermissions
			.filter(([permission]) => !permissions.has(permission))
			.map(([, permissionName]) => permissionName);
		if (missingPermissions.length > 0) {
			throw new Error(
				`Bot is missing required permissions in DISCORD_CHANNEL_ID=${this.parentChannelId}: ${missingPermissions.join(", ")}.`,
			);
		}

		return parentChannel;
	}

	async ensureThread(
		sessionId: string,
		sessionName: string,
		tool: ToolName,
	): Promise<ThreadChannel> {
		const existingThreadId = this.sessionToThread.get(sessionId);
		if (existingThreadId) {
			const existingThread = await this.fetchThread(existingThreadId);
			if (existingThread) {
				console.log(
					JSON.stringify({
						scope: "discord_thread",
						stage: "reused",
						sessionId,
						threadId: existingThread.id,
						sessionName,
						tool,
					}),
				);
				return existingThread;
			}
		}

		const parentChannel = await this.validateParentChannelAccess();

		const thread = await parentChannel.threads.create({
			name: sessionName,
			autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
			type: ChannelType.PublicThread,
			reason: `Remote AI session ${tool}:${sessionId}`,
		});

		this.sessionToThread.set(sessionId, thread.id);
		this.threadToSession.set(thread.id, sessionId);
		console.log(
			JSON.stringify({
				scope: "discord_thread",
				stage: "created",
				sessionId,
				threadId: thread.id,
				sessionName,
				tool,
			}),
		);

		return thread;
	}

	async archiveThread(sessionId: string): Promise<void> {
		const threadId = this.sessionToThread.get(sessionId);
		if (!threadId) {
			return;
		}

		const thread = await this.fetchThread(threadId);
		if (!thread) {
			this.clearSession(sessionId);
			return;
		}

		if (!thread.archived) {
			await thread.setArchived(true, "Remote AI session ended");
		}
		console.log(
			JSON.stringify({
				scope: "discord_thread",
				stage: "archived",
				sessionId,
				threadId,
			}),
		);

		this.clearSession(sessionId);
	}

	private async fetchThread(threadId: string): Promise<ThreadChannel | null> {
		const channel = await this.client.channels.fetch(threadId);
		if (channel?.isThread()) {
			return channel;
		}

		return null;
	}

	private clearSession(sessionId: string): void {
		const threadId = this.sessionToThread.get(sessionId);
		if (threadId) {
			this.threadToSession.delete(threadId);
		}

		this.sessionToThread.delete(sessionId);
	}
}
