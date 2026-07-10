/**
 * LobbyControlPanel — Teams in-app lobby control for Bulldog Chat.
 *
 * Rendered inside the meeting detail view (ScheduleCallDialog / MeetingsListDialog)
 * when ALL of the following conditions hold:
 *   (a) The meeting has a Teams join URL (teamsJoinUrl != null)
 *   (b) The current user is the meeting organizer (organizerId === me.id)
 *   (c) The meeting is in its active window (startAt <= now+30min AND endAt >= now)
 *
 * Design doc: teams-host-view-design.md
 * Sprint: 1 (Phase 1.9.5)
 *
 * States:
 *   Idle     - panel closed, shows "Open lobby control" button
 *   Joining  - connecting to Teams (10s timeout)
 *   Live     - showing waiter list with Admit/Reject
 *   Empty    - Live but 0 waiters
 *   Error    - connection failed, shows Retry
 *
 * Auto-admit: on lobbyParticipantsUpdated we check the participant email
 * against the known-emails endpoint result and admit silently if matched.
 *
 * Keyboard shortcuts (while panel is Live):
 *   a  - focus first Admit button
 *   r  - focus first Reject button
 *
 * The panel calls call.hangUp({ forEveryone: false }) on unmount to release
 * the ACS media leg.
 */

import {
  useEffect,
  useRef,
  useState,
  useCallback,
} from "react";
import { Loader2, Users, CheckCircle, XCircle, PhoneOff, PhoneCall, AlertCircle, ExternalLink } from "lucide-react";
import { PublicClientApplication } from "@azure/msal-browser";
import { msalConfig, loginRequest } from "../../lib/msal-config";
import { apiRequest } from "../../lib/queryClient";

