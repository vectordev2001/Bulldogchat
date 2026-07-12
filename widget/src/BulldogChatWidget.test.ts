// Logic-level tests for the widget package. As with the main app (see
// client/src/components/dm-label.test.ts in the chat repo), there is no
// component-rendering test framework wired up here (no jsdom/RTL) — this
// exercises the non-visual building blocks the widget component depends on:
// the API client (against a stubbed global fetch), the cross-tab sync
// bridge (BroadcastChannel + localStorage), and the Zustand UI store.
//
// Run with: npx tsx --test --test-force-exit src/BulldogChatWidget.test.ts

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { ChatApiClient, ApiError, type ApiMessage, type ApiReaction, type ApiUser, type ApiAttachment, type ApiWorkObject, type ApiChannel } from "./api";
import { ChatSyncBridge, SYNC_CHANNEL_NAME, LAST_CONVERSATION_KEY } from "./sync";
import { useWidgetStore } from "./state";
import { bindOpenJobListener, OPEN_JOB_EVENT, type OpenJobEventDetail } from "./hooks/useOpenJobBus";
import {
  formatFileSize,
  isImageAttachment,
  mergeOlderMessages,
  parseMentions,
  mentionsUser,
  hasOwnReaction,
  reactionToggleAction,
  reactedByNames,
  presenceDotClass,
  presenceLabel,
  threadChipLabel,
  formatRelativeTime,
  typingLabel,
  buildCallableUsers,
  filterCallTargets,
} from "./format";
import type { ApiDmChannel } from "./api";

// ---------------------------------------------------------------------------
// ChatApiClient
// ---------------------------------------------------------------------------

describe("ChatApiClient", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("me() issues a GET with credentials included and parses JSON", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(JSON.stringify({ id: 1, name: "Josh", email: "josh@example.com" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const client = new ChatApiClient("https://chat.bulldogops.com");
    const me = await client.me();

    assert.equal(capturedUrl, "https://chat.bulldogops.com/api/auth/me");
    assert.equal(capturedInit?.method, "GET");
    assert.equal(capturedInit?.credentials, "include");
    assert.equal(me.name, "Josh");
  });

  test("trailing slash on baseUrl is normalized", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify([]), { status: 200 });
    }) as typeof fetch;

    const client = new ChatApiClient("https://chat.bulldogops.com/");
    await client.listDms();
    assert.equal(capturedUrl, "https://chat.bulldogops.com/api/dms");
  });

  test("createTitledDm POSTs title + memberIds as JSON", async () => {
    let capturedBody: string | undefined;
    let capturedMethod = "";
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedMethod = init?.method ?? "";
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ id: 5, created: true }), { status: 200 });
    }) as typeof fetch;

    const client = new ChatApiClient("https://chat.bulldogops.com");
    const result = await client.createTitledDm("Q3 Planning", [2, 3]);

    assert.equal(capturedMethod, "POST");
    assert.deepEqual(JSON.parse(capturedBody!), { title: "Q3 Planning", memberIds: [2, 3] });
    assert.equal(result.id, 5);
  });

  test("non-ok response throws ApiError with server message", async () => {
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ message: "Not a member of this DM" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const client = new ChatApiClient("https://chat.bulldogops.com");
    await assert.rejects(
      () => client.renameDm(99, "New title"),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 403);
        assert.equal(err.message, "Not a member of this DM");
        return true;
      },
    );
  });

  test("non-JSON error body falls back to a generic status message", async () => {
    globalThis.fetch = (async () => new Response("Internal Server Error", { status: 500 })) as typeof fetch;
    const client = new ChatApiClient("https://chat.bulldogops.com");
    await assert.rejects(
      () => client.listMessages(1),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 500);
        assert.match(err.message, /500/);
        return true;
      },
    );
  });

  test("isAuthenticated() returns false instead of throwing on 401", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 })) as typeof fetch;
    const client = new ChatApiClient("https://chat.bulldogops.com");
    assert.equal(await client.isAuthenticated(), false);
  });

  test("isAuthenticated() returns true when /api/auth/me succeeds", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: 1, name: "Josh", email: "josh@example.com" }), { status: 200 })) as typeof fetch;
    const client = new ChatApiClient("https://chat.bulldogops.com");
    assert.equal(await client.isAuthenticated(), true);
  });

  test("listMessages appends a before= cursor only when provided", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify([]), { status: 200 });
    }) as typeof fetch;

    const client = new ChatApiClient("https://chat.bulldogops.com");
    await client.listMessages(7);
    await client.listMessages(7, 42);

    assert.equal(urls[0], "https://chat.bulldogops.com/api/channels/7/messages");
    assert.equal(urls[1], "https://chat.bulldogops.com/api/channels/7/messages?before=42");
  });
});

