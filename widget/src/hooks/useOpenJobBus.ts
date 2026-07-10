import { useEffect } from "react";
import type { ChatApiClient } from "../api";

export interface OpenJobEventDetail {
  jobId: number;
  jobNumber: string;
  source: string;
}

/**
 * Listens for the cross-app `bulldog:widget:openJob` CustomEvent, dispatched
 * by host apps (Contracts, Ops) when the user clicks "Open chat for this
 * job" from their own UI. Detail shape: { jobId, jobNumber, source }.
 *
 * `api` is accepted (not currently used inside the listener itself) so the
 * hook's signature matches callers that may want to validate/prefetch
 * before invoking onJobOpen in a future revision; the actual channel lookup
 * / create-prompt flow lives in BulldogChatWidget's handler, matching how
 * every other ChatApiClient call in this widget is made from the top-level
 * component rather than from inside a hook.
 */
export function useOpenJobBus(
  api: ChatApiClient,
  options: { onJobOpen: (jobId: number, jobNumber: string, source: string) => void },
) {
  useEffect(() => {
    const handler = (e: CustomEvent<OpenJobEventDetail>) => {
      const { jobId, jobNumber, source } = e.detail ?? ({} as OpenJobEventDetail);
      if (typeof jobId === "number") options.onJobOpen(jobId, jobNumber, source);
    };
    window.addEventListener("bulldog:widget:openJob", handler as EventListener);
    return () => window.removeEventListener("bulldog:widget:openJob", handler as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.onJobOpen]);
}
