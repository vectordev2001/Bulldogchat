import { useCallback, useEffect, useState } from "react";

// ── useDevicePreferences ─────────────────────────────────────────────────────
// Persists the user's selected camera / microphone / speaker deviceIds to
// localStorage so the device picker (CallView's gear menu) sticks across
// calls and page reloads. Mirrors the localStorage-preference pattern already
// used elsewhere in the widget (see state.ts's pillPosition/activeTab/
// browserNotificationsEnabled and useBrowserNotifications) — read once on
// mount, write through on every change, and never let a storage failure
// (private browsing, quota, SSR) break the caller.

export const DEVICE_PREFS_KEY = "bulldog-chat-widget:devicePrefs";

export interface DevicePrefs {
  videoInput?: string;
  audioInput?: string;
  audioOutput?: string;
}

const EMPTY_PREFS: DevicePrefs = {};

/** Pure helper: parses the raw localStorage value, tolerating missing/ malformed
 * data. Exported for direct testing without needing a DOM/localStorage shim. */
export function parseDevicePrefs(raw: string | null): DevicePrefs {
  if (!raw) return EMPTY_PREFS;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return EMPTY_PREFS;
    const out: DevicePrefs = {};
    if (typeof parsed.videoInput === "string") out.videoInput = parsed.videoInput;
    if (typeof parsed.audioInput === "string") out.audioInput = parsed.audioInput;
    if (typeof parsed.audioOutput === "string") out.audioOutput = parsed.audioOutput;
    return out;
  } catch {
    return EMPTY_PREFS;
  }
}

export function readDevicePrefs(): DevicePrefs {
  try {
    return parseDevicePrefs(localStorage.getItem(DEVICE_PREFS_KEY));
  } catch {
    return EMPTY_PREFS;
  }
}

export function writeDevicePrefs(prefs: DevicePrefs): void {
  try {
    localStorage.setItem(DEVICE_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* best-effort — private browsing / quota / SSR */
  }
}

/** Given the currently enumerated deviceIds for a given kind, drops any stored
 * preference that no longer exists (device unplugged, permission revoked,
 * etc.) so callers fall back to the system default (`undefined`) instead of
 * trying to switch to a device that's gone. Pure + exported for testing. */
export function reconcileDevicePrefs(prefs: DevicePrefs, availableIds: {
  videoInput?: string[];
  audioInput?: string[];
  audioOutput?: string[];
}): DevicePrefs {
  const next: DevicePrefs = { ...prefs };
  if (next.videoInput && availableIds.videoInput && !availableIds.videoInput.includes(next.videoInput)) {
    delete next.videoInput;
  }
  if (next.audioInput && availableIds.audioInput && !availableIds.audioInput.includes(next.audioInput)) {
    delete next.audioInput;
  }
  if (next.audioOutput && availableIds.audioOutput && !availableIds.audioOutput.includes(next.audioOutput)) {
    delete next.audioOutput;
  }
  return next;
}

// ── applyDevicePrefs ─────────────────────────────────────────────────────────
// Pure dispatcher: given the persisted prefs and a Room-shaped object
// exposing `switchActiveDevice` (LiveKit's LocalParticipant does not carry
// this method directly — it lives on the Room instance, reachable via
// components-react's `useRoomContext()`), calls it for whichever of
// videoInput/audioInput is set. Speaker (audioOutput) is intentionally NOT
// handled here — setSinkId operates on <audio> elements, not the Room, so
// that path lives in CallView.tsx next to the RoomAudioRenderer DOM query.
// Kept as a standalone function (rather than inline in the component) so
// it's directly unit-testable without React.
export interface SwitchableRoom {
  switchActiveDevice: (kind: "videoinput" | "audioinput", deviceId: string) => void | Promise<void | boolean>;
}

export function applyDevicePrefs(prefs: DevicePrefs, room: SwitchableRoom): void {
  if (prefs.videoInput) {
    void room.switchActiveDevice("videoinput", prefs.videoInput);
  }
  if (prefs.audioInput) {
    void room.switchActiveDevice("audioinput", prefs.audioInput);
  }
}

export function useDevicePreferences() {
  const [prefs, setPrefs] = useState<DevicePrefs>(() => readDevicePrefs());

  // Re-sync on mount in case another tab/window updated the preference since
  // this component tree was created.
  useEffect(() => {
    setPrefs(readDevicePrefs());
  }, []);

  const update = useCallback((patch: Partial<DevicePrefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...patch };
      writeDevicePrefs(next);
      return next;
    });
  }, []);

  /** Drops any deviceId that's no longer present in the current enumeration
   * (see reconcileDevicePrefs) and persists the cleaned-up result. */
  const reconcile = useCallback((availableIds: {
    videoInput?: string[];
    audioInput?: string[];
    audioOutput?: string[];
  }) => {
    setPrefs((prev) => {
      const next = reconcileDevicePrefs(prev, availableIds);
      writeDevicePrefs(next);
      return next;
    });
  }, []);

  return { prefs, update, reconcile };
}
