export { BulldogChatWidget } from "./BulldogChatWidget";
export type { BulldogChatWidgetProps } from "./BulldogChatWidget";
export { ChatApiClient } from "./api";
export type { ApiUser, ApiChannel, ApiDmChannel, ApiMessage, ApiProject, ApiAttachment, ApiMention, ApiReaction, ApiPresence, ApiWorkObject } from "./api";
export { useWidgetStore } from "./state";
export { ChatSyncBridge, SYNC_CHANNEL_NAME } from "./sync";
export { OPEN_JOB_EVENT } from "./hooks/useOpenJobBus";
export type { OpenJobEventDetail } from "./hooks/useOpenJobBus";
