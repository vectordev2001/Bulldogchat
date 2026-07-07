// Cross-tab/cross-app sync bridge. When both the main Bulldogchat tab and a
// Contracts/Ops tab (with the widget open) are open at once, this keeps
// "which conversation is active" mirrored between them via the
// BroadcastChannel Web API — no server round-trip needed since both sides
// are already fetching from the same Chat API/SSE stream, we just need to
// tell the other side WHAT to look at.
//
// Channel name is a well-known constant so the main Chat app (Home.tsx)
// and any number of widget instances (Contracts, Ops, ...) all rendezvous
// on the same channel regardless of which origin they're running on —
// BroadcastChannel is scoped per-origin, so this only actually links tabs
// on the SAME origin. Cross-origin (chat.bulldogops.com <-> contracts...)
// tabs can't share a BroadcastChannel; for that case each widget instance
// falls back to independently tracking its own localStorage key and
// relying on the SSE dm:updated/dm:created/message:new events for content
// freshness. Same-origin multi-tab (e.g. two Contracts tabs) gets full
// active-conversation mirroring "for free" via this bridge.

export const SYNC_CHANNEL_NAME = "bulldog-chat-sync";
export const LAST_CONVERSATION_KEY = "bulldog-chat-widget:last-conversation";

export type SyncMessage =
  | { type: "conversation:changed"; kind: "dm" | "channel"; id: number; source: string }
  | { type: "unread:changed"; count: number; source: string };

type Listener = (msg: SyncMessage) => void;

export class ChatSyncBridge {
  private bc: BroadcastChannel | null = null;
  private listeners = new Set<Listener>();
  // Random per-instance id so we can ignore our own broadcasts (some
  // browsers loop them back to the sender in edge cases / polyfills).
  private readonly instanceId = Math.random().toString(36).slice(2);

  constructor() {
    if (typeof BroadcastChannel !== "undefined") {
      try {
        this.bc = new BroadcastChannel(SYNC_CHANNEL_NAME);
        this.bc.addEventListener("message", (e: MessageEvent<SyncMessage>) => {
          if (!e.data || (e.data as any).source === this.instanceId) return;
          for (const l of this.listeners) l(e.data);
        });
      } catch {
        this.bc = null; // e.g. very old Safari — falls back to no-op
      }
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  broadcastConversationChanged(kind: "dm" | "channel", id: number) {
    const msg: SyncMessage = { type: "conversation:changed", kind, id, source: this.instanceId };
    this.bc?.postMessage(msg);
    this.persistLastConversation(kind, id);
  }

  broadcastUnreadChanged(count: number) {
    const msg: SyncMessage = { type: "unread:changed", count, source: this.instanceId };
    this.bc?.postMessage(msg);
  }

  persistLastConversation(kind: "dm" | "channel", id: number) {
    try {
      localStorage.setItem(LAST_CONVERSATION_KEY, JSON.stringify({ kind, id }));
    } catch {
      /* localStorage unavailable (private mode / SSR) — sync degrades to
         in-memory-only for this session, which is an acceptable fallback. */
    }
  }

  readLastConversation(): { kind: "dm" | "channel"; id: number } | null {
    try {
      const raw = localStorage.getItem(LAST_CONVERSATION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && (parsed.kind === "dm" || parsed.kind === "channel") && Number.isFinite(parsed.id)) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  close() {
    this.bc?.close();
    this.listeners.clear();
  }
}
