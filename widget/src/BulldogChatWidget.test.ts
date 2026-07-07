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
import { ChatApiClient, ApiError } from "./api";
import { ChatSyncBridge, SYNC_CHANNEL_NAME, LAST_CONVERSATION_KEY } from "./sync";
import { useWidgetStore } from "./state";

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
