# Changelog

All notable changes to `@vectordev2001/chat-widget` are documented here.

## 0.4.2

In-call device picker: a gear icon in the call controls opens a small popover
to choose camera, microphone, and speaker, applied immediately and persisted
across calls. Patch bump: additive UI, no breaking API changes.

- New gear button (`data-testid="bulldog-chat-widget-device-gear"`) sits in
  `CallRoomInner`'s controls bar next to the mic/camera toggles. Clicking it
  opens an upward-anchored popover (`bulldog-chat-widget-device-menu`) with
  three native `<select>` dropdowns — Camera, Microphone, Speaker
  (`bulldog-chat-widget-device-select-camera|mic|speaker`) — closable via
  outside click or ESC and fully keyboard-operable.
- Camera and microphone selections apply immediately via LiveKit's
  `room.switchActiveDevice("videoinput" | "audioinput", deviceId)` (reached
  through `@livekit/components-react`'s `useRoomContext()` — in the installed
  livekit-client this method lives on the `Room` instance rather than
  `LocalParticipant`). Speaker selection calls `.setSinkId(deviceId)` on the
  `<audio>` elements rendered by `RoomAudioRenderer`, re-applied via a
  `MutationObserver` as remote participants join.
- `setSinkId` is Chromium/Edge only today (partial in Safari macOS 13+, absent
  in Firefox). When unsupported, the Speaker dropdown is disabled with a
  "Speaker selection not supported in this browser." tooltip instead of
  silently no-op'ing.
- Device lists come from `navigator.mediaDevices.enumerateDevices()`, refreshed
  on the `devicechange` event; devices with no label yet (permission not
  granted) show as "Device N".
- New `useDevicePreferences` hook persists the chosen deviceIds to
  localStorage under `bulldog-chat-widget:devicePrefs` — `{ videoInput?,
  audioInput?, audioOutput? }` — and re-applies them once after connecting to
  a new call. A stored deviceId that no longer exists in the current
  enumeration is dropped back to system default rather than erroring.
- Preserves PR #101's audio primitives (`RoomAudioRenderer`, `StartAudio`,
  `useRingtone`) and 0.4.1's always-visible call button + call-target picker
  untouched.

## 0.4.1

The header call button is now always visible instead of only appearing while
a 1:1 DM is active — clicking it opens a small "who do you want to call?"
picker instead of always calling the current DM's other participant. Patch
bump: no breaking API changes, same `api.startCall(userId, "video")` call on
the wire.

- The call button (`data-testid="bulldog-chat-widget-call-btn"`) shows
  whenever the widget panel is open and there's no active call — no longer
  gated on `activeDm`. It's reachable even before any conversation is
  selected.
- Clicking it opens a floating popover (`bulldog-chat-widget-call-btn-picker`)
  listing everyone callable: the user's DMs plus everyone reachable via
  channel membership, deduplicated and with the caller excluded. Longer
  lists get a text filter; a fresh account with nobody to call shows an
  empty state ("No one to call yet").
- If a 1:1 DM is the active conversation when the picker opens, that DM's
  other participant is pinned at the top of the list (a two-click call is
  still fast) — selecting them is still an explicit click, not an
  auto-call.
- Selecting a row dispatches the same `api.startCall(userId, "video")` call
  the old DM-only button used; no server changes.
- New pure helpers in `format.ts`: `buildCallableUsers` (dedup + self-excl +
  DM-shortcut ordering) and `filterCallTargets` (case-insensitive name/email
  filter), both covered by new tests.

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
