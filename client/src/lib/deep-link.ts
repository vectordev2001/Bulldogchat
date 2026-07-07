/**
 * Deep-link URL parsing for the Bulldog SPA.
 *
 * We support two entrypoints for landing directly on a channel:
 *   (a) `?channel=<id>` — flat query param on the base path. Used by the
 *       Contracts "Create chat meeting" button and other in-app deep links
 *       that fire while the SPA is already loaded.
 *   (b) `/#/channels/<id>?call=<roomName>` — hash-path with an optional
 *       ?call query. Emitted by the server-side push notifications for
 *       group calls (server/routes.ts) so tapping the push opens the
 *       channel chat AND surfaces the "Join call" banner in one gesture.
 *
 * Both forms are parsed into the same shape so the Home.tsx effect only
 * has one code path to run. The functions are pure and take a URL string
 * rather than reading `window.location` directly, which lets us unit-test
 * them in a plain Node process without JSDOM.
 */
export interface DeepLink {
  channelId: number;
  /** Non-null only for form (b): the LiveKit room name from ?call=. */
  callRoom: string | null;
}

/** Cheap yes/no probe used to gate the deep-link `useEffect`. */
export function hasDeepLink(href: string): boolean {
  return parseDeepLink(href) !== null;
}

/**
 * Parse either form (a) or form (b). Returns null when neither is present
 * or when the channel id isn't a positive integer.
 *
 * The hash path is parsed manually because the URL API drops everything
 * after `#` into a single opaque `hash` string — we have to re-split it
 * ourselves to extract the hash's path segment and its ?query.
 */
export function parseDeepLink(href: string): DeepLink | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  // Form (a): ?channel=<id> on the top-level query.
  const flat = url.searchParams.get("channel");
  if (flat != null) {
    const n = Number(flat);
    if (Number.isFinite(n) && n > 0) {
      return { channelId: n, callRoom: null };
    }
  }

  // Form (b): /#/channels/<id>?call=<room>
  // url.hash is `#/channels/42?call=group-channel-42-abc` — strip the leading
  // `#` and split into pathname + search.
  const rawHash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  if (rawHash.startsWith("/channels/")) {
    const qIdx = rawHash.indexOf("?");
    const hashPath = qIdx >= 0 ? rawHash.slice(0, qIdx) : rawHash;
    const hashQuery = qIdx >= 0 ? rawHash.slice(qIdx + 1) : "";
    const idPart = hashPath.slice("/channels/".length);
    // Guard against trailing segments — we only want the immediate id.
    const idStr = idPart.split("/")[0];
    const n = Number(idStr);
    if (Number.isFinite(n) && n > 0) {
      const params = new URLSearchParams(hashQuery);
      const callRoom = params.get("call");
      return { channelId: n, callRoom: callRoom && callRoom.length > 0 ? callRoom : null };
    }
  }

  return null;
}

/**
 * After the deep-link handler has resolved, strip both the flat
 * `?channel=` param and the hash-path form so a refresh doesn't
 * re-apply the deep link. Uses `history.replaceState` so we don't
 * add a spurious history entry.
 *
 * Written to be safe in test / SSR contexts where `window` is undefined.
 */
export function stripDeepLinkFromUrl(): void {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    let mutated = false;
    if (url.searchParams.has("channel")) {
      url.searchParams.delete("channel");
      mutated = true;
    }
    // Collapse /#/channels/<id> back to `#/` so we don't re-trigger on refresh.
    // If the hash-path had a ?call= query, we drop that too (the banner state
    // is already stashed in React state by this point).
    const rawHash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
    if (rawHash.startsWith("/channels/")) {
      url.hash = "#/";
      mutated = true;
    }
    if (mutated) {
      window.history.replaceState({}, "", url.toString());
    }
  } catch {
    /* best-effort — never throw from a UI helper */
  }
}
