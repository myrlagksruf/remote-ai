export class PendingRequestStore {
	private readonly awaitingTextByThread = new Map<string, string>();

	setAwaitingText(threadId: string, requestId: string): void {
		this.awaitingTextByThread.set(threadId, requestId);
	}

	peekAwaitingText(threadId: string): string | undefined {
		return this.awaitingTextByThread.get(threadId);
	}

	consumeAwaitingText(threadId: string): string | undefined {
		const requestId = this.awaitingTextByThread.get(threadId);
		if (requestId) {
			this.awaitingTextByThread.delete(threadId);
		}

		return requestId;
	}

	clearThread(threadId: string): void {
		this.awaitingTextByThread.delete(threadId);
	}
}
