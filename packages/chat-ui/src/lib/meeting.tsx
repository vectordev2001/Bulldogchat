import { createContext, useContext, useRef, useState, type ReactNode, type MutableRefObject } from "react";
import type { LocalAudioTrack, LocalVideoTrack } from "livekit-client";

export type Origin = "teams" | "zoom" | "meet" | "bulldog" | "direct";

/**
 * Tracks acquired during the prejoin lobby. Stashed here so the Room route
 * can publish them DIRECTLY instead of asking LiveKit to call getUserMedia
 * again — the second call happens inside a microtask-deferred useEffect,
 * outside the click-gesture window, which on iOS WebKit returns a frozen
 * camera and silent mic until the user manually toggles.
 *
 * The Room route takes ownership: it publishes the tracks and is responsible
 * for stopping them on disconnect. We use refs (not state) so reading them
 * doesn't trigger re-renders and so setting them never schedules another
 * render cycle that would push us past the gesture boundary.
 */
export interface PrejoinTracks {
  audio: LocalAudioTrack | null;
  video: LocalVideoTrack | null;
}

export interface JoinResult {
  token: string;
  wsUrl: string;
  room: string;
  identity: string;
  role: string;
  displayName: string;
  origin?: Origin;
}

export interface MeetingState {
  code: string;
  setCode: (c: string) => void;
  title: string;
  setTitle: (t: string) => void;
  displayName: string;
  setDisplayName: (n: string) => void;
  origin: Origin;
  setOrigin: (o: Origin) => void;

  micEnabled: boolean;
  setMicEnabled: (v: boolean) => void;
  camEnabled: boolean;
  setCamEnabled: (v: boolean) => void;

  /**
   * Tracks captured in the prejoin lobby. Read once by the Room route on
   * mount, then cleared. Survives the Join → Room navigation without
   * losing the gesture context that iOS WebKit needs.
   */
  prejoinTracksRef: MutableRefObject<PrejoinTracks>;

  token: string | null;
  wsUrl: string | null;
  room: string | null;
  identity: string | null;
  role: string | null;
  setJoinResult: (r: JoinResult) => void;
  clearJoinResult: () => void;

  connectedAt: number | null;
  setConnectedAt: (n: number | null) => void;
  participantCount: number;
  setParticipantCount: (n: number) => void;
  lastDuration: number;
  setLastDuration: (n: number) => void;
}

const MeetingContext = createContext<MeetingState | null>(null);

export function MeetingProvider({ children }: { children: ReactNode }) {
  const [code, setCode] = useState("");
  const [title, setTitle] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [origin, setOrigin] = useState<Origin>("bulldog");

  const [micEnabled, setMicEnabled] = useState(true);
  const [camEnabled, setCamEnabled] = useState(true);

  const [token, setToken] = useState<string | null>(null);
  const [wsUrl, setWsUrl] = useState<string | null>(null);
  const [room, setRoom] = useState<string | null>(null);
  const [identity, setIdentity] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);

  const [connectedAt, setConnectedAt] = useState<number | null>(null);
  const [participantCount, setParticipantCount] = useState(0);
  const [lastDuration, setLastDuration] = useState(0);

  const prejoinTracksRef = useRef<PrejoinTracks>({ audio: null, video: null });

  const setJoinResult = (r: JoinResult) => {
    setToken(r.token);
    setWsUrl(r.wsUrl);
    setRoom(r.room);
    setIdentity(r.identity);
    setRole(r.role);
    setDisplayName(r.displayName);
    if (r.origin) setOrigin(r.origin);
  };

  const clearJoinResult = () => {
    setToken(null);
    setWsUrl(null);
    setRoom(null);
    setIdentity(null);
    setRole(null);
  };

  return (
    <MeetingContext.Provider
      value={{
        code, setCode,
        title, setTitle,
        displayName, setDisplayName,
        origin, setOrigin,
        micEnabled, setMicEnabled,
        camEnabled, setCamEnabled,
        token, wsUrl, room, identity, role,
        setJoinResult, clearJoinResult,
        connectedAt, setConnectedAt,
        participantCount, setParticipantCount,
        lastDuration, setLastDuration,
        prejoinTracksRef,
      }}
    >
      {children}
    </MeetingContext.Provider>
  );
}

export function useMeeting() {
  const ctx = useContext(MeetingContext);
  if (!ctx) throw new Error("useMeeting must be used within MeetingProvider");
  return ctx;
}

export function parseOrigin(search: string): Origin {
  const params = new URLSearchParams(search);
  const from = params.get("from");
  if (
    from === "teams" ||
    from === "zoom" ||
    from === "meet" ||
    from === "bulldog" ||
    from === "direct"
  )
    return from;
  return "bulldog";
}

// Read the query string regardless of whether it lives inside the hash route
// (e.g. #/m/abc?from=teams) or in the real URL search (?from=teams#/end/abc),
// since wouter's useHashLocation can place query params in either spot.
export function getHashSearch(): string {
  const hash = window.location.hash;
  const qIndex = hash.indexOf("?");
  if (qIndex >= 0) return hash.slice(qIndex);
  return window.location.search || "";
}

export const ORIGIN_BANNER: Record<Origin, string> = {
  teams: "You were invited via Microsoft Teams. Bulldog Meet works with all video platforms.",
  zoom: "You were invited via Zoom. Bulldog Meet works with all video platforms.",
  meet: "You were invited via Google Meet. Bulldog Meet works with all video platforms.",
  bulldog: "Bulldog Meet — quick, AI-powered, no app required.",
  direct: "Bulldog Meet — quick, AI-powered, no app required.",
};

export const ORIGIN_CHIP: Record<Origin, string | null> = {
  teams: "Joined via Teams",
  zoom: "Joined via Zoom",
  meet: "Joined via Meet",
  bulldog: null,
  direct: null,
};
