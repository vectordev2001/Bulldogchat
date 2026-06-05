/**
 * virtual-background.ts — MediaPipe Selfie Segmentation based virtual
 * background processor for the active call.
 *
 * Takes the local camera MediaStreamTrack, runs per-frame person
 * segmentation, composites the person on top of a chosen background
 * (none / blur / image), and exposes the result as a processed
 * MediaStreamTrack that can be published to LiveKit in place of the raw
 * camera track.
 *
 * MediaPipe ships as a WASM bundle. We load it lazily and point its
 * asset loader at the jsDelivr CDN so we don't have to vendor the
 * .wasm/.tflite files into our build. If the dynamic import or model
 * load fails (offline, unsupported browser), start() rejects and the
 * caller falls back to the raw camera track.
 */

export type BackgroundMode =
  | { kind: "none" }
  | { kind: "blur"; amount?: number }
  | { kind: "image"; src: string };

const MEDIAPIPE_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation";

interface SelfieSegmentationResults {
  image: CanvasImageSource;
  segmentationMask: CanvasImageSource;
}

interface SelfieSegmentationInstance {
  setOptions(opts: { modelSelection: number; selfieMode?: boolean }): void;
  onResults(cb: (results: SelfieSegmentationResults) => void): void;
  send(opts: { image: HTMLVideoElement }): Promise<void>;
  close(): void;
}

// Preset gradient backgrounds. Built onto an offscreen 1280x720 canvas at
// processor init so they always fill the frame at the right resolution
// (inline SVGs tiled / rendered at the wrong size).
const PRESET_GRADIENTS: Record<string, [string, string]> = {
  gradient: ["#667eea", "#764ba2"],
  sunset: ["#ff7e5f", "#feb47b"],
  ocean: ["#2e3192", "#1bffff"],
  forest: ["#134e5e", "#71b280"],
};

// Real photo backgrounds. Hosted on Unsplash's CDN with CORS support so
// they can be drawn to a tainted-free canvas and published via captureStream.
// `w=1280&q=80&auto=format&fit=crop` keeps them appropriately sized.
const PRESET_PHOTOS: Record<string, string> = {
  office:
    "https://images.unsplash.com/photo-1497366216548-37526070297c?w=1280&q=80&auto=format&fit=crop",
  conference:
    "https://images.unsplash.com/photo-1517502884422-41eaead166d4?w=1280&q=80&auto=format&fit=crop",
  library:
    "https://images.unsplash.com/photo-1521587760476-6c12a4b040da?w=1280&q=80&auto=format&fit=crop",
  outdoor:
    "https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=1280&q=80&auto=format&fit=crop",
  beach:
    "https://images.unsplash.com/photo-1507525428034-b723cf961d3e?w=1280&q=80&auto=format&fit=crop",
  bokeh:
    "https://images.unsplash.com/photo-1519681393784-d120267933ba?w=1280&q=80&auto=format&fit=crop",
};

export const VIRTUAL_BG_PRESETS = {
  gradients: Object.keys(PRESET_GRADIENTS),
  photos: Object.keys(PRESET_PHOTOS),
};

export class VirtualBackgroundProcessor {
  private inputVideo: HTMLVideoElement | null = null;
  private inputStream: MediaStream | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private segmentation: SelfieSegmentationInstance | null = null;
  // The background source painted behind the person. For presets this is an
  // offscreen canvas built once; for custom uploads it's a loaded <img>.
  private bgImage: CanvasImageSource | null = null;
  private mode: BackgroundMode = { kind: "blur", amount: 8 };
  private rafId: number | null = null;
  private intervalId: number | null = null;
  private inFlight = false;
  private running = false;
  private outputStream: MediaStream | null = null;
  private frameLoopActive = false;
  private frameCount = 0;
  private sizedToVideo = false;
  private gotFirstResult = false;

