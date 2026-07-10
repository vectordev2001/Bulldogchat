# Changelog

All notable changes to `@vectordev2001/chat-widget` are documented here.

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
