/**
 * Screen-share annotator — canvas pipeline that overlays a laser pointer and
 * highlighter strokes onto the captured display stream so VIEWERS see the
 * annotations, not just the local user.
 *
 * Architecture (mirrors VirtualBackgroundProcessor):
 *
 *   1. We call getDisplayMedia() ourselves to acquire the raw screen track.
 *   2. The raw track plays into a hidden <video> element.
 *   3. A requestAnimationFrame loop draws the video frame onto an
 *      OffscreenCanvas / HTMLCanvasElement, then composites laser/highlighter
 *      overlays on top.
 *   4. canvas.captureStream(30).getVideoTracks()[0] is what we hand to
 *      LiveKit as the screen-share track.
 *
 * The annotator does NOT know about LiveKit; the caller (Room.tsx) wraps the
 * output track in a LocalVideoTrack and publishes it with Track.Source.ScreenShare.
 *
 * Tools (one active at a time):
 *
 *   - "laser": a soft red glow that follows the cursor inside the meeting
 *     window. Drawn as a fading trail (last ~12 positions) so viewers can
 *     follow what's being pointed at even if the cursor moves fast. No
 *     persistence; the trail clears as the cursor stays still.
 *   - "highlighter": click-and-drag draws a translucent yellow stroke.
 *     Strokes auto-fade over ~4 seconds so the screen doesn't get cluttered.
 *     clearStrokes() wipes everything immediately (toolbar "Clear" button).
 *
 * Important detail: the cursor coordinates we receive are in the LOCAL Bulldog
 * tab's coordinate space (CSS pixels from the top-left of window). The
 * captured frame might be of a DIFFERENT screen/window, so the cursor x/y has
 * no relationship to what's actually shown. We solve this by ALWAYS rendering
 * relative to the captured frame's bounds: when the user moves their mouse
 * inside the Bulldog tab, the annotation appears at the proportional location
 * inside the shared frame. This is a UX compromise — but it's the same model
 * Zoom uses for its "spotlight" pointer when sharing a different app.
 *
 * Fallback: if canvas.captureStream is unsupported (very old browsers) or the
 * raw display track ends, we throw / signal the caller, which should fall
 * back to plain LiveKit screen-share without annotations.
 */

export type AnnotationTool = "off" | "laser" | "highlighter";

interface LaserPoint {
  x: number;
  y: number;
  t: number; // timestamp ms — used to fade the trail
}

interface HighlighterStroke {
  points: { x: number; y: number }[];
  createdAt: number; // ms — used to fade out
}

export class ScreenShareAnnotator {
  private readonly raw: MediaStream;
  private readonly video: HTMLVideoElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly output: MediaStream;

  private rafId: number | null = null;
  private running = false;

  // Cursor position is normalized to [0..1] relative to the meeting window
  // so it lands proportionally on whatever resolution the captured frame is.
  private cursor: { x: number; y: number } | null = null;
  private laserTrail: LaserPoint[] = [];
  private strokes: HighlighterStroke[] = [];
  private currentStroke: HighlighterStroke | null = null;
  private tool: AnnotationTool = "off";

  // Track shape of the captured frame so we always render at native res
  // (avoids the canvas being a fuzzy upscale of the source).
  private frameW = 0;
  private frameH = 0;

  // Callback fired when the user stops sharing from the browser's native
  // "Stop sharing" bar at the bottom of the screen — Room.tsx needs to know
  // so it can flip its `sharing` state and unmount the floating bar.
  onTrackEnded: (() => void) | null = null;

  constructor(rawStream: MediaStream) {
    this.raw = rawStream;
    const track = rawStream.getVideoTracks()[0];
    if (!track) throw new Error("annotator: no video track in display stream");
    track.addEventListener("ended", () => {
      this.onTrackEnded?.();
    });

    // Hidden video element that decodes the raw display stream. Must be
    // muted/playsInline so it actually plays without user gesture.
    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.autoplay = true;
    this.video.srcObject = rawStream;
    // Best-effort play; getDisplayMedia counts as user activation so this
    // should not be blocked, but if it is we still render once metadata loads.
    void this.video.play().catch(() => {});

    // Canvas sized after the first frame's metadata; until then we use a
    // sane placeholder so captureStream() doesn't pin to 0x0.
    this.canvas = document.createElement("canvas");
    this.canvas.width = 1920;
    this.canvas.height = 1080;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("annotator: 2d canvas context unavailable");
    this.ctx = ctx;

    const captureStream = (
      this.canvas as HTMLCanvasElement & { captureStream?(fps?: number): MediaStream }
    ).captureStream;
    if (typeof captureStream !== "function") {
      throw new Error("annotator: canvas.captureStream unsupported");
    }
    this.output = captureStream.call(this.canvas, 30);

    // When the source dimensions become known, resize the canvas to match
    // so we publish the share at its native resolution.
    this.video.addEventListener("loadedmetadata", () => {
      this.frameW = this.video.videoWidth || 1920;
      this.frameH = this.video.videoHeight || 1080;
      this.canvas.width = this.frameW;
      this.canvas.height = this.frameH;
    });
  }

