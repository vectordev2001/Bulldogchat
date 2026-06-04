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
  office: ["#4a5568", "#2d3748"],
  library: ["#7c4a2d", "#5d3520"],
  outdoor: ["#5b9bd5", "#3a7ca5"],
  gradient: ["#667eea", "#764ba2"],
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
    await new Promise<void>((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => { this.bgImage = img; resolve(); };
      img.onerror = () => reject(new Error("background image failed to load"));
      img.src = src;
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
    // Convert luminance → alpha. Many MediaPipe builds output grayscale where
    // R=G=B=intensity; we read R as the intensity and use it as alpha.
    for (let i = 0; i < data.length; i += 4) {
      data[i + 3] = data[i];
      data[i] = 0; data[i + 1] = 0; data[i + 2] = 0;
    }
    mctx.putImageData(img, 0, 0);
    return mc;
  }

  // Composite the segmented person over the chosen background.
  //   1. Build a real alpha mask from MediaPipe's intensity mask.
  //   2. On a person scratch canvas, draw the camera frame, then
  //      destination-in with the alpha mask → person on transparent bg.
  //   3. On the output canvas: paint the background, then drop the person on top.
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

    // Build/refresh the person scratch canvas.
    if (!this.personScratch) {
      this.personScratch = document.createElement("canvas");
      this.personScratchCtx = this.personScratch.getContext("2d");
    }
    const pc = this.personScratch!;
    const pctx = this.personScratchCtx!;
    if (pc.width !== w) pc.width = w;
    if (pc.height !== h) pc.height = h;

    // 1) Convert the intensity mask into a real alpha mask.
    const alphaMask = this.buildAlphaMask(results.segmentationMask, w, h);

    // 2) Draw the camera frame, then clip to the alpha mask → person only.
    pctx.save();
    pctx.globalCompositeOperation = "source-over";
    pctx.clearRect(0, 0, w, h);
    pctx.drawImage(results.image, 0, 0, w, h);
    pctx.globalCompositeOperation = "destination-in";
    pctx.drawImage(alphaMask, 0, 0, w, h);
    pctx.restore();

    // 3) Output canvas: draw background, then the person on top.
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.filter = "none";
    ctx.clearRect(0, 0, w, h);
    if (this.mode.kind === "blur") {
      const blur = this.mode.amount ?? 12;
      ctx.filter = `blur(${blur}px)`;
      ctx.drawImage(results.image, 0, 0, w, h);
      ctx.filter = "none";
    } else if (this.mode.kind === "image" && this.bgImage) {
      this.drawCover(ctx, this.bgImage, w, h);
    } else {
      ctx.drawImage(results.image, 0, 0, w, h);
    }
    ctx.drawImage(pc, 0, 0, w, h);

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
