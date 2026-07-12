import { useEffect } from "react";

/**
 * Cross-app event bus so bulldog-ops and bulldog-contracts can ask the widget
 * to open a specific job's channels.
 *
 * From the host page:
 *   window.dispatchEvent(new CustomEvent('bulldog:widget:openJob', {
 *     detail: { jobId: 42, source: 'ops' }
 *   }));
 *
 * Detail shape: at least one of jobId, jobRef, or jobNumber must be provided.
 * jobNumber is treated as an alias for jobRef ("BOE-FIBER-01" style).
 * source is a short identifier of the origin ('ops', 'contracts', etc.) —
 * logged but not otherwise used.
 */
export interface OpenJobEventDetail {
  jobId?: number;
  jobRef?: string;
  jobNumber?: string;
  source?: string;
}

export const OPEN_JOB_EVENT = "bulldog:widget:openJob" as const;

/**
 * Minimal shape of the event-target surface we need from `window`. Extracted
 * as an interface (rather than depending on the global `Window` type)
 * so `bindOpenJobListener` can be exercised in tests under plain Node,
 * without jsdom — a shim object satisfying this interface is enough.
 */
export interface OpenJobEventTarget {
  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
}

/**
 * Pure wiring logic behind useOpenJobBus, split out so it's testable without
 * React or a DOM environment: pass any object with add/removeEventListener
 * (a real `window`, or a plain EventTarget/shim in tests) and a handler.
 * Returns an unsubscribe function mirroring a useEffect cleanup.
 */
export function bindOpenJobListener(
  target: OpenJobEventTarget,
  handler: (detail: OpenJobEventDetail) => void,
): () => void {
  const listener = (e: Event) => {
    const custom = e as CustomEvent<OpenJobEventDetail>;
    if (!custom.detail) return;
    handler(custom.detail);
  };
  target.addEventListener(OPEN_JOB_EVENT, listener as EventListener);
  return () => target.removeEventListener(OPEN_JOB_EVENT, listener as EventListener);
}

export function useOpenJobBus(handler: (detail: OpenJobEventDetail) => void) {
  useEffect(() => {
    return bindOpenJobListener(window, handler);
  }, [handler]);
}
