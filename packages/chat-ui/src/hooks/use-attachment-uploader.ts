import { useCallback, useRef, useState } from "react";
import { getApiBase, authHeaders } from "../lib/queryClient";
import type { ApiAttachment } from "../types/api";

export const ATTACH_ACCEPT = "image/*,application/pdf,image/heic,image/heif";
const MAX_FILE_BYTES = 25 * 1024 * 1024;

export interface PendingUpload {
  // Client-side id while uploading; replaced by the server attachment id on success.
  localId: string;
  filename: string;
  sizeBytes: number;
  /** 0–100 */
  progress: number;
  status: "uploading" | "done" | "error";
  error?: string;
  /** Populated once the server responds. */
  attachment?: ApiAttachment;
  previewUrl?: string;
}

function isAllowed(file: File): boolean {
  return file.type.startsWith("image/") || file.type === "application/pdf";
}

// POSTs a single file to /api/attachments and reports progress via XHR
// (fetch has no upload-progress events). Resolves with the server attachment.
function uploadOne(file: File, onProgress: (pct: number) => void): Promise<ApiAttachment> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${getApiBase()}/api/attachments`);
    const headers = authHeaders();
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const body = JSON.parse(xhr.responseText);
          const att: ApiAttachment | undefined = body?.attachments?.[0] ?? (Array.isArray(body) ? body[0] : undefined);
          if (att) return resolve(att);
          return reject(new Error("Malformed upload response"));
        } catch {
          return reject(new Error("Malformed upload response"));
        }
      }
      let msg = `Upload failed (${xhr.status})`;
      try { msg = JSON.parse(xhr.responseText)?.message ?? msg; } catch {}
      reject(new Error(msg));
    };
    xhr.onerror = () => reject(new Error("Network error during upload"));
    const fd = new FormData();
    fd.append("files", file);
    xhr.send(fd);
  });
}

/**
 * Uploads files one at a time to /api/attachments with per-file progress.
 * Returns the pending list (for inline preview chips) plus helpers to add,
 * remove, and read the completed attachment ids for message submission.
 */
export function useAttachmentUploader(opts?: { max?: number }) {
  const max = opts?.max ?? 8;
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const counter = useRef(0);

  const addFiles = useCallback((files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;

    setPending((prev) => {
      const room = max - prev.length;
      const accepted = list.filter(isAllowed).slice(0, Math.max(0, room));
      const entries: PendingUpload[] = accepted.map((file) => {
        const localId = `u${counter.current++}`;
        const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined;
        // Kick off the upload outside the state updater.
        queueMicrotask(() => {
          if (file.size > MAX_FILE_BYTES) {
            setPending((p) => p.map((x) => x.localId === localId ? { ...x, status: "error", error: "File too large (max 25 MB)" } : x));
            return;
          }
          uploadOne(file, (pct) => {
            setPending((p) => p.map((x) => x.localId === localId ? { ...x, progress: pct } : x));
          })
            .then((att) => setPending((p) => p.map((x) => x.localId === localId ? { ...x, status: "done", progress: 100, attachment: att } : x)))
            .catch((err) => setPending((p) => p.map((x) => x.localId === localId ? { ...x, status: "error", error: err?.message ?? "Upload failed" } : x)));
        });
        return { localId, filename: file.name, sizeBytes: file.size, progress: 0, status: "uploading", previewUrl };
      });
      return [...prev, ...entries];
    });
  }, [max]);

  const remove = useCallback((localId: string) => {
    setPending((p) => {
      const found = p.find((x) => x.localId === localId);
      if (found?.previewUrl) URL.revokeObjectURL(found.previewUrl);
      return p.filter((x) => x.localId !== localId);
    });
  }, []);

  const clear = useCallback(() => {
    setPending((p) => { p.forEach((x) => x.previewUrl && URL.revokeObjectURL(x.previewUrl)); return []; });
  }, []);

  const uploading = pending.some((x) => x.status === "uploading");
  const readyIds = pending.filter((x) => x.status === "done" && x.attachment).map((x) => x.attachment!.id);

  return { pending, addFiles, remove, clear, uploading, readyIds, atCapacity: pending.length >= max };
}
