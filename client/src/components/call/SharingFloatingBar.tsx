import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  MonitorOff,
  ArrowLeftFromLine,
  Pointer,
  Highlighter,
  Eraser,
  PictureInPicture2,
} from "lucide-react";

export type SharingAnnotationTool = "off" | "laser" | "highlighter";

/**
 * Floating control bar that stays visible while the user is screen-sharing.
 *
 * Browsers minimize / push the Bulldog Meet tab to the background as soon as
 * the user selects a different window/app to share, which means the regular
 * bottom control bar is no longer reachable without alt-tabbing back. This
 * component fixes that by rendering a compact, draggable bar with the three
 * controls the sharer needs the most:
 *
 *   - Mic toggle
 *   - Camera toggle
 *   - Stop share
 *
 * Plus annotation tools (laser / highlighter) when the canvas pipeline is
 * available, and a "Back to meeting" affordance that focuses the meeting
 * window again (so the user doesn't lose chat / participants panel).
 *
 * Behavior notes:
 *   - In-tab mode: we render with `position: fixed` and a high z-index. It
 *     floats above the meeting UI; when the Bulldog tab is focused this is
 *     exactly the same as any other in-page overlay.
 *   - Always-on-top across windows requires the Document Picture-in-Picture
 *     API (Chromium 116+ / Edge 116+). When `displaySurface === "monitor"`
 *     and PiP is available we auto-open it once per share session; the user
 *     can also toggle manually via the PiP button. The toolbar's React tree
 *     is portaled into the PiP window's body and continues to drive the same
 *     callbacks (mic/cam/stop/annotations) so the bar's controls work even
 *     when the Bulldog tab is fully obscured.
 *   - Bar is draggable so it doesn't permanently block the shared region.
 *     Drag state is local; we don't persist the position. Drag is disabled
 *     in PiP mode since the PiP window itself is OS-draggable.
 */
export function SharingFloatingBar({
  micOn,
  camOn,
  onToggleMic,
  onToggleCam,
  onStopShare,
  annotationsAvailable,
  tool,
  onSetTool,
  onClearAnnotations,
  displaySurface,
}: {
  micOn: boolean;
  camOn: boolean;
  onToggleMic: () => void;
  onToggleCam: () => void;
  onStopShare: () => void;
  /** Whether the current browser supports the annotation canvas pipeline. */
  annotationsAvailable?: boolean;
  /** Current annotation tool (laser / highlighter / off). */
  tool?: SharingAnnotationTool;
  /** Toggle / pick an annotation tool. Pass "off" to disable. */
  onSetTool?: (tool: SharingAnnotationTool) => void;
  /** Wipe all highlighter strokes. */
  onClearAnnotations?: () => void;
  /**
   * What the user picked in the browser share dialog. We auto-open the PiP
   * toolbar only for "monitor" (entire screen) — for window / tab shares
   * the user can still see the Bulldog tab in their taskbar.
   */
  displaySurface?: "monitor" | "window" | "browser" | null;
}) {
  // PiP window state. `pipWindow` is the live reference to the open Document
  // PiP window; null when we're rendering inline. `pipAttempted` tracks
  // whether we've already tried to auto-open for this share session so we
  // don't keep retrying if the user manually closed the PiP window.
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  const pipAttempted = useRef(false);

  const pipApiAvailable = useMemo(
    () => typeof window !== "undefined" && "documentPictureInPicture" in window,
    [],
  );

  // Open / close the PiP window. Wrapping in a stable async helper so both
  // the auto-open effect and the manual toggle button can call it.
  const openPip = async () => {
    if (!pipApiAvailable || pipWindow) return;
    try {
      // Document PiP type isn't in TS lib.dom yet; cast through unknown.
      const dpip = (window as unknown as {
        documentPictureInPicture?: {
          requestWindow: (opts?: { width?: number; height?: number }) => Promise<Window>;
        };
      }).documentPictureInPicture;
      if (!dpip) return;
      const w = await dpip.requestWindow({ width: 380, height: 64 });
      // Copy enough document styles for tailwind classes to apply. We rely on
      // <link rel=stylesheet> tags that vite injects on the host document.
      // Cloning them keeps the toolbar visually consistent with the in-tab
      // render. Style elements (vite hot-reload, devtools) are cloned too.
      for (const node of Array.from(document.head.querySelectorAll("link[rel=stylesheet], style"))) {
        w.document.head.appendChild(node.cloneNode(true));
      }
      // Make the PiP body transparent-ish so the toolbar bubble shows on its
      // own dark background. Important: padding 0 so the bar hugs the window.
      w.document.body.style.margin = "0";
      w.document.body.style.padding = "0";
      w.document.body.style.background = "transparent";
      w.document.body.style.fontFamily = getComputedStyle(document.body).fontFamily;
      w.document.body.style.color = "white";
      // When the user closes the PiP window (X button or system close), we
      // need to flip back to the in-tab bar.
      w.addEventListener("pagehide", () => setPipWindow(null));
      setPipWindow(w);
    } catch (err) {
      // Most common failures: not in user-activation, blocked by policy. We
      // silently fall back to the in-tab bar — the user can hit the PiP
      // button manually later.
      console.warn("[sharing-bar] PiP open failed:", (err as Error)?.message ?? err);
    }
  };

  const closePip = () => {
    pipWindow?.close();
    setPipWindow(null);
  };

  // Auto-open PiP exactly once per share session when the user picked
  // "entire screen" — that's the case where the Bulldog tab definitely
  // can't sit on top of what they're sharing, so the PiP window is the
  // only way to keep controls reachable.
  useEffect(() => {
    if (pipAttempted.current) return;
    if (!pipApiAvailable) return;
    if (displaySurface !== "monitor") return;
    pipAttempted.current = true;
    void openPip();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displaySurface, pipApiAvailable]);

  // Close the PiP window if this component unmounts (share stopped).
  useEffect(() => {
    return () => {
      pipWindow?.close();
    };
  }, [pipWindow]);

  // Build the bar contents once and reuse them in both render targets.
  const barContents = (
    <ToolbarContents
      micOn={micOn}
      camOn={camOn}
      onToggleMic={onToggleMic}
      onToggleCam={onToggleCam}
      onStopShare={onStopShare}
      annotationsAvailable={annotationsAvailable}
      tool={tool}
      onSetTool={onSetTool}
      onClearAnnotations={onClearAnnotations}
      pipApiAvailable={pipApiAvailable}
      pipOpen={!!pipWindow}
      onTogglePip={() => (pipWindow ? closePip() : void openPip())}
      inPip={!!pipWindow}
    />
  );

  // When PiP is open: don't render in-tab at all (avoid duplicate controls
  // racing each other). Portal contents into the PiP body instead.
  if (pipWindow) {
    return createPortal(barContents, pipWindow.document.body);
  }

  return <InTabFloatingShell>{barContents}</InTabFloatingShell>;
}