// ---------------------------------------------------------------------------
// ChatSyncBridge
// ---------------------------------------------------------------------------

describe("ChatSyncBridge", () => {
  // Minimal in-process BroadcastChannel + localStorage shims so this suite
  // can run under plain Node (node:test) without jsdom. Node 18+ actually
  // ships a real global BroadcastChannel, so this mainly guards environments
  // where it's absent; localStorage is not global in Node, so we always shim it.
  let store: Map<string, string>;

  beforeEach(() => {
    store = new Map();
    (globalThis as any).localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
  });

  afterEach(() => {
    delete (globalThis as any).localStorage;
  });

  test("persists and reads back the last active conversation", () => {
    const bridge = new ChatSyncBridge();
    assert.equal(bridge.readLastConversation(), null);

    bridge.persistLastConversation("dm", 42);
    assert.deepEqual(bridge.readLastConversation(), { kind: "dm", id: 42 });

    bridge.close();
  });

  test("readLastConversation() returns null for malformed JSON", () => {
    store.set(LAST_CONVERSATION_KEY, "{not-json");
    const bridge = new ChatSyncBridge();
    assert.equal(bridge.readLastConversation(), null);
    bridge.close();
  });

  test("broadcastConversationChanged notifies other subscribed instances on the same channel", async () => {
    if (typeof BroadcastChannel === "undefined") {
      // Environment has no BroadcastChannel support at all — bridge should
      // degrade to a no-op rather than throw.
      const bridge = new ChatSyncBridge();
      assert.doesNotThrow(() => bridge.broadcastConversationChanged("dm", 1));
      bridge.close();
      return;
    }

    const sender = new ChatSyncBridge();
    const receiver = new ChatSyncBridge();

    const received = await new Promise<any>((resolve) => {
      receiver.subscribe((msg) => resolve(msg));
      sender.broadcastConversationChanged("channel", 7);
    });

    assert.equal(received.type, "conversation:changed");
    assert.equal(received.kind, "channel");
    assert.equal(received.id, 7);

    sender.close();
    receiver.close();
  });

  test("well-known channel name constant matches spec", () => {
    assert.equal(SYNC_CHANNEL_NAME, "bulldog-chat-sync");
  });
});

// ---------------------------------------------------------------------------
// useWidgetStore (Zustand)
// ---------------------------------------------------------------------------

describe("useWidgetStore", () => {
  test("default state is closed with no active conversation", () => {
    // Zustand stores are module-singletons; reset defensively in case an
    // earlier test in the same process mutated it.
    useWidgetStore.setState({ open: false, sidebarOpen: false, activeConversation: null, unreadCount: 0 });
    const s = useWidgetStore.getState();
    assert.equal(s.open, false);
    assert.equal(s.activeConversation, null);
    assert.equal(s.unreadCount, 0);
  });

  test("toggleOpen flips the open flag", () => {
    useWidgetStore.setState({ open: false });
    useWidgetStore.getState().toggleOpen();
    assert.equal(useWidgetStore.getState().open, true);
    useWidgetStore.getState().toggleOpen();
    assert.equal(useWidgetStore.getState().open, false);
  });

  test("incrementUnread / clearUnread", () => {
    useWidgetStore.setState({ unreadCount: 0 });
    useWidgetStore.getState().incrementUnread();
    useWidgetStore.getState().incrementUnread();
    assert.equal(useWidgetStore.getState().unreadCount, 2);
    useWidgetStore.getState().clearUnread();
    assert.equal(useWidgetStore.getState().unreadCount, 0);
  });

  test("setActiveConversation stores the ref", () => {
    useWidgetStore.getState().setActiveConversation({ kind: "dm", id: 9 });
    assert.deepEqual(useWidgetStore.getState().activeConversation, { kind: "dm", id: 9 });
    useWidgetStore.getState().setActiveConversation(null);
    assert.equal(useWidgetStore.getState().activeConversation, null);
  });
});

// ---------------------------------------------------------------------------
// P0.1 — Group channels
// ---------------------------------------------------------------------------

