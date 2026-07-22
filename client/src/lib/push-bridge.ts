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

type BulldogBridge = {
  reportJwt?: (app: string, jwt: string) => void | Promise<void>;
};

function getBridge(): BulldogBridge | null {
  if (typeof window === "undefined") return null;
  const b = (window as unknown as { __BULLDOG__?: BulldogBridge }).__BULLDOG__;
  return b && typeof b.reportJwt === "function" ? b : null;
}

/**
 * Fetch the central Bulldog auth JWT and hand it to the native iOS shell.
 * `appSlug` MUST match the values Swift's ApnsRegistrar KNOWN_APPS knows:
 * "chat" | "contracts" | "ops".
 */
export async function publishAuthJwtToNative(appSlug: string): Promise<void> {
  const bridge = getBridge();
  const w = typeof window !== "undefined"
    ? (window as unknown as { __BULLDOG__?: unknown; webkit?: unknown })
    : ({} as { __BULLDOG__?: unknown; webkit?: unknown });
  console.info(
    "[push-bridge] publishAuthJwtToNative",
    "app=", appSlug,
    "bridge=", !!bridge,
    "hasBULLDOG=", typeof w.__BULLDOG__,
    "hasWebkit=", typeof w.webkit,
  );

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
      return;
    }
    const json = (await res.json()) as { token?: string };
    token = json.token ?? null;
  } catch (err) {
    console.warn("[push-bridge] failed to fetch central auth JWT", err);
    return;
  }
  if (!token) {
    console.warn("[push-bridge] auth /api/auth/token returned no token");
    return;
  }
  if (!bridge?.reportJwt) {
    console.info("[push-bridge] no native bridge — skipping (normal in browser)");
    return;
  }
  try {
    await bridge.reportJwt(appSlug, token);
    console.info("[push-bridge] central JWT published to native bridge for", appSlug);
  } catch (err) {
    console.warn("[push-bridge] bridge.reportJwt threw", err);
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
