import {
	ChannelType,
	type Client,
	PermissionsBitField,
	TextChannel,
	ThreadAutoArchiveDuration,
	type ThreadChannel,
} from "discord.js";

import type { PersistentStorePayload, PersistedThreadBinding, ToolName } from "../shared/types.js";
import { PersistentSessionStore } from "../shared/persistentSessionStore.js";

export class ThreadManager {
	private readonly sessionToThread = new Map<string, string>();
	private readonly threadToSession = new Map<string, string>();
	private readonly bindings = new Map<string, PersistedThreadBinding>();

	constructor(
		private readonly client: Client,
		private readonly parentChannelId: string,
		private readonly store: PersistentSessionStore,
	) {}

	getSessionIdForThread(threadId: string): string | undefined {
		return this.threadToSession.get(threadId);
	}

	async hydratePersistedBindings(): Promise<void> {
		const payload = await this.store.load();
		let changed = false;

		for (const binding of payload.bindings) {
			this.bindings.set(binding.sessionId, binding);
			if (binding.archived) {
				continue;
			}

			const thread = await this.fetchThread(binding.threadId);
			if (!thread) {
				console.warn(
					JSON.stringify({
						scope: "discord_thread",
						stage: "hydrate_missing",
						sessionId: binding.sessionId,
						threadId: binding.threadId,
					}),
				);
				this.bindings.set(binding.sessionId, {
					...binding,
					status: "inactive",
					archived: true,
					updatedAt: new Date().toISOString(),
				});
				changed = true;
				continue;
			}

			this.sessionToThread.set(binding.sessionId, binding.threadId);
			this.threadToSession.set(binding.threadId, binding.sessionId);
			console.log(
				JSON.stringify({
					scope: "discord_thread",
					stage: "hydrated",
					sessionId: binding.sessionId,
					threadId: binding.threadId,
					sessionName: binding.sessionName,
					tool: binding.tool,
				}),
			);
		}

		if (changed) {
			await this.flushBindings();
		}
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
				await this.upsertBinding({
					sessionId,
					threadId: existingThread.id,
					sessionName,
					tool,
					status: "active",
					archived: Boolean(existingThread.archived),
				});
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
		await this.upsertBinding({
			sessionId,
			threadId: thread.id,
			sessionName,
			tool,
			status: "active",
			archived: Boolean(thread.archived),
		});
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
			await this.markBindingInactive(sessionId);
			this.clearSession(sessionId);
			return;
		}

		if (!thread.archived) {
			await thread.setArchived(true, "Remote AI session ended");
		}
		await this.upsertBinding({
			sessionId,
			threadId,
			sessionName: thread.name,
			tool: this.bindings.get(sessionId)?.tool ?? "codex",
			status: "completed",
			archived: true,
		});
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
		try {
			const channel = await this.client.channels.fetch(threadId);
			if (channel?.isThread()) {
				return channel;
			}
		} catch {
			return null;
		}

		return null;
	}

	private async upsertBinding(params: {
		sessionId: string;
		threadId: string;
		sessionName: string;
		tool: ToolName;
		status: PersistedThreadBinding["status"];
		archived: boolean;
	}): Promise<void> {
		const now = new Date().toISOString();
		const existing = this.bindings.get(params.sessionId);
		this.bindings.set(params.sessionId, {
			...existing,
			sessionId: params.sessionId,
			threadId: params.threadId,
			tool: params.tool,
			sessionName: params.sessionName,
			status: params.status,
			lastActivity: now,
			archived: params.archived,
			updatedAt: now,
		});
		await this.flushBindings();
	}

	private async markBindingInactive(sessionId: string): Promise<void> {
		const existing = this.bindings.get(sessionId);
		if (!existing) {
			return;
		}

		this.bindings.set(sessionId, {
			...existing,
			status: "inactive",
			archived: true,
			updatedAt: new Date().toISOString(),
		});
		await this.flushBindings();
	}

	private async flushBindings(): Promise<void> {
		const payload: PersistentStorePayload = {
			version: 1,
			bindings: Array.from(this.bindings.values()).sort((left, right) =>
				left.updatedAt.localeCompare(right.updatedAt),
			),
		};
		await this.store.save(payload);
	}

	private clearSession(sessionId: string): void {
		const threadId = this.sessionToThread.get(sessionId);
		if (threadId) {
			this.threadToSession.delete(threadId);
		}

		this.sessionToThread.delete(sessionId);
	}
}