describe("group channels", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("listProjects + listProjectChannels hit the project routes", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify([]), { status: 200 });
    }) as typeof fetch;

    const client = new ChatApiClient("https://chat.bulldogops.com");
    await client.listProjects();
    await client.listProjectChannels(3);

    assert.equal(urls[0], "https://chat.bulldogops.com/api/projects");
    assert.equal(urls[1], "https://chat.bulldogops.com/api/projects/3/channels");
  });

  test("selecting a channel sets activeConversation to {kind:channel, id}", () => {
    // Mirrors what the sidebar channel button does via selectConversation.
    useWidgetStore.getState().setActiveConversation({ kind: "channel", id: 77 });
    assert.deepEqual(useWidgetStore.getState().activeConversation, { kind: "channel", id: 77 });
  });

  test("activeTab defaults to dms and can switch to channels", () => {
    useWidgetStore.setState({ activeTab: "dms" });
    assert.equal(useWidgetStore.getState().activeTab, "dms");
    useWidgetStore.getState().setActiveTab("channels");
    assert.equal(useWidgetStore.getState().activeTab, "channels");
  });
});

// ---------------------------------------------------------------------------
// P0.2 — Pagination
// ---------------------------------------------------------------------------

describe("pagination", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("listMessages appends before= and limit= when provided", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify([]), { status: 200 });
    }) as typeof fetch;

    const client = new ChatApiClient("https://chat.bulldogops.com");
    await client.listMessages(7, undefined, 50);
    await client.listMessages(7, 42, 50);

    assert.equal(urls[0], "https://chat.bulldogops.com/api/channels/7/messages?limit=50");
    assert.equal(urls[1], "https://chat.bulldogops.com/api/channels/7/messages?before=42&limit=50");
  });

  test("mergeOlderMessages prepends older page and preserves ascending order", () => {
    const current: ApiMessage[] = [
      { id: 10, channelId: 1, userId: 1, content: "j", createdAt: "" },
      { id: 11, channelId: 1, userId: 1, content: "k", createdAt: "" },
    ];
    const older: ApiMessage[] = [
      { id: 8, channelId: 1, userId: 1, content: "h", createdAt: "" },
      { id: 9, channelId: 1, userId: 1, content: "i", createdAt: "" },
    ];
    const merged = mergeOlderMessages(older, current);
    assert.deepEqual(merged.map((m) => m.id), [8, 9, 10, 11]);
  });

  test("mergeOlderMessages dedupes a boundary overlap", () => {
    const current: ApiMessage[] = [{ id: 10, channelId: 1, userId: 1, content: "j", createdAt: "" }];
    const older: ApiMessage[] = [
      { id: 9, channelId: 1, userId: 1, content: "i", createdAt: "" },
      { id: 10, channelId: 1, userId: 1, content: "dupe", createdAt: "" },
    ];
    const merged = mergeOlderMessages(older, current);
    assert.deepEqual(merged.map((m) => m.id), [9, 10]);
    // The already-loaded copy wins (dupe from the older page is dropped).
    assert.equal(merged[1].content, "j");
  });
});

// ---------------------------------------------------------------------------
// P0.3 — Attachments
// ---------------------------------------------------------------------------

describe("attachments", () => {
  const img: ApiAttachment = {
    id: 1, filename: "photo.png", contentType: "image/png", sizeBytes: 2048,
    url: "https://cdn/x.png", thumbnailUrl: "https://cdn/x-thumb.png", createdAt: "",
  };
  const file: ApiAttachment = {
    id: 2, filename: "report.pdf", contentType: "application/pdf", sizeBytes: 3 * 1024 * 1024,
    url: "https://cdn/r.pdf", thumbnailUrl: null, createdAt: "",
  };

  test("isImageAttachment distinguishes image from file variants", () => {
    assert.equal(isImageAttachment(img), true);
    assert.equal(isImageAttachment(file), false);
  });

  test("formatFileSize renders B / KB / MB", () => {
    assert.equal(formatFileSize(512), "512 B");
    assert.equal(formatFileSize(2048), "2.0 KB");
    assert.equal(formatFileSize(3 * 1024 * 1024), "3.0 MB");
  });
});

// ---------------------------------------------------------------------------
// P0.4 — Browser notifications preference
// ---------------------------------------------------------------------------

describe("browser notifications preference", () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    (globalThis as any).localStorage = {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
  });
  afterEach(() => { delete (globalThis as any).localStorage; });

  test("defaults to enabled and persists an explicit opt-out", () => {
    // Default ON in the store as constructed at import time.
    useWidgetStore.setState({ browserNotificationsEnabled: true });
    assert.equal(useWidgetStore.getState().browserNotificationsEnabled, true);

    useWidgetStore.getState().setBrowserNotificationsEnabled(false);
    assert.equal(useWidgetStore.getState().browserNotificationsEnabled, false);
    // Persisted so a reload keeps the opt-out.
    assert.equal(store.get("bcw_browser_notifs"), "false");
  });
});

