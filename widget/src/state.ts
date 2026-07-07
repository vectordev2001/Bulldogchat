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

interface WidgetState {
  open: boolean;
  sidebarOpen: boolean;
  activeConversation: ConversationRef;
  unreadCount: number;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  setSidebarOpen: (open: boolean) => void;
  setActiveConversation: (ref: ConversationRef) => void;
  setUnreadCount: (n: number) => void;
  incrementUnread: () => void;
  clearUnread: () => void;
}

export const useWidgetStore = create<WidgetState>((set) => ({
  open: false,
  sidebarOpen: false,
  activeConversation: null,
  unreadCount: 0,
  setOpen: (open) => set({ open }),
  toggleOpen: () => set((s) => ({ open: !s.open })),
  setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
  setActiveConversation: (activeConversation) => set({ activeConversation }),
  setUnreadCount: (unreadCount) => set({ unreadCount }),
  incrementUnread: () => set((s) => ({ unreadCount: s.unreadCount + 1 })),
  clearUnread: () => set({ unreadCount: 0 }),
}));