  /** The track to hand to LiveKit. Stable for the lifetime of this annotator. */
  get outputTrack(): MediaStreamTrack {
    const t = this.output.getVideoTracks()[0];
    if (!t) throw new Error("annotator: output stream has no video track");
    return t;
  }

  /** Start the render loop. Idempotent. */
  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = () => {
      if (!this.running) return;
      this.renderFrame();
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  /** Stop the loop and release every owned resource (raw + output tracks). */
  stop(): void {
    this.running = false;
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    try {
      this.video.pause();
      this.video.srcObject = null;
    } catch {
      /* ignore */
    }
    for (const t of this.raw.getTracks()) {
      try { t.stop(); } catch { /* ignore */ }
    }
    for (const t of this.output.getTracks()) {
      try { t.stop(); } catch { /* ignore */ }
    }
  }

  setTool(tool: AnnotationTool): void {
    this.tool = tool;
    // Switching away from highlighter cancels any in-progress stroke so we
    // don't leave a phantom segment when the user toggles tools mid-drag.
    if (tool !== "highlighter") {
      this.currentStroke = null;
    }
    // Switching away from laser clears the trail so the dot disappears
    // immediately rather than fading awkwardly while the next tool is in use.
    if (tool !== "laser") {
      this.laserTrail = [];
    }
  }

  /** Wipe all highlighter strokes immediately. Bound to the "Clear" button. */
  clearStrokes(): void {
    this.strokes = [];
    this.currentStroke = null;
  }

  /**
   * Receive a pointer position from the meeting UI in NORMALIZED coords
   * (x, y in [0..1] relative to the meeting window). The annotator scales
   * those into frame coordinates at render time so resolution changes
   * don't shift the annotation.
   */
  setCursor(nx: number, ny: number): void {
    const cx = clamp01(nx);
    const cy = clamp01(ny);
    this.cursor = { x: cx, y: cy };
    const now = performance.now();
    if (this.tool === "laser") {
      this.laserTrail.push({ x: cx, y: cy, t: now });
      // Cap the trail length so the array never grows unbounded if the
      // pointer moves rapidly for a long time.
      if (this.laserTrail.length > 48) {
        this.laserTrail.splice(0, this.laserTrail.length - 48);
      }
    }
    if (this.tool === "highlighter" && this.currentStroke) {
      this.currentStroke.points.push({ x: cx, y: cy });
    }
  }

  /** Highlighter: begin a stroke at the current cursor (mousedown). */
  beginStroke(): void {
    if (this.tool !== "highlighter" || !this.cursor) return;
    this.currentStroke = {
      points: [{ x: this.cursor.x, y: this.cursor.y }],
      createdAt: performance.now(),
    };
    this.strokes.push(this.currentStroke);
  }

  /** Highlighter: end the current stroke (mouseup / pointercancel). */
  endStroke(): void {
    this.currentStroke = null;
  }

  /**
   * Core render: draw the source video frame, then composite laser /
   * highlighter on top in normalized→frame coords. Annotation passes are
   * pure paint, no event handling here.
   */
  private renderFrame(): void {
    const { ctx, canvas } = this;
    if (this.video.readyState >= 2) {
      // drawImage handles the case where width/height change mid-stream;
      // canvas was sized to match in loadedmetadata above.
      ctx.drawImage(this.video, 0, 0, canvas.width, canvas.height);
    } else {
      // Source not ready yet — keep the canvas alive with a black frame
      // so captureStream produces continuous output.
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }

    const now = performance.now();
    if (this.tool === "highlighter" || this.strokes.length > 0) {
      this.drawStrokes(now);
    }
    if (this.tool === "laser" && this.laserTrail.length > 0) {
      this.drawLaser(now);
    }
  }

  // Highlighter strokes: translucent yellow polylines that fade over ~4s.
  // Older strokes are dropped from the array once fully transparent so we
  // don't waste time painting invisible pixels each frame.
  private drawStrokes(now: number): void {
    const { ctx, canvas } = this;
    const lifeMs = 4500;
    const w = canvas.width;
    const h = canvas.height;
    const kept: HighlighterStroke[] = [];
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const stroke of this.strokes) {
      const age = now - stroke.createdAt;
      if (age > lifeMs) continue;
      const alpha = Math.max(0, 1 - age / lifeMs);
      ctx.globalAlpha = alpha * 0.55;
      ctx.strokeStyle = "#facc15"; // tailwind yellow-400
      // Width scales with canvas height so it looks the right thickness
      // whether the share is 720p or 4K.
      ctx.lineWidth = Math.max(6, h * 0.012);
      ctx.beginPath();
      const pts = stroke.points;
      if (pts.length === 1) {
        // Single tap: paint a small dab so it's not invisible.
        ctx.arc(pts[0].x * w, pts[0].y * h, ctx.lineWidth * 0.6, 0, Math.PI * 2);
        ctx.fillStyle = "#facc15";
        ctx.fill();
      } else {
        ctx.moveTo(pts[0].x * w, pts[0].y * h);
        for (let i = 1; i < pts.length; i++) {
          ctx.lineTo(pts[i].x * w, pts[i].y * h);
        }
        ctx.stroke();
      }
      kept.push(stroke);
    }
    ctx.restore();
    this.strokes = kept;
  }