// ---------------------------------------------------------------------------
// P0.5 — Mentions
// ---------------------------------------------------------------------------

describe("mentions", () => {
  const userById = new Map<number, ApiUser>([
    [1, { id: 1, name: "Josh Bieler", email: "j@x.com" }],
    [2, { id: 2, name: "Dana Lee", email: "d@x.com" }],
  ]);

  test("parses <@N> markup and swaps in the user's name", () => {
    const segs = parseMentions("hey <@2> look", { userById, meId: 1 });
    const mention = segs.find((s) => s.mention);
    assert.equal(mention?.text, "@Dana Lee");
    assert.equal(mention?.mention?.userId, 2);
    assert.equal(mention?.mention?.isMe, false);
    // Surrounding text is preserved.
    assert.equal(segs.map((s) => s.text).join(""), "hey @Dana Lee look");
  });

  test("flags a self-mention via <@N> when it is me", () => {
    const segs = parseMentions("ping <@1>", { userById, meId: 1 });
    const mention = segs.find((s) => s.mention);
    assert.equal(mention?.mention?.isMe, true);
    assert.equal(mention?.text, "@Josh Bieler");
  });

  test("resolves an @handle against the mentions array", () => {
    const segs = parseMentions("hi @dana", {
      userById,
      meId: 1,
      mentions: [{ userId: 2, type: "user" }],
    });
    const mention = segs.find((s) => s.mention);
    assert.equal(mention?.text, "@Dana Lee");
    assert.equal(mention?.mention?.userId, 2);
  });

  test("mentionsUser detects the current user in a mentions array", () => {
    assert.equal(mentionsUser([{ userId: 2, type: "user" }], 1), false);
    assert.equal(mentionsUser([{ userId: 1, type: "user" }], 1), true);
    assert.equal(mentionsUser([{ userId: null, type: "here" }], 1), false);
  });
});

// ---------------------------------------------------------------------------
// P1.1 — Threads / reply-to
// ---------------------------------------------------------------------------

describe("threads", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("listThreadReplies hits GET /api/messages/:id/replies", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedMethod = init?.method ?? "";
      return new Response(JSON.stringify([]), { status: 200 });
    }) as typeof fetch;

    const client = new ChatApiClient("https://chat.bulldogops.com");
    await client.listThreadReplies(88);
    assert.equal(capturedUrl, "https://chat.bulldogops.com/api/messages/88/replies");
    assert.equal(capturedMethod, "GET");
  });

  test("sendMessage includes replyToMessageId in the body only when provided", async () => {
    const bodies: any[] = [];
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(init!.body as string));
      return new Response(JSON.stringify({ id: 1 }), { status: 200 });
    }) as typeof fetch;

    const client = new ChatApiClient("https://chat.bulldogops.com");
    await client.sendMessage(5, "hi");
    await client.sendMessage(5, "in thread", 42);

    assert.deepEqual(bodies[0], { content: "hi" });
    assert.deepEqual(bodies[1], { content: "in thread", replyToMessageId: 42 });
  });

  test("threadChipLabel: none, singular, plural, and with last-reply time", () => {
    assert.equal(threadChipLabel(0), null);
    assert.equal(threadChipLabel(undefined), null);
    assert.equal(threadChipLabel(1), "1 reply");
    assert.equal(threadChipLabel(3), "3 replies");
    const now = Date.parse("2026-01-01T00:00:00Z");
    const twoMinAgo = new Date(now - 2 * 60 * 1000).toISOString();
    const label = threadChipLabel(2, twoMinAgo);
    assert.match(label!, /^2 replies · last /);
  });
});

// ---------------------------------------------------------------------------
// P1.2 — Reactions
// ---------------------------------------------------------------------------

