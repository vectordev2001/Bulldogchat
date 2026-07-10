import { useEffect, useRef } from "react";

// ── useRingtone ──────────────────────────────────────────────────────────────
// Small WebAudio synthesizer for call ringback / incoming chime, ported from
// client/src/lib/CallContext.tsx of the main Bulldogchat app. We use WebAudio
// (not <audio> + mp3) so the widget package stays asset-free and doesn't need
// bundlers/hosts to serve extra files. AudioContext is created lazily on the
// first ring so we don't spam permission prompts on browsers that treat
// getUserMedia + AudioContext together as "media capture".
//
// Modes:
//   - "outgoing"  → caller ringback (2s on / 4s off, 440+480Hz)
//   - "incoming"  → callee chime (E5→G5 every 3s, softer)
//   - null        → silent
//
// The hook fully manages start/stop across mode changes and unmount.

export type RingMode = "outgoing" | "incoming" | null;

export function useRingtone(mode: RingMode) {
  const ctxRef = useRef<AudioContext | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    // Always tear down any prior burst schedule when the mode changes.
    stopRef.current?.();
    stopRef.current = null;

    if (!mode) return;

    // Lazily create a single shared AudioContext. `webkitAudioContext` is the
    // Safari <14 fallback but harmless to include.
    if (!ctxRef.current) {
      try {
        const Ctor =
          (window.AudioContext ||
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (window as any).webkitAudioContext) as typeof AudioContext | undefined;
        if (!Ctor) return;
        ctxRef.current = new Ctor();
      } catch {
        return;
      }
    }
    const ctx = ctxRef.current;
    if (!ctx) return;
    // Some browsers keep the context suspended until a user gesture — resume
    // is a no-op if it's already running. If it fails we still fall through;
    // the modal is still visible.
    ctx.resume().catch(() => {});

    let cancelled = false;
    let timerId: number | null = null;
    const clearTimer = () => {
      if (timerId !== null) {
        window.clearTimeout(timerId);
        timerId = null;
      }
    };
    stopRef.current = () => {
      cancelled = true;
      clearTimer();
    };

    if (mode === "outgoing") {
      // Ringback: two-tone (440 + 480 Hz) 2s bursts every 6s.
      const scheduleBurst = () => {
        if (cancelled) return;
        const t0 = ctx.currentTime;
        const burstLen = 2.0;
        const master = ctx.createGain();
        master.gain.value = 0;
        master.gain.setValueAtTime(0, t0);
        master.gain.linearRampToValueAtTime(0.12, t0 + 0.03);
        master.gain.setValueAtTime(0.12, t0 + burstLen - 0.03);
        master.gain.linearRampToValueAtTime(0, t0 + burstLen);
        master.connect(ctx.destination);
        for (const freq of [440, 480]) {
          const osc = ctx.createOscillator();
          osc.type = "sine";
          osc.frequency.value = freq;
          osc.connect(master);
          osc.start(t0);
          osc.stop(t0 + burstLen);
        }
        timerId = window.setTimeout(scheduleBurst, 6000);
      };
      scheduleBurst();
    } else if (mode === "incoming") {
      // Callee chime: E5 → G5 short chime every 3s.
      const scheduleChime = () => {
        if (cancelled) return;
        const t0 = ctx.currentTime;
        const master = ctx.createGain();
        master.gain.value = 0;
        master.connect(ctx.destination);
        const notes: Array<{ freq: number; start: number; len: number }> = [
          { freq: 659.25, start: 0.0, len: 0.22 },
          { freq: 783.99, start: 0.18, len: 0.28 },
        ];
        for (const n of notes) {
          const osc = ctx.createOscillator();
          osc.type = "sine";
          osc.frequency.value = n.freq;
          const g = ctx.createGain();
          g.gain.setValueAtTime(0, t0 + n.start);
          g.gain.linearRampToValueAtTime(0.18, t0 + n.start + 0.02);
          g.gain.setValueAtTime(0.18, t0 + n.start + n.len - 0.04);
          g.gain.linearRampToValueAtTime(0, t0 + n.start + n.len);
          osc.connect(g);
          g.connect(master);
          osc.start(t0 + n.start);
          osc.stop(t0 + n.start + n.len + 0.02);
        }
        timerId = window.setTimeout(scheduleChime, 3000);
      };
      scheduleChime();
    }

    return () => {
      stopRef.current?.();
      stopRef.current = null;
    };
  }, [mode]);

  // Tear down the audio context on unmount (page navigation / logout).
  useEffect(() => {
    return () => {
      stopRef.current?.();
      stopRef.current = null;
      ctxRef.current?.close().catch(() => {});
      ctxRef.current = null;
    };
  }, []);
}
