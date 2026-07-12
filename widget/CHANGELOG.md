# Changelog

All notable changes to `@vectordev2001/chat-widget` are documented here.

## 0.4.0

Expand-to-fullscreen, pop-out, and a cross-app job bus so bulldog-ops and
bulldog-contracts can drive the widget straight to a job's channel. Minor
bump for new, user-visible capabilities.

- Expand-to-fullscreen: a new header button grows the panel to cover the
  whole viewport (reusing the existing mobile "fixed inset-0" CSS path), with
  a restore button to collapse back to the floating panel. Hidden on mobile,
  where the panel is already fullscreen.
- Pop-out: a new header button opens the full Chat app in a new tab
  (`chatAppUrl` prop, defaulting to `apiBaseUrl`).
- Cross-app openJob bus: a `useOpenJobBus` hook listens for a
  `bulldog:widget:openJob` CustomEvent on `window` (dispatched by host pages
  with `{ jobId | jobRef | jobNumber, source }`). The widget opens, resolves
  the job (via the new `GET /api/work-objects/by-ref` endpoint, plus the
  already-existing `GET /api/work-objects/:id` and `:id/channels`), and
  either jumps straight to its first channel or shows a "No channels yet for
  job <ref>" prompt with a "Create #general channel" action.

## 0.3.0

Message-row features that bring the mini widget closer to parity with the full
Chat app. Minor bump for new, user-visible capabilities.

- Threads / reply-to: rows with replies show an "N replies · last <time>" chip
  that opens a right-hand slide-in thread panel (parent + replies + a composer
  scoped to the parent). Every row also gains a hover "Reply in thread" action.
- Reactions: reaction pills render beneath messages; clicking toggles your own
  reaction (own reactions get a distinct red border), hovering shows who
  reacted, and a "+" opens a small fixed emoji palette (no emoji-mart, to keep
  the bundle small). Remote reaction changes refetch via the reaction:change
  SSE event.
- Presence indicators: colored dots (green online, amber away, red busy, gray
  offline) on 1:1 DMs in the sidebar and on the DM header, updated live from the
  presence:change SSE event.
- Read receipts: opening a conversation marks it read immediately, and dwelling
  ~2s scrolled near the bottom marks it read again, throttled to at most once
  per 5s (POST /api/channels/:id/read).
- Typing indicators: deferred. The Chat backend has no typing SSE event or send
  endpoint today, so this ships as a documented no-op placeholder rather than a
  fake indicator.

## 0.2.0

First genuinely usable release: closes all five P0 gaps that stood between the
0.1.x preview and day-to-day use. Minor bump (not patch) because these are new,
user-visible capabilities rather than fixes.

- Group channels tab: the sidebar now has DMs and Channels tabs. Channels are
  loaded per project and the chosen tab is persisted across reopen/reload.
- Message history pagination: scrolling to the top loads the previous page
  (before=/limit=50), with a "Loading older messages…" spinner, double-fetch
  and end-of-history guards, and scroll-position preservation across the append.
- Attachments (read-only): messages render their attachmentsList — image
  previews (thumbnail, click to open full) and file cards with size + download.
  No upload UI yet.
- Browser notifications: a useBrowserNotifications hook plus an opt-in "Enable
  notifications" pill. Notifications fire only for conversations the user is not
  actively reading, are tagged by conversation id so repeats replace rather than
  stack, and focus the widget on click. A browserNotificationsEnabled preference
  is persisted to localStorage.
- @mention rendering + alert: mentions render as highlighted chips (blue for
  others, brand red when the mention includes you). Being mentioned plays a more
  prominent chime and raises a "You were mentioned in …" notification.

## 0.1.4

- Publishing / release-hygiene groundwork (auto-publish workflow, prepublish
  guard, bundle-size budget, CI type-check fixes).