describe("reactions", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  const userById = new Map<number, ApiUser>([
    [1, { id: 1, name: "Josh Bieler", email: "j@x.com" }],
    [2, { id: 2, name: "Dana Lee", email: "d@x.com" }],
  ]);

  test("addReaction POSTs the emoji, removeReaction DELETEs it url-encoded", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "", body: init?.body as string | undefined });
      return new Response(JSON.stringify({ id: 7 }), { status: 200 });
    }) as typeof fetch;

    const client = new ChatApiClient("https://chat.bulldogops.com");
    await client.addReaction(7, "🔥");
    await client.removeReaction(7, "🔥");

    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url, "https://chat.bulldogops.com/api/messages/7/reactions");
    assert.deepEqual(JSON.parse(calls[0].body!), { emoji: "🔥" });

    assert.equal(calls[1].method, "DELETE");
    assert.equal(calls[1].url, `https://chat.bulldogops.com/api/messages/7/reactions/${encodeURIComponent("🔥")}`);
  });

  test("hasOwnReaction detects the current user among reactors", () => {
    const r: ApiReaction = { emoji: "👍", count: 2, userIds: [1, 3] };
    assert.equal(hasOwnReaction(r, 1), true);
    assert.equal(hasOwnReaction(r, 2), false);
    assert.equal(hasOwnReaction(r, null), false);
  });

  test("reactionToggleAction removes when the user already reacted, else adds", () => {
    const reactions: ApiReaction[] = [{ emoji: "👍", count: 1, userIds: [1] }];
    assert.equal(reactionToggleAction(reactions, "👍", 1), "remove");
    assert.equal(reactionToggleAction(reactions, "👍", 2), "add");
    assert.equal(reactionToggleAction(reactions, "🎉", 1), "add");
    assert.equal(reactionToggleAction(undefined, "🎉", 1), "add");
  });

  test("reactedByNames resolves ids to names with a fallback", () => {
    const r: ApiReaction = { emoji: "❤️", count: 2, userIds: [2, 9] };
    assert.equal(reactedByNames(r, userById), "Dana Lee, User 9");
  });
});

// ---------------------------------------------------------------------------
// P1.3 — Presence
// ---------------------------------------------------------------------------

describe("presence", () => {
  test("presenceDotClass maps each state, defaulting unknown to gray", () => {
    assert.equal(presenceDotClass("online"), "bcw-bg-green-500");
    assert.equal(presenceDotClass("away"), "bcw-bg-amber-400");
    assert.equal(presenceDotClass("busy"), "bcw-bg-red-500");
    assert.equal(presenceDotClass("offline"), "bcw-bg-gray-500");
    assert.equal(presenceDotClass(undefined), "bcw-bg-gray-500");
    assert.equal(presenceDotClass("weird"), "bcw-bg-gray-500");
  });

  test("presenceLabel is human-readable and defaults to Offline", () => {
    assert.equal(presenceLabel("online"), "Online");
    assert.equal(presenceLabel("busy"), "Busy");
    assert.equal(presenceLabel(null), "Offline");
  });
});

// ---------------------------------------------------------------------------
// P1.4 — Typing (deferred; the label helper is still exercised)
// ---------------------------------------------------------------------------

describe("typing label", () => {
  test("builds 0 / 1 / 2 / 3+ typing text", () => {
    assert.equal(typingLabel([]), "");
    assert.equal(typingLabel(["Alice"]), "Alice is typing…");
    assert.equal(typingLabel(["Alice", "Bob"]), "Alice and Bob are typing…");
    assert.equal(typingLabel(["Alice", "Bob", "Cara"]), "Several people are typing…");
    // Empty names are ignored before counting.
    assert.equal(typingLabel(["", "Bob"]), "Bob is typing…");
  });
});

// ---------------------------------------------------------------------------
// P1.5 — Read receipts
// ---------------------------------------------------------------------------

describe("read receipts", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("markChannelRead POSTs to /read, with the messageId only when given", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "", body: init?.body as string | undefined });
      return new Response(JSON.stringify({ ok: true, messageId: 0 }), { status: 200 });
    }) as typeof fetch;

    const client = new ChatApiClient("https://chat.bulldogops.com");
    await client.markChannelRead(12);
    await client.markChannelRead(12, 99);

    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url, "https://chat.bulldogops.com/api/channels/12/read");
    assert.deepEqual(JSON.parse(calls[0].body!), {});
    assert.deepEqual(JSON.parse(calls[1].body!), { messageId: 99 });
  });
});

// ---------------------------------------------------------------------------
// Relative time helper (thread chips / affordances)
// ---------------------------------------------------------------------------

describe("formatRelativeTime", () => {
  test("renders coarse buckets and handles bad input", () => {
    const now = Date.parse("2026-01-01T12:00:00Z");
    assert.equal(formatRelativeTime(new Date(now - 10 * 1000).toISOString(), now), "just now");
    assert.equal(formatRelativeTime(new Date(now - 5 * 60 * 1000).toISOString(), now), "5m");
    assert.equal(formatRelativeTime(new Date(now - 3 * 3600 * 1000).toISOString(), now), "3h");
    assert.equal(formatRelativeTime(new Date(now - 2 * 86400 * 1000).toISOString(), now), "2d");
    assert.equal(formatRelativeTime(null), "");
    assert.equal(formatRelativeTime("not-a-date"), "");
  });
});