// ---------------------------------------------------------------------------
// ACS SDK types — loaded dynamically at runtime.
// These ambient type aliases let TypeScript compile cleanly while the real
// SDK types arrive via the dynamic import (which resolves at runtime).
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
type AcsCall = any;
type AcsCallAgent = any;
type LobbyParticipant = {
  identifier: any;
  displayName?: string;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface LobbyControlPanelProps {
  /** Numeric id of the scheduled_call row. */
  meetingId: number;
  /** The Teams meeting join URL (https://teams.microsoft.com/...). */
  teamsJoinUrl: string;
}

// ---------------------------------------------------------------------------
// Waiter entry — enriched in-component shape
// ---------------------------------------------------------------------------

interface Waiter {
  /** Stable key (serialised identifier). */
  key: string;
  identifier: unknown;
  displayName: string;
  email: string | null;
  arrivedAt: number; // epoch ms
}

// ---------------------------------------------------------------------------
// Reject reason options (Sprint 1: 3-option pick, no free text)
// ---------------------------------------------------------------------------

const REJECT_REASONS = [
  { value: "wrong_meeting", label: "Wrong meeting" },
  { value: "not_authorized", label: "Not authorized" },
  { value: "rejoin_later", label: "Please rejoin later" },
] as const;
type RejectReason = (typeof REJECT_REASONS)[number]["value"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let msalInstance: PublicClientApplication | null = null;

async function getMsalInstance(): Promise<PublicClientApplication> {
  if (!msalInstance) {
    msalInstance = new PublicClientApplication(msalConfig);
    await msalInstance.initialize();
  }
  return msalInstance;
}

/** Extract a human-readable key from an ACS identifier object. */
function identifierKey(identifier: unknown): string {
  if (!identifier || typeof identifier !== "object") return String(identifier);
  const id = identifier as Record<string, unknown>;
  if (typeof id.microsoftTeamsUserId === "string") return `teams:${id.microsoftTeamsUserId}`;
  if (typeof id.communicationUserId === "string") return `acs:${id.communicationUserId}`;
  if (typeof id.id === "string") return `unknown:${id.id}`;
  return JSON.stringify(id);
}

/** Best-effort email extraction from an ACS identifier. */
function emailFromIdentifier(identifier: unknown): string | null {
  if (!identifier || typeof identifier !== "object") return null;
  const id = identifier as Record<string, unknown>;
  // Teams user identifiers sometimes surface the UPN as the id value if
  // it looks like an email address. This is best-effort for Sprint 1.
  const candidates = [id.microsoftTeamsUserId, id.communicationUserId, id.id];
  for (const c of candidates) {
    if (typeof c === "string" && c.includes("@")) return c.toLowerCase();
  }
  return null;
}

/** Human-readable "Xs" elapsed since epoch. */
function elapsedLabel(arrivedAt: number): string {
  const secs = Math.floor((Date.now() - arrivedAt) / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${secs % 60}s`;
}

/** Convert an ACS LobbyParticipant to our Waiter shape. */
function participantToWaiter(p: LobbyParticipant): Waiter {
  return {
    key: identifierKey(p.identifier),
    identifier: p.identifier,
    displayName: p.displayName ?? "Guest",
    email: emailFromIdentifier(p.identifier),
    arrivedAt: Date.now(),
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type PanelState = "idle" | "joining" | "live" | "error" | "acs-unavailable";

export function LobbyControlPanel({
  meetingId,
  teamsJoinUrl,
}: LobbyControlPanelProps) {
  const [panelState, setPanelState] = useState<PanelState>("idle");
  const [errorMsg, setErrorMsg] = useState<string>("");
  // acsConfigured: null = not yet probed, true/false = probed result. When
  // false we skip the ACS-backed panel entirely and render the "admit in
  // Teams" fallback banner — clicking "Open lobby control" would 501 otherwise.
  const [, setAcsConfigured] = useState<boolean | null>(null);
  const [waiters, setWaiters] = useState<Waiter[]>([]);
  const [knownEmails, setKnownEmails] = useState<Set<string>>(new Set());
  const [rejectTarget, setRejectTarget] = useState<Waiter | null>(null);
  const [selectedReason, setSelectedReason] = useState<RejectReason>("wrong_meeting");
  const [, forceRender] = useState(0);

  const callRef = useRef<AcsCall>(null);
  const agentRef = useRef<AcsCallAgent>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const joinTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firstAdmitRef = useRef<HTMLButtonElement>(null);
  const firstRejectRef = useRef<HTMLButtonElement>(null);

  // Track knownEmails in a ref so the lobby event handler (closed over at
  // subscribe time) always sees the current set without a stale closure.
  const knownEmailsRef = useRef<Set<string>>(new Set());
  useEffect(() => { knownEmailsRef.current = knownEmails; }, [knownEmails]);

  // ── Probe ACS availability once on mount ──────────────────────────────────
  // If ACS_CONNECTION_STRING / ACS_ENTRA_CLIENT_ID aren't set on the server,
  // /api/teams/lobby/acs-token returns 501 and the ACS-backed panel is
  // unusable. Probe up front so we can render the fallback "admit in Teams"
  // banner instead of a broken button. Any error (network, 401, 404) is
  // treated as "assume configured" so we don't silently degrade a healthy
  // panel; the real acs-token call will surface a specific error.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiRequest<{ acsConfigured: boolean }>(
          "GET",
          "/api/teams/lobby/status",
        );
        if (cancelled) return;
        setAcsConfigured(!!data.acsConfigured);
        if (!data.acsConfigured) setPanelState("acs-unavailable");
      } catch (err) {
        if (cancelled) return;
        console.warn("[LobbyControlPanel] status probe failed:", err);
        setAcsConfigured(true); // fail-open — real errors surface on click
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Tick "waited Xs" labels every second while live ──────────────────────
  useEffect(() => {
    if (panelState === "live") {
      timerRef.current = setInterval(() => forceRender((n) => n + 1), 1_000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [panelState]);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    if (panelState !== "live") return;
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") return;
      if (e.key === "a" && firstAdmitRef.current) {
        e.preventDefault();
        firstAdmitRef.current.focus();
      } else if (e.key === "r" && firstRejectRef.current) {
        e.preventDefault();
        firstRejectRef.current.focus();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [panelState]);

  // ── Cleanup on unmount ────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      void disconnectLobbyImpl();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Disconnect (no state updates — safe to call from unmount) ────────────
  async function disconnectLobbyImpl() {
    if (joinTimeoutRef.current) {
      clearTimeout(joinTimeoutRef.current);
      joinTimeoutRef.current = null;
    }
    if (callRef.current) {
      try { await callRef.current.hangUp({ forEveryone: false }); } catch { /* ignore */ }
      callRef.current = null;
    }
    if (agentRef.current) {
      try { await agentRef.current.dispose(); } catch { /* ignore */ }
      agentRef.current = null;
    }
  }

  // ── Disconnect (updates state) ────────────────────────────────────────────
  const disconnectLobby = useCallback(async () => {
    await disconnectLobbyImpl();
    setWaiters([]);
    setPanelState("idle");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Fetch known-emails allow-list ─────────────────────────────────────────
  const fetchKnownEmails = useCallback(async () => {
    try {
      const data = await apiRequest<{ emails: string[] }>(
        "GET",
        `/api/teams/lobby/known-emails?meetingId=${meetingId}`,
      );
      const s = new Set((data.emails ?? []).map((e: string) => e.toLowerCase()));
      setKnownEmails(s);
      knownEmailsRef.current = s;
    } catch (err) {
      console.warn("[LobbyControlPanel] known-emails fetch failed:", err);
    }
  }, [meetingId]);

  // ── Connect to Teams lobby ────────────────────────────────────────────────
  const connectToLobby = useCallback(async () => {
    setPanelState("joining");
    setErrorMsg("");

    try {
      // 1. Fetch the known-emails allow-list (parallel with token acquisition).
      const knownEmailsPromise = fetchKnownEmails();

      // 2. Acquire Entra token via MSAL (silent first, then interactive popup).
      const msal = await getMsalInstance();
      let teamsAadToken: string;
      try {
        const accounts = msal.getAllAccounts();
        const silentResult = await msal.acquireTokenSilent({
          ...loginRequest,
          account: accounts[0],
        });
        teamsAadToken = silentResult.accessToken;
      } catch {
        const popupResult = await msal.acquireTokenPopup(loginRequest);
        teamsAadToken = popupResult.accessToken;
      }

      // 3. Exchange for ACS token via Bulldog backend.
      const tokenData = await apiRequest<{ token: string; expiresOn: string }>(
        "POST",
        "/api/teams/lobby/acs-token",
        { teamsAadToken },
      );

      await knownEmailsPromise;

      // 4. Dynamically load the ACS Calling SDK.
      // We load via a variable to avoid tsc module resolution on packages that
      // are declared in package.json but not yet installed in the CI node_modules.
      const acsCallingPkg = "@azure/communication-calling" as string;
      const acsCommonPkg = "@azure/communication-common" as string;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { CallClient } = await import(/* @vite-ignore */ acsCallingPkg) as any;
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const { AzureCommunicationTokenCredential } = await import(/* @vite-ignore */ acsCommonPkg) as any;

      const tokenCredential = new AzureCommunicationTokenCredential(
        tokenData.token,
      );
      const callClient = new CallClient();
      const callAgent = await callClient.createTeamsCallAgent(tokenCredential);
      agentRef.current = callAgent;

      // 5. Set a 10-second join timeout.
      joinTimeoutRef.current = setTimeout(() => {
        setErrorMsg("Timed out waiting to join the Teams meeting (10s). Check your network and try again.");
        setPanelState("error");
        void disconnectLobbyImpl();
      }, 10_000);

      // 6. Join the meeting.
      const call = await callAgent.join({ meetingLink: teamsJoinUrl });
      callRef.current = call;

      if (joinTimeoutRef.current) {
        clearTimeout(joinTimeoutRef.current);
        joinTimeoutRef.current = null;
      }

      // 7. Bootstrap waiter list from existing lobby participants.
      const seed: Waiter[] = (call.lobby?.participants ?? []).map(
        (p: LobbyParticipant) => participantToWaiter(p),
      );
      setWaiters(seed);
      setPanelState("live");

      // 8. Auto-admit any existing waiters on the known-emails list.
      for (const w of seed) {
        if (w.email && knownEmailsRef.current.has(w.email)) {
          void call.lobby.admit(w.identifier);
        }
      }

      // 9. Subscribe to lobby updates.
      call.lobby.on(
        "lobbyParticipantsUpdated",
        (ev: { added: LobbyParticipant[]; removed: LobbyParticipant[] }) => {
          setWaiters((prev) => {
            const removedKeys = new Set(
              (ev.removed ?? []).map((p: LobbyParticipant) => identifierKey(p.identifier)),
            );
            const filtered = prev.filter((w) => !removedKeys.has(w.key));

            for (const p of ev.added ?? []) {
              const w = participantToWaiter(p);
              if (!filtered.find((x) => x.key === w.key)) {
                filtered.push(w);
                // Auto-admit if on the known-emails list.
                if (w.email && knownEmailsRef.current.has(w.email)) {
                  void call.lobby.admit(w.identifier);
                }
              }
            }

            return filtered;
          });
        },
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      console.error("[LobbyControlPanel] connect failed:", msg);
      // 501 from /acs-token = server has no ACS credentials configured. Bail
      // out to the fallback banner instead of surfacing the raw error —
      // routes-teams-lobby.ts returns a stable "Teams Host View not configured"
      // prefix that we match on here.
      if (/Teams Host View not configured/i.test(msg)) {
        setAcsConfigured(false);
        setPanelState("acs-unavailable");
        await disconnectLobbyImpl();
        return;
      }
      setErrorMsg(msg);
      setPanelState("error");
      await disconnectLobbyImpl();
    }
  }, [teamsJoinUrl, fetchKnownEmails, disconnectLobby]);

  // ── Admit ─────────────────────────────────────────────────────────────────
  const handleAdmit = useCallback(async (waiter: Waiter) => {
    if (!callRef.current?.lobby) return;
    try {
      await callRef.current.lobby.admit(waiter.identifier);
      setWaiters((prev) => prev.filter((w) => w.key !== waiter.key));
    } catch (err) {
      console.error("[LobbyControlPanel] admit failed:", err);
    }
  }, []);

  // ── Admit all ─────────────────────────────────────────────────────────────
  const handleAdmitAll = useCallback(async () => {
    if (!callRef.current?.lobby) return;
    try {
      await callRef.current.lobby.admitAll();
      setWaiters([]);
    } catch (err) {
      console.error("[LobbyControlPanel] admitAll failed:", err);
    }
  }, []);

  // ── Reject ────────────────────────────────────────────────────────────────
  const handleRejectConfirm = useCallback(async () => {
    if (!rejectTarget || !callRef.current?.lobby) return;
    const { identifier } = rejectTarget;
    const reason = selectedReason;
    try {
      // Pass reason if the SDK call accepts an options object; fall back to
      // logging locally if not (ACS lobby.reject signature is still preview).
      try {
        await callRef.current.lobby.reject(identifier, { reason });
      } catch {
        await callRef.current.lobby.reject(identifier);
        console.info("[LobbyControlPanel] reject reason logged locally:", reason);
      }
      setWaiters((prev) => prev.filter((w) => w.key !== rejectTarget.key));
    } catch (err) {
      console.error("[LobbyControlPanel] reject failed:", err);
    }
    setRejectTarget(null);
    setSelectedReason("wrong_meeting");
  }, [rejectTarget, selectedReason]);

  // ── Render ────────────────────────────────────────────────────────────────

  // Fallback when ACS is not configured on the server — the ACS-backed panel
  // would 501. Show a distinct amber banner that pushes the organizer straight
  // to Teams (which has native Admit UI in its own Participants pane). This is
  // the state a fresh Bulldog install hits today: guests in the Teams lobby,
  // no in-Bulldog admit control yet, but the fix path is obvious.
  if (panelState === "acs-unavailable") {
    return (
      <div
        className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3"
        data-testid="lobby-acs-unavailable-banner"
      >
        <div className="flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-amber-300 shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-white">
              Teams lobby active — admit in Teams
            </div>
            <div className="text-[11px] text-[hsl(0_0%_78%)] mt-1 leading-snug">
              Guests who joined via the Teams link may be waiting in the Microsoft
              Teams lobby. Open the Teams meeting yourself and admit them from the
              Participants pane. (Bulldog’s in-app admit control is not yet
              configured on this server.)
            </div>
          </div>
        </div>
        <div className="flex gap-2 mt-3">
          <a
            href={teamsJoinUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-1.5 rounded-md bg-[#5b5fc7] hover:bg-[#4a4ea8] text-[11px] font-bold text-white flex items-center gap-1.5"
            data-testid="button-lobby-open-teams"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            Open Teams to admit
          </a>
        </div>
      </div>
    );
  }

  if (panelState === "idle") {
    return (
      <div className="rounded-lg border border-[hsl(220_40%_25%)] bg-[hsl(220_55%_13%)] p-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold text-white flex items-center gap-1.5">
            <PhoneCall className="w-3.5 h-3.5 text-[#5b5fc7]" />
            Teams Lobby Control
          </div>
          <div className="text-[10px] text-[hsl(0_0%_60%)] mt-0.5">
            Admit or reject guests waiting in the Teams lobby without opening Teams.
          </div>
        </div>
        <button
          type="button"
          onClick={() => void connectToLobby()}
          className="shrink-0 px-3 py-1.5 rounded-md bg-[#5b5fc7] hover:bg-[#4a4ea8] text-white text-[11px] font-bold flex items-center gap-1.5 shadow-sm whitespace-nowrap"
          data-testid="button-lobby-open"
        >
          <Users className="w-3.5 h-3.5" />
          Open lobby control
        </button>
      </div>
    );
  }

  if (panelState === "joining") {
    return (
      <div className="rounded-lg border border-[hsl(220_40%_25%)] bg-[hsl(220_55%_13%)] p-4 flex items-center gap-3">
        <Loader2 className="w-4 h-4 animate-spin text-[#5b5fc7] shrink-0" />
        <div>
          <div className="text-sm font-semibold text-white">Connecting to Teams…</div>
          <div className="text-[10px] text-[hsl(0_0%_60%)] mt-0.5">
            Joining the meeting to access the lobby. This may take a moment.
          </div>
        </div>
      </div>
    );
  }

  if (panelState === "error") {
    return (
      <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3">
        <div className="flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-white">Could not connect</div>
            <div className="text-[11px] text-[hsl(0_0%_70%)] mt-0.5 break-words">{errorMsg}</div>
          </div>
        </div>
        <div className="flex gap-2 mt-3">
          <button
            type="button"
            onClick={() => void connectToLobby()}
            className="px-3 py-1.5 rounded-md bg-red-500/20 hover:bg-red-500/30 border border-red-500/40 text-[11px] font-bold text-white"
            data-testid="button-lobby-retry"
          >
            Retry
          </button>
          <a
            href={teamsJoinUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="px-3 py-1.5 rounded-md bg-[hsl(220_50%_22%)] hover:bg-[hsl(220_50%_28%)] border border-[hsl(220_40%_28%)] text-[11px] font-bold text-white"
          >
            Open Teams instead
          </a>
        </div>
      </div>
    );
  }

  // ── Live state ─────────────────────────────────────────────────────────────

  return (
    <div className="rounded-lg border border-[#5b5fc7]/40 bg-[hsl(220_55%_13%)] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[hsl(220_40%_22%)]">
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" aria-hidden />
          <span className="text-[11px] font-bold text-white">
            {waiters.length === 0
              ? "Lobby live — no guests waiting"
              : `${waiters.length} guest${waiters.length === 1 ? "" : "s"} waiting in lobby`}
          </span>
          {waiters.length > 0 && (
            <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-[#5b5fc7] text-white text-[10px] font-bold">
              {waiters.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 text-[10px] text-[hsl(0_0%_55%)]">
          <span className="font-mono uppercase tracking-wider">a</span>=admit
          &nbsp;
          <span className="font-mono uppercase tracking-wider">r</span>=reject
        </div>
      </div>

      {/* Waiter list */}
      {waiters.length === 0 ? (
        <div className="px-3 py-4 text-center">
          <div className="text-[11px] text-[hsl(0_0%_60%)]">
            No one is waiting. This panel will alert you when someone arrives.
          </div>
        </div>
      ) : (
        <div className="divide-y divide-[hsl(220_40%_22%)]">
          {waiters.map((w, idx) => (
            <WaiterRow
              key={w.key}
              waiter={w}
              onAdmit={() => void handleAdmit(w)}
              onReject={() => {
                setRejectTarget(w);
                setSelectedReason("wrong_meeting");
              }}
              admitRef={idx === 0 ? firstAdmitRef : undefined}
              rejectRef={idx === 0 ? firstRejectRef : undefined}
            />
          ))}
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-[hsl(220_40%_22%)]">
        <button
          type="button"
          onClick={() => void disconnectLobby()}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-[hsl(220_50%_22%)] hover:bg-[hsl(220_50%_28%)] border border-[hsl(220_40%_28%)] text-[10px] font-semibold text-[hsl(0_0%_75%)]"
          data-testid="button-lobby-leave"
        >
          <PhoneOff className="w-3 h-3" />
          Leave lobby control
        </button>
        {waiters.length > 0 && (
          <button
            type="button"
            onClick={() => void handleAdmitAll()}
            className="px-2.5 py-1 rounded-md bg-emerald-700/30 hover:bg-emerald-700/50 border border-emerald-600/40 text-[10px] font-semibold text-emerald-300"
            data-testid="button-lobby-admit-all"
          >
            Admit all ({waiters.length})
          </button>
        )}
      </div>

      {/* Reject reason picker */}
      {rejectTarget !== null && (
        <RejectReasonPicker
          waiter={rejectTarget}
          reason={selectedReason}
          onChangeReason={setSelectedReason}
          onConfirm={() => void handleRejectConfirm()}
          onCancel={() => setRejectTarget(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// WaiterRow
// ---------------------------------------------------------------------------

interface WaiterRowProps {
  waiter: Waiter;
  onAdmit: () => void;
  onReject: () => void;
  admitRef?: React.RefObject<HTMLButtonElement>;
  rejectRef?: React.RefObject<HTMLButtonElement>;
}

function WaiterRow({ waiter, onAdmit, onReject, admitRef, rejectRef }: WaiterRowProps) {
  const [, tick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2">
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-semibold text-white truncate">
          {waiter.displayName}
        </div>
        <div className="text-[10px] text-[hsl(0_0%_60%)] mt-0.5">
          {waiter.email ? (
            <span className="font-mono">{waiter.email}</span>
          ) : (
            <span className="italic">guest — no signed-in identity</span>
          )}
          &nbsp;·&nbsp;waited {elapsedLabel(waiter.arrivedAt)}
        </div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <button
          type="button"
          ref={admitRef}
          onClick={onAdmit}
          className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-emerald-700/30 hover:bg-emerald-700/60 border border-emerald-600/50 text-emerald-300 text-[11px] font-bold"
          data-testid={`button-admit-${waiter.key}`}
          title="Admit (a)"
        >
          <CheckCircle className="w-3 h-3" />
          Admit
        </button>
        <button
          type="button"
          ref={rejectRef}
          onClick={onReject}
          className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-red-500/20 hover:bg-red-500/40 border border-red-500/40 text-red-300 text-[11px] font-bold"
          data-testid={`button-reject-${waiter.key}`}
          title="Reject (r)"
        >
          <XCircle className="w-3 h-3" />
          Reject
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RejectReasonPicker
// ---------------------------------------------------------------------------

function RejectReasonPicker({
  waiter,
  reason,
  onChangeReason,
  onConfirm,
  onCancel,
}: {
  waiter: Waiter;
  reason: RejectReason;
  onChangeReason: (r: RejectReason) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="border-t border-[hsl(220_40%_22%)] bg-[hsl(220_55%_10%)] px-3 py-3">
      <div className="text-[11px] font-semibold text-white mb-2">
        Reject <span className="text-[#a8a9f0]">{waiter.displayName}</span>
      </div>
      <div className="flex flex-col gap-1 mb-3">
        {REJECT_REASONS.map((opt) => (
          <label
            key={opt.value}
            className="flex items-center gap-2 cursor-pointer text-[11px] text-[hsl(0_0%_80%)] hover:text-white"
          >
            <input
              type="radio"
              name="reject-reason"
              value={opt.value}
              checked={reason === opt.value}
              onChange={() => onChangeReason(opt.value)}
              className="accent-red-400"
            />
            {opt.label}
          </label>
        ))}
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          className="px-3 py-1 rounded-md bg-red-500/30 hover:bg-red-500/50 border border-red-500/50 text-[11px] font-bold text-red-200"
          data-testid="button-reject-confirm"
        >
          Confirm reject
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1 rounded-md bg-[hsl(220_50%_22%)] hover:bg-[hsl(220_50%_28%)] border border-[hsl(220_40%_28%)] text-[11px] font-semibold text-[hsl(0_0%_75%)]"
          data-testid="button-reject-cancel"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
