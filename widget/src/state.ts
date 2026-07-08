import { create } from "zustand";

// Local widget UI state (open/closed, active conversation, unread counts).
// Kept intentionally small — actual chat data (messages, DM list) lives in
// simple fetch-on-demand calls in api.ts, not duplicated in this store.
// Persistence of the "last-opened conversation" is handled separately in
// sync.ts (localStorage) so it survives a full page reload, not just a
// store reset.

export type ConversationRef =
  | { kind: "dm"; id: number }
  | { kind: "channel"; id: number }
  | null;

export interface ActiveCall {
  callId: number;
  roomName: string;
  token: string;
  wsUrl: string;
}

export interface IncomingCall {
  callId: number;
  callerId: number;
  callerName: string;
  callerHue?: number;
  kind: "voice" | "video";
}

interface WidgetState {
  open: boolean;
  sidebarOpen: boolean;
  activeConversation: ConversationRef;
  unreadCount: number;
  /** Position of the collapsed pill, persisted to localStorage. */
  pillPosition: { right: number; bottom: number };
  /** Active outgoing/accepted call session. */
  activeCall: ActiveCall | null;
  /** Incoming call waiting for accept/decline. */
  incomingCall: IncomingCall | null;

  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  setSidebarOpen: (open: boolean) => void;
  setActiveConversation: (ref: ConversationRef) => void;
  setUnreadCount: (n: number) => void;
  incrementUnread: () => void;
  clearUnread: () => void;
  setPillPosition: (pos: { right: number; bottom: number }) => void;
  setActiveCall: (call: ActiveCall | null) => void;
  setIncomingCall: (call: IncomingCall | null) => void;
}

const PILL_POS_KEY = "bcw_pill_pos";

function loadPillPosition(): { right: number; bottom: number } {
  try {
    const raw = localStorage.getItem(PILL_POS_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (typeof p.right === "number" && typeof p.bottom === "number") return p;
    }
  } catch {
    /* ignore */
  }
  return { right: 24, bottom: 88 };
}

export const useWidgetStore = create<WidgetState>((set) => ({
  open: false,
  sidebarOpen: false,
  activeConversation: null,
  unreadCount: 0,
  pillPosition: loadPillPosition(),
  activeCall: null,
  incomingCall: null,

  setOpen: (open) => set({ open }),
  toggleOpen: () => set((s) => ({ open: !s.open })),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  setActiveConversation: (activeConversation) => set({ activeConversation }),
  setUnreadCount: (unreadCount) => set({ unreadCount }),
  incrementUnread: () => set((s) => ({ unreadCount: s.unreadCount + 1 })),
  clearUnread: () => set({ unreadCount: 0 }),
  setPillPosition: (pillPosition) => {
    try { localStorage.setItem(PILL_POS_KEY, JSON.stringify(pillPosition)); } catch { /* ignore */ }
    set({ pillPosition });
  },
  setActiveCall: (activeCall) => set({ activeCall }),
  setIncomingCall: (incomingCall) => set({ incomingCall }),
}));
