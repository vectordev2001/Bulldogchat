/**
 * meet-prefs.ts — small, opinionated visual preferences for the Bulldog Meet
 * UI (Room.tsx, StageTile / StripTile, etc.). These are split from
 * `meet-devices.ts` because they're not media-device picks; they're personal
 * styling choices that affect ONLY the local UI, never the published tracks.
 *
 * State lives in localStorage so it survives page reload + Room remount.
 * Reads/writes are wrapped in try/catch so a quota-blocked storage (Safari
 * private mode, iOS PWA in some configs) doesn't crash the meeting.
 */

const PREFS_KEY = "bulldog.meet.prefs";

/**
 * Stage layout choice.
 *  - "speaker": one large focused tile + a filmstrip of the rest along the
 *    bottom. This is Bulldog Meet's traditional look.
 *  - "grid":    equal-sized tiles arranged in a responsive grid so every
 *    participant is the same size. Preferred for small meetings where every
 *    face matters equally (Zoom's default, Meet's "Tiles").
 */
export type MeetLayout = "speaker" | "grid";

export interface MeetPrefs {
  /**
   * When true, render the soft top-to-bottom gradient overlay on every
   * participant tile. The overlay gives the stage a warm "stage-lights"
   * vignette, but some users find it visually noisy — especially when the
   * camera is off and the tile is mostly initials-on-dark.
   *
   * Default ON to match the existing look-and-feel, but the user can flip
   * this from the in-meeting Settings menu.
   */
  stageGlow: boolean;
  /**
   * Which stage layout the local user prefers. Defaults to "speaker" to
   * match the pre-existing behavior; users can flip to "grid" from the
   * new toolbar Grid button (Phase 1.9.31). Choice is per-device, not
   * synced across the meeting.
   */
  layout: MeetLayout;
  /**
   * When true, play call ringtones — outgoing ringback for the caller and
   * an incoming chime for the callee. Both play through the standard media
   * output (system speakers unless the user has picked a specific speaker
   * in MeetSettings). Defaults ON so users know a call is actually going
   * through / that they're being called; users can mute from the profile
   * dropdown when they need silence (e.g. already on another meeting).
   *
   * Per-device localStorage — not synced. That matches how notification
   * mute state works today.
   */
  callSoundsEnabled: boolean;
}

const DEFAULTS: MeetPrefs = {
  stageGlow: true,
  layout: "speaker",
  callSoundsEnabled: true,
};

export function loadMeetPrefs(): MeetPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<MeetPrefs>;
      if (parsed && typeof parsed === "object") {
        // Sanitize layout (older prefs blobs may lack it or hold a stale value).
        const layout: MeetLayout = parsed.layout === "grid" ? "grid" : "speaker";
        // Sanitize callSoundsEnabled — fall back to default when the field is
        // missing from an older prefs blob so existing users get sounds on.
        const callSoundsEnabled =
          typeof parsed.callSoundsEnabled === "boolean"
            ? parsed.callSoundsEnabled
            : DEFAULTS.callSoundsEnabled;
        return { ...DEFAULTS, ...parsed, layout, callSoundsEnabled };
      }
    }
  } catch {
    /* ignore — storage may be unavailable */
  }
  return { ...DEFAULTS };
}

export function saveMeetPrefs(prefs: MeetPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

/**
 * Event name fired on `window` whenever a meet pref changes. Components that
 * read prefs at mount time can subscribe and re-render without us needing a
 * full context provider for this tiny piece of state.
 */
export const MEET_PREFS_EVENT = "bulldog:meet-prefs-changed";

export function emitMeetPrefsChanged(): void {
  try {
    window.dispatchEvent(new CustomEvent(MEET_PREFS_EVENT));
  } catch {
    /* ignore */
  }
}
