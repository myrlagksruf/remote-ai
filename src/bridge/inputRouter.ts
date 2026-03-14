import type { BridgeConfig } from "../shared/config.js";
import type { BridgeEvent } from "../shared/types.js";

export async function notifyBot(
	config: BridgeConfig,
	event: BridgeEvent,
): Promise<void> {
	const response = await fetch(`${config.botBaseUrl}/bot/event`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
		},
		body: JSON.stringify(event),
	});

	if (!response.ok) {
		const details = await response.text();
		throw new Error(
			`Bot event delivery failed (${response.status} ${response.statusText}): ${details}`,
		);
	}
}