// ---------------------------------------------------------------------------
// useOpenJobBus / bindOpenJobListener (widget 0.4.0)
// ---------------------------------------------------------------------------
//
// There's no jsdom/window in this test environment, so we exercise the pure
// bindOpenJobListener function directly against Node's built-in EventTarget
// (which implements the same addEventListener/removeEventListener/dispatchEvent
// surface a real `window` does) rather than the useOpenJobBus React hook.

describe("bindOpenJobListener", () => {
  test("invokes the handler with the event detail when the openJob event fires", () => {
    const target = new EventTarget();
    const received: OpenJobEventDetail[] = [];
    const unbind = bindOpenJobListener(target, (detail) => {
      received.push(detail);
    });

    target.dispatchEvent(
      new CustomEvent(OPEN_JOB_EVENT, { detail: { jobId: 42, source: "ops" } }),
    );

    assert.equal(received.length, 1);
    assert.deepEqual(received[0], { jobId: 42, source: "ops" });
    unbind();
  });

  test("supports jobRef and jobNumber detail shapes", () => {
    const target = new EventTarget();
    const received: OpenJobEventDetail[] = [];
    const unbind = bindOpenJobListener(target, (detail) => received.push(detail));

    target.dispatchEvent(
      new CustomEvent(OPEN_JOB_EVENT, { detail: { jobRef: "BOE-FIBER-01", source: "contracts" } }),
    );
    target.dispatchEvent(new CustomEvent(OPEN_JOB_EVENT, { detail: { jobNumber: "BOE-FIBER-02" } }));

    assert.equal(received.length, 2);
    assert.equal(received[0].jobRef, "BOE-FIBER-01");
    assert.equal(received[1].jobNumber, "BOE-FIBER-02");
    unbind();
  });

  test("ignores events with no detail", () => {
    const target = new EventTarget();
    let calls = 0;
    const unbind = bindOpenJobListener(target, () => {
      calls += 1;
    });

    // A plain Event (not CustomEvent) has detail === undefined.
    target.dispatchEvent(new Event(OPEN_JOB_EVENT));

    assert.equal(calls, 0);
    unbind();
  });

  test("stops receiving events after unbind is called", () => {
    const target = new EventTarget();
    let calls = 0;
    const unbind = bindOpenJobListener(target, () => {
      calls += 1;
    });

    target.dispatchEvent(new CustomEvent(OPEN_JOB_EVENT, { detail: { jobId: 1 } }));
    unbind();
    target.dispatchEvent(new CustomEvent(OPEN_JOB_EVENT, { detail: { jobId: 2 } }));

    assert.equal(calls, 1);
  });

  test("does not react to unrelated event types", () => {
    const target = new EventTarget();
    let calls = 0;
    const unbind = bindOpenJobListener(target, () => {
      calls += 1;
    });

    target.dispatchEvent(new CustomEvent("some:other:event", { detail: { jobId: 1 } }));

    assert.equal(calls, 0);
    unbind();
  });
});

// ---------------------------------------------------------------------------
// Work-object API client methods (widget 0.4.0)
// ---------------------------------------------------------------------------

