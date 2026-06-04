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

  private startFrameLoop(): void {
    if (this.frameLoopActive) return;
    this.frameLoopActive = true;
    const pump = async () => {
      if (!this.running || !this.inputVideo || !this.segmentation) {
        this.frameLoopActive = false;
        return;
      }
      try {
        if (this.inputVideo.readyState >= 2) {
          await this.segmentation.send({ image: this.inputVideo });
        }
      } catch {
        /* a dropped frame is non-fatal; keep pumping */
      }
      this.rafId = requestAnimationFrame(() => { void pump(); });
    };
    void pump();
  }

  // Composite the segmented person over the chosen background, single-canvas:
  //   1. draw the mask, 2. `source-in` keeps the camera frame only where the
  //   mask is opaque (the person), 3. `destination-over` paints the background
  //   behind the already-drawn person. globalCompositeOperation is reset every
  //   frame via save()/restore() so a previous frame's op never leaks.
  private drawResults(results: SelfieSegmentationResults): void {
    const ctx = this.ctx;
    const canvas = this.canvas;
    if (!ctx || !canvas) return;

    // Size the output canvas to the actual video on the first usable frame.
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

    ctx.save();
    ctx.clearRect(0, 0, w, h);

    // 1) Draw segmentation mask.
    ctx.drawImage(results.segmentationMask, 0, 0, w, h);

    // 2) Keep only the person (where the mask is opaque).
    ctx.globalCompositeOperation = "source-in";
    ctx.drawImage(results.image, 0, 0, w, h);

    // 3) Draw the background behind the person.
    ctx.globalCompositeOperation = "destination-over";
    if (this.mode.kind === "blur") {
      const blur = this.mode.amount ?? 12;
      ctx.filter = `blur(${blur}px)`;
      ctx.drawImage(results.image, 0, 0, w, h);
      ctx.filter = "none";
    } else if (this.mode.kind === "image" && this.bgImage) {
      this.drawCover(ctx, this.bgImage, w, h);
    } else {
      // "none" → original frame behind (effectively passthrough).
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
    this.running = false;
    if (this.rafId != null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
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
