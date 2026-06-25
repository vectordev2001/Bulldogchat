import { useEffect, useRef, useState } from "react";
import { Mic, MicOff, Video, VideoOff, MonitorOff, ArrowLeftFromLine, Pointer, Highlighter, Eraser } from "lucide-react";

export type SharingAnnotationTool = "off" | "laser" | "highlighter";

/**
 * Floating control bar that stays visible while the user is screen-sharing.
 *
 * Browsers minimize / push the Bulldog Meet tab to the background as soon as
 * the user selects a different window/app to share, which means the regular
 * bottom control bar is no longer reachable without alt-tabbing back. This
 * component fixes that by rendering a compact, draggable, always-on-top bar
 * with the three controls the sharer needs the most:
 *
 *   - Mic toggle
 *   - Camera toggle
 *   - Stop share
 *
 * Plus a "Back to meeting" affordance that focuses the meeting window again
 * (so the user doesn't lose the chat / participants panel).
 *
 * Behavior notes:
 *   - We render the bar with `position: fixed` and a high z-index. It floats
 *     above the meeting UI itself; when the *Bulldog tab* is focused this is
 *     exactly the same as any other in-page overlay.
 *   - The "always-on-top across windows" guarantee that Teams provides
 *     requires the Document Picture-in-Picture API. We progressively enhance
 *     into that when available (Chromium 116+ / Edge 116+); otherwise we
 *     fall back to the in-tab floating bar.
 *   - Bar is draggable so it doesn't permanently block the shared region.
 *     Drag state is local; we don't persist the position.
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
}) {
  // Initial position: top-right with a small inset. The bar uses translate
  // for movement so re-renders don't fight the drag.
  const [pos, setPos] = useState<{ x: number; y: number }>(() => ({
    x: Math.max(16, (typeof window !== "undefined" ? window.innerWidth : 1024) - 320),
    y: 16,
  }));
  const dragRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(
    null,
  );
  const barRef = useRef<HTMLDivElement | null>(null);

  // Keep the bar inside the viewport on window resize.
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
    // Only start a drag from the handle area (not from buttons).
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
    const w = el?.offsetWidth ?? 280;
    const h = el?.offsetHeight ?? 56;
    const nx = Math.min(Math.max(8, d.baseX + (e.clientX - d.startX)), window.innerWidth - w - 8);
    const ny = Math.min(Math.max(8, d.baseY + (e.clientY - d.startY)), window.innerHeight - h - 8);
    setPos({ x: nx, y: ny });
  };
  const onPointerUp = () => {
    dragRef.current = null;
  };

  const onBackToMeeting = () => {
    // Try to surface the Bulldog window again. focus() is best-effort on
    // most browsers (limited by the popup blocker / user-activation), but
    // it's the only thing we can do from a non-Document-PiP context.
    try {
      window.focus();
    } catch {
      /* ignored */
    }
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
      {/* Drag handle */}
      <div
        aria-hidden
        className="mr-1 flex h-6 cursor-grab items-center px-1 text-white/40 active:cursor-grabbing"
        title="Drag"
      >
        <span className="block h-1 w-1 rounded-full bg-white/40" />
        <span className="ml-0.5 block h-1 w-1 rounded-full bg-white/40" />
        <span className="ml-0.5 block h-1 w-1 rounded-full bg-white/40" />
      </div>

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
      <FloatBtn
        testid="floating-back"
        onClick={onBackToMeeting}
        label="Back to meeting"
      >
        <ArrowLeftFromLine size={16} />
      </FloatBtn>

      <span
        aria-live="polite"
        className="ml-1 hidden whitespace-nowrap pr-1.5 text-[11px] font-medium text-white/80 sm:inline"
      >
        Sharing screen
      </span>
    </div>
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
