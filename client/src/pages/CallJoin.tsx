import { useEffect, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { Loader2, AlertTriangle, Video, Phone as PhoneIcon } from "lucide-react";
import { VectorLogo } from "@/components/VectorLogo";
import { useCalls } from "@/lib/CallContext";

/**
 * Landing page for SMS join-links. The server already enforced that the
 * user is signed in (it bounces unauthenticated traffic through
 * auth.bulldogops.com with ?next=) before redirecting to this hash route.
 *
 * Flow:
 *   1. Pull the JWT from the URL params (set by server-side /call-join).
 *   2. POST it to /api/call-join/redeem (via CallContext.joinByToken).
 *   3. CallContext sets `active` — the LiveKit overlay mounts automatically.
 *   4. We navigate back to `/` so the overlay sits on top of the chat UI.
 */
export default function CallJoin() {
  const [, params] = useRoute<{ token: string }>("/call-join/:token");
  const [, setLocation] = useLocation();
  const { joinByToken, active } = useCalls();
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<"redeeming" | "joined" | "error">("redeeming");

  useEffect(() => {
    let cancelled = false;
    const token = params?.token;
    if (!token) {
      setError("Missing join token. Try tapping the link in your text again.");
      setPhase("error");
      return;
    }
    (async () => {
      try {
        await joinByToken(decodeURIComponent(token));
        if (cancelled) return;
        setPhase("joined");
        // The CallOverlays component is mounted at app-level and picks up
        // the `active` call automatically. We push back to the main app
        // so the LiveKit room sits on top of the normal chat UI.
        setLocation("/");
      } catch (err: any) {
        if (cancelled) return;
        const msg =
          err?.message ?? "Couldn't join the call. The link may have expired.";
        setError(msg);
        setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
    // joinByToken is stable via useCallback; intentionally not in deps to
    // avoid re-running if React re-renders before navigation completes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params?.token]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-[hsl(220_60%_9%)] text-white px-6">
      <VectorLogo size={64} className="text-vs-blue mb-6" monochrome />
      {phase === "redeeming" && (
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-6 h-6 animate-spin text-vs-blue" />
          <div className="text-sm font-display tracking-wide">Connecting you to the call…</div>
          <div className="text-[11px] text-[hsl(0_0%_60%)] font-mono uppercase tracking-wider">
            Verifying your link
          </div>
        </div>
      )}
      {phase === "joined" && !active && (
        <div className="flex flex-col items-center gap-3">
          <Video className="w-6 h-6 text-vs-green" />
          <div className="text-sm font-display tracking-wide">Joined. Returning to chat…</div>
        </div>
      )}
      {phase === "error" && (
        <div className="flex flex-col items-center gap-3 max-w-md text-center">
          <AlertTriangle className="w-7 h-7 text-vs-red" />
          <div className="text-base font-display tracking-wide">Couldn't join the call</div>
          <div className="text-xs text-[hsl(0_0%_70%)] leading-relaxed">{error}</div>
          <button
            type="button"
            onClick={() => setLocation("/")}
            className="mt-4 px-4 py-2 rounded-md bg-vs-blue/20 hover:bg-vs-blue/30 border border-vs-blue/40 text-sm font-semibold"
            data-testid="button-call-join-back"
          >
            Back to Bulldog Chat
          </button>
        </div>
      )}
      <div className="absolute bottom-4 text-[10px] text-[hsl(0_0%_45%)] font-mono uppercase tracking-wider flex items-center gap-1">
        <PhoneIcon className="w-3 h-3" /> Bulldog Calls
      </div>
    </div>
  );
}
