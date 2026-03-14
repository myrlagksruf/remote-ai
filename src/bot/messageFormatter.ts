import {
	ActionRowBuilder,
	AttachmentBuilder,
	type BaseMessageOptions,
	ButtonBuilder,
	ButtonStyle,
} from "discord.js";

import type { BridgeEvent } from "../shared/types.js";

const DISCORD_MESSAGE_LIMIT = 2000;

function renderToolInput(
	toolInput: Record<string, unknown> | undefined,
): string {
	if (!toolInput) {
		return "입력 정보 없음";
	}

	const command =
		typeof toolInput.command === "string" ? toolInput.command : undefined;
	if (command) {
		return `\`\`\`bash\n${command}\n\`\`\``;
	}

	return `\`\`\`json\n${JSON.stringify(toolInput, null, 2)}\n\`\`\``;
}

function buildLongResponseAttachment(message: string): BaseMessageOptions {
	return {
		content: "✅ **작업 완료**\n응답이 길어 첨부 파일로 보냈습니다.",
		files: [
			new AttachmentBuilder(Buffer.from(message, "utf8"), {
				name: "response.txt",
			}),
		],
	};
}

export function formatEventMessage(event: BridgeEvent): BaseMessageOptions {
	switch (event.event) {
		case "session_start":
			return {
				content: [
					"🚀 **새 세션 시작**",
					`도구: \`${event.tool}\``,
					`세션: \`${event.sessionName}\``,
					`세션 ID: \`${event.sessionId}\``,
				].join("\n"),
			};
		case "response_complete": {
			const message = event.data.message ?? "응답 내용이 비어 있습니다.";
			const title =
				event.data.messageLevel === "system_error"
					? "⚠️ **시스템 오류**"
					: event.data.messageLevel === "system_info"
						? "ℹ️ **시스템 안내**"
						: "✅ **작업 완료**";
			const content = [title, "", message].join("\n");
			if (content.length > DISCORD_MESSAGE_LIMIT) {
				return buildLongResponseAttachment(message);
			}

			return { content };
		}
		case "ai_question":
			return {
				content: [
					"❓ **AI가 확인을 요청합니다**",
					"",
					event.data.message ?? "응답이 필요한 메시지가 도착했습니다.",
					"",
					"이 thread에 답변을 입력하면 Bridge로 전달됩니다.",
				].join("\n"),
			};
		case "permission_request": {
			const content = [
				`🔐 **권한 요청** (${event.tool})`,
				event.data.toolName ? `도구: \`${event.data.toolName}\`` : null,
				renderToolInput(event.data.toolInput),
				"버튼으로 허용 또는 거절을 선택하세요.",
			]
				.filter(Boolean)
				.join("\n");

			const buttons =
				event.tool === "claude" && event.requestId
					? [
							new ActionRowBuilder<ButtonBuilder>().addComponents(
								new ButtonBuilder()
									.setCustomId(`permission:allow:${event.requestId}`)
									.setLabel("허용")
									.setStyle(ButtonStyle.Success),
								new ButtonBuilder()
									.setCustomId(`permission:deny:${event.requestId}`)
									.setLabel("거절")
									.setStyle(ButtonStyle.Danger),
							),
						]
					: [];

			return {
				content,
				components: buttons,
			};
		}
		case "session_end":
			return {
				content: ["🏁 **세션 종료**", `세션: \`${event.sessionName}\``].join(
					"\n",
				),
			};
	}
}