  /**
   * Start processing. Returns the processed MediaStreamTrack. Throws if
   * MediaPipe can't be loaded so the caller can fall back gracefully.
   */
  async start(sourceTrack: MediaStreamTrack, mode: BackgroundMode): Promise<MediaStreamTrack> {
    this.mode = mode;

    // Lazy-load MediaPipe. The package's default export shape differs
    // across bundlers, so we probe both the named and default forms.
    let SelfieSegmentationCtor: new (cfg: { locateFile: (f: string) => string }) => SelfieSegmentationInstance;
    try {
      const mod: any = await import("@mediapipe/selfie_segmentation");
      SelfieSegmentationCtor =
        mod.SelfieSegmentation || mod.default?.SelfieSegmentation || mod.default;
      if (typeof SelfieSegmentationCtor !== "function") {
        throw new Error("SelfieSegmentation constructor not found");
      }
    } catch (err) {
      throw new Error(`MediaPipe load failed: ${(err as Error).message}`);
    }

    const settings = sourceTrack.getSettings();
    const width = settings.width ?? 640;
    const height = settings.height ?? 480;

    this.inputStream = new MediaStream([sourceTrack]);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = this.inputStream;
    this.inputVideo = video;
    await video.play().catch(() => { /* autoplay can race; loop still reads frames */ });

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    if (!this.ctx) throw new Error("2D canvas context unavailable");

    const seg = new SelfieSegmentationCtor({
      locateFile: (file: string) => `${MEDIAPIPE_CDN}/${file}`,
    });
    // modelSelection 1 = landscape model, better for laptop webcams.
    seg.setOptions({ modelSelection: 1, selfieMode: false });
    seg.onResults((results) => this.drawResults(results));
    this.segmentation = seg;

    if (mode.kind === "image") {
      await this.loadBackgroundImage(mode.src);
    }

    this.running = true;
    this.startFrameLoop();

    // If MediaPipe never delivers a result within 3s (model load failed,
    // unsupported browser), fall back to the raw camera track.
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        if (!this.gotFirstResult) {
          console.warn("[virtual-bg] segmentation not initializing, falling back");
          reject(new Error("segmentation did not initialize within 3s"));
        }
      }, 3000);
      const check = () => {
        if (!this.running) { clearTimeout(deadline); resolve(); return; }
        if (this.gotFirstResult) { clearTimeout(deadline); resolve(); return; }
        setTimeout(check, 100);
      };
      check();
    });

    // captureStream throws on very old browsers — that's a hard fallback.
    const out = (canvas as HTMLCanvasElement & { captureStream?(fps?: number): MediaStream }).captureStream?.(24);
    if (!out) throw new Error("canvas.captureStream unsupported");
    this.outputStream = out;
    const track = out.getVideoTracks()[0];
    if (!track) throw new Error("no output video track produced");
    return track;
  }

  /** Swap the background without restarting segmentation. */
  async setMode(mode: BackgroundMode): Promise<void> {
    this.mode = mode;
    if (mode.kind === "image") {
      await this.loadBackgroundImage(mode.src);
    } else {
      this.bgImage = null;
    }
  }

  private async loadBackgroundImage(src: string): Promise<void> {
    // Preset gradients are drawn onto an offscreen canvas rather than loaded
    // as an image, so they fill the frame at full resolution.
    if (src.startsWith("preset:")) {
      const id = src.slice("preset:".length);
      const stops = PRESET_GRADIENTS[id] ?? PRESET_GRADIENTS.gradient;
      const c = document.createElement("canvas");
      c.width = 1280;
      c.height = 720;
      const cctx = c.getContext("2d");
      if (!cctx) throw new Error("2D canvas context unavailable");
      const grad = cctx.createLinearGradient(0, 0, c.width, c.height);
      grad.addColorStop(0, stops[0]);
      grad.addColorStop(1, stops[1]);
      cctx.fillStyle = grad;
      cctx.fillRect(0, 0, c.width, c.height);
      this.bgImage = c;
      return;
    }
    // Photo presets resolve to a hosted CDN URL. We fall through to the same
    // <img> load path as custom uploads.
    let resolvedSrc = src;
    if (src.startsWith("photo:")) {
      const id = src.slice("photo:".length);
      resolvedSrc = PRESET_PHOTOS[id] ?? PRESET_PHOTOS.office;
    }
    await new Promise<void>((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => { this.bgImage = img; resolve(); };
      img.onerror = () => reject(new Error("background image failed to load"));
      img.src = resolvedSrc;
    });
  }

  // The processing canvas is offscreen (never attached to the DOM), so
  // requestAnimationFrame gets throttled to ~0 fps by Chrome after a couple
  // frames when nothing visible references the canvas — the raw camera tile
  // is what's actually rendered in the call HUD, not our processed canvas.
  // That left the published track frozen on its very first frame, which
  // looked like "the background didn't apply." Drive the loop with
  // setInterval instead (~30 fps) with an in-flight guard so we don't queue
  // up MediaPipe sends faster than the model can complete them.
  private startFrameLoop(): void {
    if (this.frameLoopActive) return;
    this.frameLoopActive = true;
    const SEND_TIMEOUT_MS = 1500;
    const tick = async () => {
      if (!this.running || !this.inputVideo || !this.segmentation) return;
      if (this.inFlight) return;
      if (this.inputVideo.readyState < 2 || this.inputVideo.paused) return;
      // MediaPipe never resolves send() if the underlying camera track has
      // ended (e.g. user toggled camera off mid-call). Without a hard timeout
      // that leaves `inFlight = true` forever and the loop silently dies, or
      // worse, the page hangs on shutdown because close() is waiting for an
      // in-flight send. Race the send against a 1.5s timeout.
      this.inFlight = true;
      try {
        await Promise.race([
          this.segmentation.send({ image: this.inputVideo }),
          new Promise((_, reject) => setTimeout(() => reject(new Error("send timeout")), SEND_TIMEOUT_MS)),
        ]);
      } catch {
        /* a dropped/timed-out frame is non-fatal; next tick will retry */
      } finally {
        this.inFlight = false;
      }
    };
    this.intervalId = window.setInterval(() => { void tick(); }, 33);
  }

  // MediaPipe's segmentationMask is an RGBA image where person pixels are
  // bright (close to white, alpha=1) and background pixels are dark
  // (close to black, alpha=1). The alpha channel is NOT encoded — the mask
  // is fully opaque everywhere — so directly using `source-in` against the
  // raw mask doesn't isolate the person; it keeps the whole frame.
  //
  // The trick is to convert mask brightness into true alpha. We do this by
  // drawing the mask onto a tiny scratch canvas, walking its ImageData to
  // copy red→alpha (and zero RGB so it becomes a pure alpha shape), then
  // using that as a proper alpha mask via `destination-in`.
  private maskScratch: HTMLCanvasElement | null = null;
  private maskScratchCtx: CanvasRenderingContext2D | null = null;
  private personScratch: HTMLCanvasElement | null = null;
  private personScratchCtx: CanvasRenderingContext2D | null = null;

  private buildAlphaMask(src: CanvasImageSource, w: number, h: number): HTMLCanvasElement {
    if (!this.maskScratch) {
      this.maskScratch = document.createElement("canvas");
      this.maskScratchCtx = this.maskScratch.getContext("2d", { willReadFrequently: true });
    }
    const mc = this.maskScratch!;
    const mctx = this.maskScratchCtx!;
    if (mc.width !== w) mc.width = w;
    if (mc.height !== h) mc.height = h;
    mctx.clearRect(0, 0, w, h);
    mctx.drawImage(src, 0, 0, w, h);
    const img = mctx.getImageData(0, 0, w, h);
    const data = img.data;
    // Convert luminance → alpha with a sigmoid-style remap that pushes
    // confident-person pixels closer to fully opaque and confident-background
    // pixels closer to fully transparent while leaving a soft transition band
    // in the uncertain middle. This kills the greenscreen-style speckle along
    // hair/shoulder edges without producing a hard cut-out silhouette.
    //   t<0.35 → 0   (clearly background)
    //   t>0.65 → 255 (clearly person)
    //   between → smoothstep, then blurred below for a feathered border.
    for (let i = 0; i < data.length; i += 4) {
      const t = data[i] / 255;
      let a: number;
      if (t <= 0.35) a = 0;
      else if (t >= 0.65) a = 255;
      else {
        // Hermite smoothstep on the [0.35, 0.65] band.
        const x = (t - 0.35) / 0.3;
        a = Math.round(x * x * (3 - 2 * x) * 255);
      }
      data[i + 3] = a;
      data[i] = 0; data[i + 1] = 0; data[i + 2] = 0;
    }
    mctx.putImageData(img, 0, 0);
    // Feather the alpha boundary with a small Gaussian blur. We re-draw the
    // canvas to itself through ctx.filter — works on all modern browsers we
    // target. The blur radius scales with frame width so a 1280-wide feed
    // gets a wider feather than a 320-wide one.
    const featherPx = Math.max(2, Math.round(w / 320));
    mctx.save();
    mctx.globalCompositeOperation = "copy";
    mctx.filter = `blur(${featherPx}px)`;
    mctx.drawImage(mc, 0, 0, w, h);
    mctx.restore();
    return mc;
  }

  // Composite the segmented person over the chosen background.
  //
  // This uses the canonical MediaPipe Selfie Segmentation demo pattern
  // ("draw mask → source-in image → destination-over background") because
  // it works regardless of whether the mask is alpha-encoded or intensity-
  // encoded. Steps on the output canvas:
  //   1. Draw the segmentation mask. After this draw, pixels inside the
  //      person silhouette are opaque; outside pixels are either transparent
  //      (alpha-encoded build) or dark grayscale on opaque (intensity build).
  //      Either way, what we need next is to keep the camera frame only where
  //      this mask is *bright* — for that we run it through a tiny
  //      luminance→alpha pass on a scratch canvas first so it behaves the
  //      same across builds.
  //   2. globalCompositeOperation = source-in, then drawImage(camera) — the
  //      camera frame replaces the mask only where the mask is opaque, so
  //      what remains is "person" on transparent.
  //   3. globalCompositeOperation = destination-over, then draw the chosen
  //      background — fills the still-transparent (non-person) area.
  private drawResults(results: SelfieSegmentationResults): void {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return;

    if (!this.sizedToVideo && this.inputVideo && this.inputVideo.videoWidth > 0) {
      canvas.width = this.inputVideo.videoWidth;
      canvas.height = this.inputVideo.videoHeight;
      this.sizedToVideo = true;
    }

    this.gotFirstResult = true;
    if (this.frameCount < 3) {
      console.log(
        "[virtual-bg] frame",
        this.frameCount,
        "mask?",
        !!results.segmentationMask,
        "mode",
        this.mode.kind,
      );
    }
    this.frameCount++;

    const w = canvas.width;
    const h = canvas.height;

    // 1) Normalize the mask to a luminance→alpha shape on a scratch canvas
    //    so the composition path is identical for both mask encodings.
    const alphaMask = this.buildAlphaMask(results.segmentationMask, w, h);

    ctx.save();
    ctx.filter = "none";
    ctx.clearRect(0, 0, w, h);

    // 2) Paint the alpha mask, then `source-in` with the camera frame.
    //    Result: person pixels visible, rest transparent.
    ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(alphaMask, 0, 0, w, h);
    ctx.globalCompositeOperation = "source-in";
    ctx.drawImage(results.image, 0, 0, w, h);

    // 3) Drop the background underneath everything that's still transparent.
    ctx.globalCompositeOperation = "destination-over";
    if (this.mode.kind === "blur") {
      const blur = this.mode.amount ?? 12;
      ctx.filter = `blur(${blur}px)`;
      ctx.drawImage(results.image, 0, 0, w, h);
      ctx.filter = "none";
    } else if (this.mode.kind === "image" && this.bgImage) {
      this.drawCover(ctx, this.bgImage, w, h);
    } else {
      // "none" fallthrough — shouldn't normally hit here because the caller
      // tears the processor down for kind=="none", but draw the raw frame as
      // a safe default.
      ctx.drawImage(results.image, 0, 0, w, h);
    }

    ctx.restore();
  }

  // object-fit: cover for the background source (preset canvas or uploaded img).
  private drawCover(ctx: CanvasRenderingContext2D, src: CanvasImageSource, w: number, h: number): void {
    const sw = (src as { width?: number }).width ?? w;
    const sh = (src as { height?: number }).height ?? h;
    const ir = sw / sh;
    const cr = w / h;
    let dw = w, dh = h, dx = 0, dy = 0;
    if (ir > cr) { dh = h; dw = h * ir; dx = (w - dw) / 2; }
    else { dw = w; dh = w / ir; dy = (h - dh) / 2; }
    ctx.drawImage(src, dx, dy, dw, dh);
  }

  stop(): void {
    // Order matters: clear the timer FIRST so no further send() can be
    // enqueued, then mark the processor as stopped, then tear down MediaPipe.
    // close() can race with an in-flight send() on Chromium and lock the main
    // thread for several seconds ("Page Unresponsive") if we let one slip in.
    if (this.intervalId != null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.running = false;
    this.frameLoopActive = false;
    this.inFlight = false;
    try { this.outputStream?.getTracks().forEach(t => t.stop()); } catch { /* ignore */ }
    try { this.segmentation?.close(); } catch { /* ignore */ }
    this.segmentation = null;
    if (this.inputVideo) {
      try { this.inputVideo.pause(); } catch { /* ignore */ }
      this.inputVideo.srcObject = null;
      this.inputVideo = null;
    }
    this.inputStream = null;
    this.outputStream = null;
    this.canvas = null;
    this.ctx = null;
    this.bgImage = null;
    this.frameCount = 0;
    this.sizedToVideo = false;
    this.gotFirstResult = false;
  }
}
