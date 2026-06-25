/**
 * meet-devices.ts — shared device-selection + blur-capability helpers for the
 * Bulldog Meet flow (prejoin Join.tsx + in-call Room.tsx).
 *
 * The device picker selections persist to localStorage so they survive a
 * rejoin, and the blur capability check lets the UI hide/disable the
 * background-effects control on platforms where the MediaPipe + canvas
 * captureStream pipeline does not work (notably iOS Safari, where
 * HTMLCanvasElement.captureStream of a segmented feed is unreliable).
 */

export interface DevicePrefs {
  audioInput?: string;
  videoInput?: string;
  audioOutput?: string;
}

const PREFS_KEY = "bulldog.meet.devicePrefs";

export function loadDevicePrefs(): DevicePrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as DevicePrefs;
      if (parsed && typeof parsed === "object") return parsed;
    }
  } catch {
    /* ignore */
  }
  return {};
}

export function saveDevicePrefs(prefs: DevicePrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

export interface DeviceList {
  audioInputs: MediaDeviceInfo[];
  videoInputs: MediaDeviceInfo[];
  audioOutputs: MediaDeviceInfo[];
}

/**
 * Enumerate available media devices. Labels are only populated once the user
 * has granted camera/mic permission — before that the browser returns
 * anonymous entries with empty labels. Callers should request permission
 * first (the prejoin preview and the in-call published tracks both already
 * hold a getUserMedia grant by the time settings are opened).
 */
export async function listMediaDevices(): Promise<DeviceList> {
  const empty: DeviceList = { audioInputs: [], videoInputs: [], audioOutputs: [] };
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) {
    return empty;
  }
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return {
      audioInputs: all.filter((d) => d.kind === "audioinput" && d.deviceId),
      videoInputs: all.filter((d) => d.kind === "videoinput" && d.deviceId),
      audioOutputs: all.filter((d) => d.kind === "audiooutput" && d.deviceId),
    };
  } catch {
    return empty;
  }
}

/** True when the browser can render audio to a chosen output (setSinkId). */
export function speakerSelectionSupported(): boolean {
  return (
    typeof HTMLMediaElement !== "undefined" &&
    "setSinkId" in HTMLMediaElement.prototype
  );
}

/**
 * Whether background blur / virtual backgrounds can run on this platform.
 *
 * The processor segments the camera with MediaPipe and republishes a
 * canvas.captureStream() track. That pipeline is broken on iOS (all browsers
 * are WebKit there): captureStream of a 30fps composited canvas either throws
 * or produces a frozen/black track, so the button would be a trap. We
 * feature-detect captureStream AND exclude iOS/iPadOS explicitly.
 */
export function blurSupported(): boolean {
  if (typeof document === "undefined" || typeof navigator === "undefined") return false;

  const ua = navigator.userAgent || "";
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) ||
    // iPadOS 13+ reports as desktop Safari but exposes touch points.
    (navigator.platform === "MacIntel" && (navigator.maxTouchPoints ?? 0) > 1);
  if (isIOS) return false;

  // Microsoft Edge: canvas.captureStream() does not reliably emit periodic
  // keyframes from the composited VBG canvas, so remote subscribers (e.g. a
  // Mac peer) freeze on the first frame after the local user changes their
  // background. Disable VBG on Edge until we ship a keyframe-forcing fix.
  // Detect via the "Edg/" UA token (Chromium-based Edge); legacy EdgeHTML
  // ("Edge/") is no longer supported by livekit-client either.
  if (/Edg\//.test(ua)) return false;

  try {
    const canvas = document.createElement("canvas");
    const hasCapture =
      typeof (canvas as HTMLCanvasElement & { captureStream?: unknown }).captureStream ===
      "function";
    return hasCapture;
  } catch {
    return false;
  }
}

/** True when running in Microsoft Edge (Chromium). */
export function isEdge(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Edg\//.test(navigator.userAgent || "");
}