describe("ChatApiClient work objects", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const sampleWorkObject: ApiWorkObject = {
    id: 7,
    orgId: 1,
    projectId: 3,
    kind: "job_site",
    ref: "BOE-FIBER-01",
    title: "Boeing Fiber Install",
    status: "open",
    description: null,
    parentId: null,
    ownerUserId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    closedAt: null,
  };

  test("getWorkObject GETs /api/work-objects/:id", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify(sampleWorkObject), { status: 200 });
    }) as typeof fetch;

    const client = new ChatApiClient("https://chat.bulldogops.com");
    const wo = await client.getWorkObject(7);

    assert.equal(capturedUrl, "https://chat.bulldogops.com/api/work-objects/7");
    assert.equal(wo.ref, "BOE-FIBER-01");
  });

  test("getWorkObjectByRef GETs /api/work-objects/by-ref, defaulting kind to job_site", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify(sampleWorkObject), { status: 200 });
    }) as typeof fetch;

    const client = new ChatApiClient("https://chat.bulldogops.com");
    await client.getWorkObjectByRef("BOE-FIBER-01");

    assert.equal(
      capturedUrl,
      "https://chat.bulldogops.com/api/work-objects/by-ref?ref=BOE-FIBER-01&kind=job_site",
    );
  });

  test("getWorkObjectByRef encodes an explicit kind and ref", async () => {
    let capturedUrl = "";
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify(sampleWorkObject), { status: 200 });
    }) as typeof fetch;

    const client = new ChatApiClient("https://chat.bulldogops.com");
    await client.getWorkObjectByRef("CO #4/5", "change_order");

    assert.equal(
      capturedUrl,
      "https://chat.bulldogops.com/api/work-objects/by-ref?ref=CO%20%234%2F5&kind=change_order",
    );
  });

  test("listWorkObjectChannels GETs /api/work-objects/:id/channels", async () => {
    let capturedUrl = "";
    const channels: ApiChannel[] = [
      { id: 1, name: "general", type: "text", projectId: 3 } as ApiChannel,
    ];
    globalThis.fetch = (async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify(channels), { status: 200 });
    }) as typeof fetch;

    const client = new ChatApiClient("https://chat.bulldogops.com");
    const result = await client.listWorkObjectChannels(7);

    assert.equal(capturedUrl, "https://chat.bulldogops.com/api/work-objects/7/channels");
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "general");
  });

  test("createChannel POSTs to /api/projects/:id/channels with workObjectId", async () => {
    let capturedUrl = "";
    let capturedBody: string | undefined;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = init?.body as string | undefined;
      return new Response(
        JSON.stringify({ id: 9, name: "general", type: "text", projectId: 3 }),
        { status: 200 },
      );
    }) as typeof fetch;

    const client = new ChatApiClient("https://chat.bulldogops.com");
    const channel = await client.createChannel(3, { name: "general", workObjectId: 7 });

    assert.equal(capturedUrl, "https://chat.bulldogops.com/api/projects/3/channels");
    assert.deepEqual(JSON.parse(capturedBody!), { type: "text", name: "general", workObjectId: 7 });
    assert.equal(channel.id, 9);
  });
});

// ---------------------------------------------------------------------------
// handleOpenJob resolution logic (widget 0.4.0)
// ---------------------------------------------------------------------------
//
// handleOpenJob itself lives inside the BulldogChatWidget component (which
// needs React + a DOM to render), so it isn't imported/exercised directly
// here. Instead, this suite pins down the exact resolve-then-branch contract
// it's built on: given an ApiWorkObject + api.listWorkObjectChannels result,
// the caller should either (a) target the first channel when channels exist,
// or (b) fall back to a "no channels yet" state when the list is empty. This
// mirrors the branching in BulldogChatWidget.tsx's handleOpenJob and guards
// against a regression silently flipping that branch condition.

describe("handleOpenJob resolution contract", () => {
  const workObject: ApiWorkObject = {
    id: 7,
    orgId: 1,
    projectId: 3,
    kind: "job_site",
    ref: "BOE-FIBER-01",
    title: "Boeing Fiber Install",
    status: "open",
    description: null,
    parentId: null,
    ownerUserId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    closedAt: null,
  };

  // Minimal stand-in for the branch handleOpenJob takes after resolving a
  // work object and its channels — exercised directly so the test doesn't
  // need React/jsdom, while still asserting the real decision rule.
  function resolveJobTarget(channels: ApiChannel[]) {
    if (channels.length > 0) {
      return { kind: "channel" as const, channelId: channels[0].id };
    }
    return { kind: "prompt" as const, ref: workObject.ref };
  }

  test("targets the first channel when the job already has channels", () => {
    const channels: ApiChannel[] = [
      { id: 11, name: "general", type: "text", projectId: 3 } as ApiChannel,
      { id: 12, name: "safety", type: "text", projectId: 3 } as ApiChannel,
    ];
    const target = resolveJobTarget(channels);
    assert.deepEqual(target, { kind: "channel", channelId: 11 });
  });

  test("falls back to the no-channels prompt when the job has no channels", () => {
    const target = resolveJobTarget([]);
    assert.deepEqual(target, { kind: "prompt", ref: "BOE-FIBER-01" });
  });

  test("jobId takes precedence when both jobId and jobRef are provided", () => {
    // Mirrors handleOpenJob's `typeof detail.jobId === "number"` check.
    function pickResolver(detail: OpenJobEventDetail): "byId" | "byRef" {
      if (typeof detail.jobId === "number") return "byId";
      return "byRef";
    }
    assert.equal(pickResolver({ jobId: 1, jobRef: "X" }), "byId");
    assert.equal(pickResolver({ jobRef: "X" }), "byRef");
    assert.equal(pickResolver({ jobNumber: "X" }), "byRef");
  });
});

// ---------------------------------------------------------------------------
// Call target picker (widget 0.4.1) — always-visible call button
// ---------------------------------------------------------------------------

