/**
 * Detect whether the web client is running inside the Bulldog native iOS
 * shell (a custom WKWebView host — see bulldog-ios WebTabViewController.swift)
 * rather than a regular mobile browser or an in-app browser (Slack, Mail…).
 *
 * Why this is not just `Capacitor.isNativePlatform()`:
 *   The iOS shell does NOT load chat.bulldogops.com through Capacitor's
 *   CAPBridgeViewController. It uses a bespoke WKWebView per tab, so
 *   `window.Capacitor` is never injected into this page and
 *   `Capacitor.isNativePlatform()` is unavailable here. We therefore detect
 *   the shell by the signals it actually exposes inside each WebView:
 *
 *     1. `window.bulldog` — the native bridge object the shell injects at
 *        document-start (it has `.tab`, `.switchTab`, etc.).
 *     2. UA marker — the shell sets
 *        `applicationNameForUserAgent = "BulldogOpsSuite/0.1 (iOS)"`, so the
 *        navigator UA contains "BulldogOpsSuite".
 *     3. `window.bulldogNative === true` and `Capacitor.isNativePlatform()`
 *        are kept as forward-compatible fallbacks in case the shell starts
 *        injecting either explicitly.
 *
 * Any one signal is sufficient — they are OR'd defensively so a future shell
 * tweak that drops one marker doesn't silently break detection.
 */
export function isNativeApp(): boolean {
  if (typeof window === "undefined") return false;

  const w = window as unknown as {
    bulldog?: { tab?: string };
    bulldogNative?: boolean;
    Capacitor?: { isNativePlatform?: () => boolean };
  };

  // Explicit native flag (forward-compatible — not currently set by the shell).
  if (w.bulldogNative === true) return true;

  // Capacitor native-platform check (only present if the page is ever loaded
  // through a Capacitor bridge WebView).
  if (typeof w.Capacitor?.isNativePlatform === "function" && w.Capacitor.isNativePlatform()) {
    return true;
  }

  // Native bridge object injected by the iOS shell into every chat WebView.
  if (w.bulldog && typeof w.bulldog.tab === "string") return true;

  // User-Agent marker set via applicationNameForUserAgent in the iOS shell.
  if (typeof navigator !== "undefined" && /BulldogOpsSuite|BulldogNative/i.test(navigator.userAgent)) {
    return true;
  }

  return false;
}

/**
 * Best-effort "open this meeting in the native Bulldog iOS app". There is no
 * reliable web API to detect whether the app is installed, so we just point
 * the browser at the bulldogchat:// scheme: if the app is installed iOS
 * switches to it; if not, nothing happens and the user stays on the page
 * (the in-app-browser banner remains visible as the fallback).
 */
export function openInIosApp(joinUrl: string): void {
  const appUrl = `bulldogchat://join?url=${encodeURIComponent(joinUrl)}`;
  window.location.href = appUrl;
}
