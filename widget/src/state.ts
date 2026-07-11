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

/** Which conversation list the sidebar is currently showing. */
export type SidebarTab = "dms" | "channels";

interface WidgetState {
  open: boolean;
  sidebarOpen: boolean;
  activeConversation: ConversationRef;
  /** Parent message id whose thread panel is open, or null when closed.
   * Ephemeral UI state — not persisted (a thread view shouldn't survive a
   * reload the way the active conversation does). */
  activeThreadId: number | null;
  unreadCount: number;
  /** Which sidebar list (DMs vs group channels) is active, persisted. */
  activeTab: SidebarTab;
  /** User preference: raise native browser notifications for new messages
   * while the widget is closed / on another conversation. Persisted. */
  browserNotificationsEnabled: boolean;
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
  setActiveThreadId: (id: number | null) => void;
  setUnreadCount: (n: number) => void;
  incrementUnread: () => void;
  clearUnread: () => void;
  setActiveTab: (tab: SidebarTab) => void;
  setBrowserNotificationsEnabled: (enabled: boolean) => void;
  setPillPosition: (pos: { right: number; bottom: number }) => void;
  setActiveCall: (call: ActiveCall | null) => void;
  setIncomingCall: (call: IncomingCall | null) => void;
}

const PILL_POS_KEY = "bcw_pill_pos";
const ACTIVE_TAB_KEY = "bcw_active_tab";
const NOTIFS_ENABLED_KEY = "bcw_browser_notifs";

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

function loadActiveTab(): SidebarTab {
  try {
    const raw = localStorage.getItem(ACTIVE_TAB_KEY);
    if (raw === "dms" || raw === "channels") return raw;
  } catch {
    /* ignore */
  }
  return "dms";
}

function loadBrowserNotificationsEnabled(): boolean {
  // Default ON. Only an explicit "false" stored by the user turns it off, so a
  // fresh install / unavailable localStorage keeps the opt-out-by-default UX.
  try {
    return localStorage.getItem(NOTIFS_ENABLED_KEY) !== "false";
  } catch {
    return true;
  }
}

export const useWidgetStore = create<WidgetState>((set) => ({
  open: false,
  sidebarOpen: false,
  activeConversation: null,
  activeThreadId: null,
  unreadCount: 0,
  activeTab: loadActiveTab(),
  browserNotificationsEnabled: loadBrowserNotificationsEnabled(),
  pillPosition: loadPillPosition(),
  activeCall: null,
  incomingCall: null,

  setOpen: (open) => set({ open }),
  toggleOpen: () => set((s) => ({ open: !s.open })),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  setActiveConversation: (activeConversation) => set({ activeConversation }),
  setActiveThreadId: (activeThreadId) => set({ activeThreadId }),
  setUnreadCount: (unreadCount) => set({ unreadCount }),
  incrementUnread: () => set((s) => ({ unreadCount: s.unreadCount + 1 })),
  clearUnread: () => set({ unreadCount: 0 }),
  setActiveTab: (activeTab) => {
    try { localStorage.setItem(ACTIVE_TAB_KEY, activeTab); } catch { /* ignore */ }
    set({ activeTab });
  },
  setBrowserNotificationsEnabled: (browserNotificationsEnabled) => {
    try { localStorage.setItem(NOTIFS_ENABLED_KEY, String(browserNotificationsEnabled)); } catch { /* ignore */ }
    set({ browserNotificationsEnabled });
  },
  setPillPosition: (pillPosition) => {
    try { localStorage.setItem(PILL_POS_KEY, JSON.stringify(pillPosition)); } catch { /* ignore */ }
    set({ pillPosition });
  },
  setActiveCall: (activeCall) => set({ activeCall }),
  setIncomingCall: (incomingCall) => set({ incomingCall }),
}));