/**
 * The draggable shell we wrap around the toolbar when rendering inside the
 * Bulldog tab. The PiP-rendered toolbar skips this and just sits flush in
 * its own window (the OS provides the drag handle).
 */
function InTabFloatingShell({ children }: { children: React.ReactNode }) {
  const [pos, setPos] = useState<{ x: number; y: number }>(() => ({
    x: Math.max(16, (typeof window !== "undefined" ? window.innerWidth : 1024) - 380),
    y: 16,
  }));
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(
    null,
  );
  const barRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onResize = () => {
      const el = barRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      setPos((p) => ({
        x: Math.min(Math.max(8, p.x), window.innerWidth - rect.width - 8),
        y: Math.min(Math.max(8, p.y), window.innerHeight - rect.height - 8),
      }));
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest("button")) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      baseX: pos.x,
      baseY: pos.y,
    };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = dragRef.current;
    if (!d) return;
    const el = barRef.current;
    const w = el?.offsetWidth ?? 360;
    const h = el?.offsetHeight ?? 56;
    const nx = Math.min(Math.max(8, d.baseX + (e.clientX - d.startX)), window.innerWidth - w - 8);
    const ny = Math.min(Math.max(8, d.baseY + (e.clientY - d.startY)), window.innerHeight - h - 8);
    setPos({ x: nx, y: ny });
  };
  const onPointerUp = () => {
    dragRef.current = null;
  };

  return (
    <div
      ref={barRef}
      role="toolbar"
      aria-label="Screen sharing controls"
      data-testid="sharing-floating-bar"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      style={{
        transform: `translate3d(${pos.x}px, ${pos.y}px, 0)`,
        touchAction: "none",
      }}
      className="fixed left-0 top-0 z-[9999] flex select-none items-center gap-1 rounded-full border border-white/15 bg-[hsl(220_16%_12%)]/95 px-2 py-1.5 shadow-2xl ring-1 ring-black/40 backdrop-blur"
    >
      {/* Drag handle (only shown in-tab; the PiP window has its own). */}
      <div
        aria-hidden
        className="mr-1 flex h-6 cursor-grab items-center px-1 text-white/40 active:cursor-grabbing"
        title="Drag"
      >
        <span className="block h-1 w-1 rounded-full bg-white/40" />
        <span className="ml-0.5 block h-1 w-1 rounded-full bg-white/40" />
        <span className="ml-0.5 block h-1 w-1 rounded-full bg-white/40" />
      </div>
      {children}
    </div>
  );
}

/**
 * Pure presentational toolbar — same buttons regardless of whether we're in
 * the in-tab shell or portaled into a Document PiP window.
 */