  // Laser pointer: a soft red dot at the head plus a fading trail of the
  // last ~400ms of motion. The trail lets viewers track fast cursor moves.
  private drawLaser(now: number): void {
    const { ctx, canvas } = this;
    const trailLifeMs = 400;
    const w = canvas.width;
    const h = canvas.height;

    // Trail — drop points older than trailLifeMs so the array stays small.
    const trail: LaserPoint[] = [];
    for (const p of this.laserTrail) {
      if (now - p.t <= trailLifeMs) trail.push(p);
    }
    this.laserTrail = trail;
    if (trail.length === 0) return;

    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    // Trail dots: smaller and more transparent the older they are.
    for (let i = 0; i < trail.length - 1; i++) {
      const p = trail[i];
      const age = now - p.t;
      const a = Math.max(0, 1 - age / trailLifeMs);
      const r = Math.max(2, h * 0.004) * (0.35 + a * 0.65);
      ctx.globalAlpha = a * 0.5;
      ctx.fillStyle = "#ef4444"; // tailwind red-500
      ctx.beginPath();
      ctx.arc(p.x * w, p.y * h, r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Head dot: bright red core + soft outer glow. Always fully opaque so
    // viewers see exactly where you're pointing.
    const head = trail[trail.length - 1];
    const cx = head.x * w;
    const cy = head.y * h;
    const coreR = Math.max(4, h * 0.007);
    const glowR = coreR * 3.5;
    // Glow: a radial gradient gives the trademark laser-pointer halo
    // without requiring a separate compositing pass.
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
    grad.addColorStop(0, "rgba(239,68,68,0.95)");
    grad.addColorStop(0.45, "rgba(239,68,68,0.35)");
    grad.addColorStop(1, "rgba(239,68,68,0)");
    ctx.globalAlpha = 1;
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
    ctx.fill();
    // Core dot on top of the glow.
    ctx.fillStyle = "#fef2f2"; // tailwind red-50, near-white center
    ctx.beginPath();
    ctx.arc(cx, cy, coreR * 0.45, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#ef4444";
    ctx.beginPath();
    ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

/**
 * True when canvas.captureStream is callable. Used to decide whether to
 * even attempt the annotation pipeline. Edge currently has a bug where
 * canvas.captureStream produces a black/frozen track for screen-share
 * recomposition (same root cause as the VBG bug fixed by disabling VBG
 * on Edge in PR #40), so we treat Edge as unsupported here too.
 */
export function annotationsSupported(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const c = document.createElement("canvas") as HTMLCanvasElement & {
      captureStream?: (fps?: number) => MediaStream;
    };
    if (typeof c.captureStream !== "function") return false;
    // Edge canvas.captureStream is brittle for recompositing live video —
    // same bug VBG hit. Fall back to plain share there until Microsoft fixes
    // it; the floating bar still works, the annotation toggles just won't
    // appear.
    if (/Edg\//.test(navigator.userAgent || "")) return false;
    return true;
  } catch {
    return false;
  }
}
