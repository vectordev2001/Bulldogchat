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
}

const DEFAULTS: MeetPrefs = {
  stageGlow: true,
};

export function loadMeetPrefs(): MeetPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<MeetPrefs>;
      if (parsed && typeof parsed === "object") {
        return { ...DEFAULTS, ...parsed };
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