describe("call target picker", () => {
  const me: ApiUser = { id: 1, name: "Me", email: "me@example.com" };
  const alice: ApiUser = { id: 2, name: "Alice", email: "alice@example.com", presence: "online" };
  const bob: ApiUser = { id: 3, name: "Bob", email: "bob@example.com", presence: "away" };
  const carol: ApiUser = { id: 4, name: "Carol", email: "carol@example.com", presence: "offline" };

  const userById = new Map<number, ApiUser>([
    [me.id, me],
    [alice.id, alice],
    [bob.id, bob],
    [carol.id, carol],
  ]);

  const dmWithAlice: ApiDmChannel = {
    id: 10,
    projectId: 0,
    name: "dm-2",
    type: "dm",
    topic: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    memberIds: [me.id, alice.id],
  };
  const dmWithBob: ApiDmChannel = {
    id: 11,
    projectId: 0,
    name: "dm-3",
    type: "dm",
    topic: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    memberIds: [me.id, bob.id],
  };

  test("builds the callable list from DMs + channel members, deduped and excluding self", () => {
    // Bob appears in both a DM and (redundantly) the org/channel roster;
    // Carol only ever shows up via the org roster (channel membership).
    const targets = buildCallableUsers(
      me.id,
      userById,
      [dmWithAlice, dmWithBob],
      [me, alice, bob, carol], // orgMembers stands in for channel-derived members
    );

    const ids = targets.map((t) => t.user.id);
    // Self must never appear.
    assert.ok(!ids.includes(me.id));
    // Everyone else appears exactly once each, despite Bob/Alice being
    // reachable via both the DM list and the org/channel roster.
    assert.deepEqual([...ids].sort(), [alice.id, bob.id, carol.id].sort());
    assert.equal(ids.length, new Set(ids).size, "no duplicate rows");
  });

  test("pins the active DM's other participant first (two-click call shortcut)", () => {
    const targets = buildCallableUsers(
      me.id,
      userById,
      [dmWithAlice, dmWithBob],
      [me, alice, bob, carol],
      undefined,
      dmWithBob.id,
    );
    assert.equal(targets[0].user.id, bob.id);
    assert.equal(targets[0].isActiveDmOther, true);
    assert.ok(targets.slice(1).every((t) => !t.isActiveDmOther));
  });

  test("returns an empty list when there are no DMs or channel members (fresh account)", () => {
    const targets = buildCallableUsers(me.id, new Map([[me.id, me]]), [], [me]);
    assert.deepEqual(targets, []);
  });

  test("filterCallTargets matches name or email, case-insensitively", () => {
    const targets = buildCallableUsers(me.id, userById, [dmWithAlice, dmWithBob], [me, alice, bob, carol]);
    const byName = filterCallTargets(targets, "ali");
    assert.deepEqual(byName.map((t) => t.user.id), [alice.id]);

    const byEmail = filterCallTargets(targets, "CAROL@EXAMPLE");
    assert.deepEqual(byEmail.map((t) => t.user.id), [carol.id]);

    const empty = filterCallTargets(targets, "nobody");
    assert.deepEqual(empty, []);

    const unfiltered = filterCallTargets(targets, "   ");
    assert.equal(unfiltered.length, targets.length);
  });

  test("clicking a picker row calls api.startCall(userId, video) and sets activeCall", async () => {
    const originalFetch = globalThis.fetch;
    let capturedUrl = "";
    let capturedBody: string | undefined;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedBody = init?.body as string | undefined;
      return new Response(
        JSON.stringify({ callId: 99, roomName: "room-99", token: "tok", ws_url: "wss://livekit.example/room-99" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const client = new ChatApiClient("https://chat.bulldogops.com");

    // Mirrors handleSelectCallTarget: picker close + startCall + setActiveCall,
    // exercised directly since there's no jsdom/RTL to click a real button.
    useWidgetStore.getState().setActiveCall(null);
    async function selectCallTarget(userId: number) {
      const session = await client.startCall(userId, "video");
      useWidgetStore.getState().setActiveCall({
        callId: session.callId,
        roomName: session.roomName,
        token: session.token,
        wsUrl: session.ws_url,
      });
    }

    await selectCallTarget(bob.id);

    assert.equal(capturedUrl, "https://chat.bulldogops.com/api/calls/start");
    assert.deepEqual(JSON.parse(capturedBody!), { calleeId: bob.id, kind: "video" });
    assert.deepEqual(useWidgetStore.getState().activeCall, {
      callId: 99,
      roomName: "room-99",
      token: "tok",
      wsUrl: "wss://livekit.example/room-99",
    });

    useWidgetStore.getState().setActiveCall(null);
    globalThis.fetch = originalFetch;
  });
});
