import {
	ChannelType,
	type Client,
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

	async ensureThread(
		sessionId: string,
		sessionName: string,
		tool: ToolName,
	): Promise<ThreadChannel> {
		const existingThreadId = this.sessionToThread.get(sessionId);
		if (existingThreadId) {
			const existingThread = await this.fetchThread(existingThreadId);
			if (existingThread) {
				return existingThread;
			}
		}

		const parentChannel = await this.client.channels.fetch(
			this.parentChannelId,
		);
		if (!(parentChannel instanceof TextChannel)) {
			throw new Error(
				`DISCORD_CHANNEL_ID must point to a text channel. Received ${parentChannel?.type ?? "unknown"}.`,
			);
		}

		const thread = await parentChannel.threads.create({
			name: sessionName,
			autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
			type: ChannelType.PublicThread,
			reason: `Remote AI session ${tool}:${sessionId}`,
		});

		this.sessionToThread.set(sessionId, thread.id);
		this.threadToSession.set(thread.id, sessionId);

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