function ToolbarContents({
  micOn,
  camOn,
  onToggleMic,
  onToggleCam,
  onStopShare,
  annotationsAvailable,
  tool,
  onSetTool,
  onClearAnnotations,
  pipApiAvailable,
  pipOpen,
  onTogglePip,
  inPip,
}: {
  micOn: boolean;
  camOn: boolean;
  onToggleMic: () => void;
  onToggleCam: () => void;
  onStopShare: () => void;
  annotationsAvailable?: boolean;
  tool?: SharingAnnotationTool;
  onSetTool?: (tool: SharingAnnotationTool) => void;
  onClearAnnotations?: () => void;
  pipApiAvailable: boolean;
  pipOpen: boolean;
  onTogglePip: () => void;
  inPip: boolean;
}) {
  const onBackToMeeting = () => {
    try {
      window.focus();
    } catch {
      /* ignored */
    }
  };

  // In PiP we wrap the row in its own little dark pill so it looks like the
  // in-tab bar; in-tab we let the surrounding shell provide the chrome.
  const Row = ({ children }: { children: React.ReactNode }) =>
    inPip ? (
      <div className="flex h-full w-full items-center gap-1 bg-[hsl(220_16%_12%)] px-3 py-2 text-white">
        {children}
      </div>
    ) : (
      <>{children}</>
    );

  return (
    <Row>
      <FloatBtn
        testid="floating-mic"
        danger={!micOn}
        onClick={onToggleMic}
        label={micOn ? "Mute" : "Unmute"}
      >
        {micOn ? <Mic size={16} /> : <MicOff size={16} />}
      </FloatBtn>
      <FloatBtn
        testid="floating-cam"
        danger={!camOn}
        onClick={onToggleCam}
        label={camOn ? "Stop video" : "Start video"}
      >
        {camOn ? <Video size={16} /> : <VideoOff size={16} />}
      </FloatBtn>
      <FloatBtn
        testid="floating-stop-share"
        danger
        onClick={onStopShare}
        label="Stop sharing"
      >
        <MonitorOff size={16} />
      </FloatBtn>

      {/* Annotation tools. Only render when the browser supports the canvas
          pipeline — on Edge / older browsers we fall back to a plain share
          and these controls would be no-ops. */}
      {annotationsAvailable && onSetTool && (
        <>
          <span aria-hidden className="mx-0.5 h-5 w-px bg-white/15" />
          <FloatBtn
            testid="floating-laser"
            active={tool === "laser"}
            onClick={() => onSetTool(tool === "laser" ? "off" : "laser")}
            label={tool === "laser" ? "Disable laser pointer" : "Laser pointer"}
          >
            <Pointer size={16} />
          </FloatBtn>
          <FloatBtn
            testid="floating-highlighter"
            active={tool === "highlighter"}
            onClick={() => onSetTool(tool === "highlighter" ? "off" : "highlighter")}
            label={tool === "highlighter" ? "Disable highlighter" : "Highlighter"}
          >
            <Highlighter size={16} />
          </FloatBtn>
          {onClearAnnotations && (
            <FloatBtn
              testid="floating-clear-annotations"
              onClick={onClearAnnotations}
              label="Clear annotations"
            >
              <Eraser size={16} />
            </FloatBtn>
          )}
        </>
      )}

      {/* PiP toggle. Only render when the API exists at all — fallbacks stay
          inline. Suppressed when already in PiP to avoid a self-referential
          control (use the OS close button instead). */}
      {pipApiAvailable && !inPip && (
        <FloatBtn
          testid="floating-pip"
          active={pipOpen}
          onClick={onTogglePip}
          label={pipOpen ? "Close pop-out controls" : "Pop out controls (always on top)"}
        >
          <PictureInPicture2 size={16} />
        </FloatBtn>
      )}

      {/* Back-to-meeting only makes sense from in-tab; from PiP we have no
          reliable way to focus the Bulldog tab so we omit it. */}
      {!inPip && (
        <FloatBtn
          testid="floating-back"
          onClick={onBackToMeeting}
          label="Back to meeting"
        >
          <ArrowLeftFromLine size={16} />
        </FloatBtn>
      )}

      <span
        aria-live="polite"
        className="ml-1 hidden whitespace-nowrap pr-1.5 text-[11px] font-medium text-white/80 sm:inline"
      >
        Sharing screen
      </span>
    </Row>
  );
}

function FloatBtn({
  children,
  onClick,
  label,
  testid,
  danger,
  active,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label: string;
  testid: string;
  danger?: boolean;
  active?: boolean;
}) {
  // Resolve the visual variant. `danger` wins over `active` so the stop-share
  // button stays red regardless of any other state.
  const variant = danger
    ? "bg-red-500/90 text-white hover:bg-red-500"
    : active
      ? "bg-primary text-primary-foreground hover:bg-primary/90"
      : "bg-white/10 text-white hover:bg-white/20";
  return (
    <button
      type="button"
      data-testid={testid}
      onClick={onClick}
      aria-label={label}
      title={label}
      aria-pressed={active ? true : undefined}
      className={`flex h-8 w-8 items-center justify-center rounded-full transition ${variant}`}
    >
      {children}
    </button>
  );
}
