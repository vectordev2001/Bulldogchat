// server/suite-photo-bridge.ts
//
// Outbound photo bridge: Chat → Bulldog Ops (Phase 2.1 / Feature 2.1).
//
// When a message is posted in a channel that maps to a job_site work object
// AND the message carries image attachments, we fire-and-forget a call to
//   POST /api/suite/jobs/:jobId/attach-field-photo
// on the Ops service. Ops upserts today's draft daily_log for the (job,
// author) pair and inserts one daily_log_attachments row per chat attachment.
//
// Auth: shared SUITE_INTERNAL_SECRET header (x-suite-secret) + the author's
// email in x-bulldog-user-email so ops can resolve the foreman on its side.
//
// Rules:
//   - Only fires when channel.workObjectId points at a work_object where
//     kind='job_site' AND attributes.opsJobId is set (Ops sync established
//     the link during from-contract job creation).
//   - Fires only on attachments whose contentType starts with "image/".
//   - Best-effort; a failure here MUST NOT break message send. Errors are
//     logged only.
//
// The Ops receiver was shipped in bulldog-ops#19 (Feature 2.1 DFR schema).

import { storage } from "./storage";
import type { Attachment, WorkObject } from "@shared/schema";

const OPS_BASE_URL = (process.env.OPS_BASE_URL || "https://ops.bulldogops.com").replace(/\/+$/, "");

interface FirePhotoBridgeInput {
  channelId: number;
  messageId: number;
  authorUserId: number;
}

/** Parse job_site opsJobId out of the work_object attributes JSON. */
function extractOpsJobId(wo: WorkObject): number | null {
  if (wo.kind !== "job_site") return null;
  const raw = wo.attributes;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const v = parsed.opsJobId;
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
    if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
  } catch {
    /* fall through */
  }
  return null;
}

function isImageAttachment(a: Attachment): boolean {
  return typeof a.contentType === "string" && a.contentType.toLowerCase().startsWith("image/");
}

/**
 * Fire-and-forget outbound to Ops. Called from POST /api/channels/:id/messages
 * AFTER attachments have been linked to the message.
 *
 * Safe to invoke synchronously — internally wrapped in queueMicrotask so it
 * never blocks the response. Never throws.
 */
export function firePhotoBridgeToOps(input: FirePhotoBridgeInput): void {
  const secret = process.env.SUITE_INTERNAL_SECRET;
  if (!secret) return; // Not configured (dev). Skip silently.

  queueMicrotask(async () => {
    try {
      // Look up channel and confirm it maps to a job_site with opsJobId set.
      const channel = storage.getChannel(input.channelId);
      if (!channel || !channel.workObjectId) return;
      const wo = storage.getWorkObject(channel.workObjectId);
      if (!wo || wo.kind !== "job_site") return;
      const opsJobId = extractOpsJobId(wo);
      if (!opsJobId) return;

      // Resolve author email — required by ops to resolve the foreman.
      const author = storage.getUser(input.authorUserId);
      if (!author?.email) return;

      // Collect image attachments linked to this message.
      const atts = storage.listAttachmentsForMessages([input.messageId]);
      const images = atts.filter(isImageAttachment);
      if (images.length === 0) return;

      const chatAttachmentIds = images.map((a) => a.id);
      const filenames = images.map((a) => a.filename);
      const contentTypes = images.map((a) => a.contentType);
      const sizeBytes = images.map((a) => a.sizeBytes);
      const thumbnailUrls = images.map((a) =>
        a.thumbnailKey ? `${(process.env.CHAT_BASE_URL || "https://chat.bulldogops.com").replace(/\/+$/, "")}/api/files/${a.id}?thumb=1` : null,
      );

      const url = `${OPS_BASE_URL}/api/suite/jobs/${opsJobId}/attach-field-photo`;
      const body = {
        chatAttachmentIds,
        authorEmail: author.email,
        capturedAt: new Date().toISOString(),
        filenames,
        contentTypes,
        sizeBytes,
        thumbnailUrls,
      };

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const resp = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-suite-secret": secret,
            "x-bulldog-user-email": author.email,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          console.warn(
            "[photo-bridge] Ops attach-field-photo failed: status=%d job=%d msg=%d body=%s",
            resp.status,
            opsJobId,
            input.messageId,
            text.slice(0, 300),
          );
        } else {
          console.log(
            "[photo-bridge] Ops attach-field-photo ok: job=%d msg=%d count=%d",
            opsJobId,
            input.messageId,
            images.length,
          );
        }
      } finally {
        clearTimeout(timeout);
      }
    } catch (err) {
      console.warn("[photo-bridge] unexpected error:", (err as Error).message);
    }
  });
}
