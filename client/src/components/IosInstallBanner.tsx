/**
 * IosInstallBanner — shows a slim, dismissable banner at the top of the
 * app when the user is on iOS Safari and the app is NOT running in
 * standalone (Add to Home Screen) mode.
 *
 * Why:
 *   The Bulldog Suite is a multi-origin PWA (each app gets its own
 *   standalone install). When the user opens an app inside Safari via
 *   the launcher tile, iOS shows the full address bar + bottom toolbar,
 *   which steals vertical space and makes the call controls feel cramped.
 *   This banner nudges them to install the app to home screen so it
 *   opens full-screen with no Safari chrome.
 *
 * Dismissal is in-memory only (state), not persisted, because the
 * sandboxed-iframe rules block localStorage. The banner reappears each
 * cold-launch from Safari, which is fine — once installed, the
 * standalone check returns true and it never shows again.
 */
import { useEffect, useState } from "react";
import { X, Share } from "lucide-react";

interface Props {
  /** Display name of the app for the banner copy. */
  appName: string;
}

function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  // iOS Safari sets navigator.standalone === true when launched from a
  // home-screen install. Other browsers honor the display-mode media
  // query. Either signal means we're already full-screen — hide the banner.
  // @ts-expect-error — navigator.standalone is iOS-only and not in lib.dom.
  if (window.navigator.standalone === true) return true;
  try {
    return window.matchMedia("(display-mode: standalone)").matches;
  } catch {
    return false;
  }
}

export function IosInstallBanner({ appName }: Props) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // Only mount on iOS Safari outside standalone.
    if (isIos() && !isStandalone()) setVisible(true);
  }, []);

  if (!visible) return null;

  return (
    <div
      className="fixed top-0 left-0 right-0 z-[100] bg-gradient-to-r from-vs-red/90 to-[hsl(218_100%_38%)] text-white text-[12px] px-3 py-2 flex items-center gap-2 border-b border-black/40 shadow-lg"
      data-testid="banner-ios-install"
      style={{ paddingTop: "max(0.5rem, env(safe-area-inset-top))" }}
    >
      <Share className="w-4 h-4 shrink-0" />
      <span className="flex-1 leading-tight">
        Install <b>{appName}</b> on your iPhone: tap <b>Share</b>{" "}
        <span className="font-mono">↑</span> then <b>Add to Home Screen</b> for full-screen
        mode without Safari bars.
      </span>
      <button
        type="button"
        onClick={() => setVisible(false)}
        className="p-1 rounded hover:bg-white/15"
        aria-label="Dismiss"
        data-testid="button-ios-install-dismiss"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
}
