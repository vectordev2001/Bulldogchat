/**
 * Publish the central Bulldog auth JWT to the native iOS shell.
 *
 * Centralization model (see bulldog-auth PR #11/#12):
 *   1. The native iOS shell registers ALL push devices against
 *      https://auth.bulldogops.com/api/devices — not per-app endpoints.
 *   2. Auth issues an RS256 access JWT that every Bulldog app already
 *      trusts (SSO). We fetch that JWT from
 *      https://auth.bulldogops.com/api/auth/token (credentials:include so
 *      the shared `bulldog_access` cookie on `.bulldogops.com`
 *      authenticates) and hand it to Swift via
 *      __BULLDOG__.reportJwt(app, jwt).
 *   3. The `app` slug tags the device row so admins can fire a per-app
 *      test push from the auth admin UI (auth.bulldogops.com/notifications).
 *
 * Called once from AuthProvider whenever an authenticated session lands
 * (fresh login OR /api/auth/me returning a user on app boot). Safe to call
 * repeatedly — no-op in browser (no __BULLDOG__), and auth reissues a
 * full-TTL access token each time.
 */

const AUTH_TOKEN_URL = "https://auth.bulldogops.com/api/auth/token";
const DIAG_URL = "https://auth.bulldogops.com/api/ios-diag";

/**
 * Best-effort SPA-side diagnostic ping. Mirrors ios/App/App/ApnsRegistrar.swift's
 * `diag()` — same endpoint, same shape — so we can see the browser-side branch
 * as easily as the native-side branch in Render logs. Never throws, never blocks.
 * Adds `spa=<slug>` to `extra` so entries are easy to grep.
 */
function spaDiag(event: string, appSlug: string, extra?: Record<string, unknown>): void {
  try {
    const body = {
      event,
      app: appSlug,
      extra: JSON.stringify({ source: "spa", ...(extra ?? {}) }).slice(0, 200),
    };
    if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
      const blob = new Blob([JSON.stringify(body)], { type: "application/json" });
      navigator.sendBeacon(DIAG_URL, blob);
      return;
    }
    void fetch(DIAG_URL, {
      method: "POST",
      keepalive: true,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // ignore
  }
}

function tail(s: string | null | undefined): string | undefined {
  if (!s || s.length < 8) return s ?? undefined;
  return s.slice(-8);
}

type BulldogBridge = {
  reportJwt?: (app: string, jwt: string) => void | Promise<void>;
};

function getBridge(): BulldogBridge | null {
  if (typeof window === "undefined") return null;
  const b = (window as unknown as { __BULLDOG__?: BulldogBridge }).__BULLDOG__;
  return b && typeof b.reportJwt === "function" ? b : null;
}

/**
 * Wait up to ~10s for the native bridge to appear on window. On real device
 * (iOS 1015+), the WKUserScript that installs __BULLDOG__ runs at
 * .atDocumentStart, which normally beats React by a wide margin. But we've
 * observed races in production where the SPA fires before the injection lands,
 * so we poll for up to 10s (100ms intervals) with exponential backoff before
 * conceding. Returns null in normal browsers where the bridge never appears.
 */
async function waitForBridge(): Promise<BulldogBridge | null> {
  const immediate = getBridge();
  if (immediate) return immediate;
  if (typeof window === "undefined") return null;
  // Only poll when we have some signal that we're inside a native shell — i.e.
  // window.webkit is present (WKWebView). In a plain browser this bails fast
  // and returns null, which the caller handles correctly.
  const w = window as unknown as { webkit?: unknown };
  if (!w.webkit) return null;
  const deadline = Date.now() + 10_000;
  let delay = 100;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, delay));
    const b = getBridge();
    if (b) return b;
    // Backoff: 100, 150, 225, 337, 500, 500, 500...
    delay = Math.min(500, Math.round(delay * 1.5));
  }
  return null;
}

/**
 * Fetch the central Bulldog auth JWT and hand it to the native iOS shell.
 * `appSlug` MUST match the values Swift's ApnsRegistrar KNOWN_APPS knows:
 * "chat" | "contracts" | "ops".
 */
export async function publishAuthJwtToNative(appSlug: string): Promise<void> {
  const w = typeof window !== "undefined"
    ? (window as unknown as { __BULLDOG__?: unknown; webkit?: unknown })
    : ({} as { __BULLDOG__?: unknown; webkit?: unknown });
  const immediateBridge = getBridge();
  console.info(
    "[push-bridge] publishAuthJwtToNative",
    "app=", appSlug,
    "bridge=", !!immediateBridge,
    "hasBULLDOG=", typeof w.__BULLDOG__,
    "hasWebkit=", typeof w.webkit,
  );
  spaDiag("spa.publishAuthJwtToNative.begin", appSlug, {
    hasBridge: !!immediateBridge,
    hasBULLDOG: typeof w.__BULLDOG__,
    hasWebkit: typeof w.webkit,
  });

  // Fetch the central auth JWT. `credentials:include` sends the shared
  // `.bulldogops.com` bulldog_access cookie so auth can identify the user.
  // On a browser without a valid auth session this 401s harmlessly.
  let token: string | null = null;
  try {
    const res = await fetch(AUTH_TOKEN_URL, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) {
      console.warn("[push-bridge] auth /api/auth/token ->", res.status);
      spaDiag("spa.authToken.notOk", appSlug, { httpStatus: res.status });
      return;
    }
    const json = (await res.json()) as { token?: string };
    token = json.token ?? null;
  } catch (err) {
    console.warn("[push-bridge] failed to fetch central auth JWT", err);
    spaDiag("spa.authToken.fetchError", appSlug, { error: String(err).slice(0, 120) });
    return;
  }
  if (!token) {
    console.warn("[push-bridge] auth /api/auth/token returned no token");
    spaDiag("spa.authToken.emptyToken", appSlug);
    return;
  }
  // If the bridge wasn't present at flow entry, wait up to 10s for it to
  // appear — covers a race where the SPA boots before the WKUserScript that
  // installs __BULLDOG__ has finished. In a plain browser this bails fast.
  const bridge = immediateBridge ?? (await waitForBridge());
  if (!bridge?.reportJwt) {
    console.info("[push-bridge] no native bridge — skipping (normal in browser)");
    spaDiag("spa.publishAuthJwtToNative.noBridge", appSlug, {
      jwtTail: tail(token),
      hasBULLDOG: typeof w.__BULLDOG__,
      polled: !immediateBridge,
    });
    return;
  }
  if (!immediateBridge) {
    spaDiag("spa.publishAuthJwtToNative.bridgeAppearedAfterPolling", appSlug);
  }
  try {
    await bridge.reportJwt(appSlug, token);
    console.info("[push-bridge] central JWT published to native bridge for", appSlug);
    spaDiag("spa.publishAuthJwtToNative.called", appSlug, { jwtTail: tail(token) });
  } catch (err) {
    console.warn("[push-bridge] bridge.reportJwt threw", err);
    spaDiag("spa.publishAuthJwtToNative.threw", appSlug, { error: String(err).slice(0, 120) });
  }
}

/**
 * Sign-out helper: tell native to drop the stored JWT for this app so
 * ApnsRegistrar won't retry POST /api/devices until we sign back in.
 * Fire-and-forget.
 */
export function clearAuthJwtOnNative(appSlug: string): void {
  const bridge = getBridge();
  if (!bridge?.reportJwt) return;
  try {
    // Empty JWT is the sentinel Swift interprets as "signed out for this app".
    void bridge.reportJwt(appSlug, "");
  } catch {
    // ignore
  }
}
