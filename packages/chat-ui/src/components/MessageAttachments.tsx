import { useEffect, useState } from "react";
import { FileText, Download, X, ZoomIn } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import type { ApiAttachment } from "../types/api";

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function isImage(a: ApiAttachment): boolean {
  return a.contentType.startsWith("image/");
}

function isGif(a: ApiAttachment): boolean {
  return a.contentType === "image/gif" || a.filename.toLowerCase().endsWith(".gif");
}

// For animated GIFs we ALWAYS render the original url in the grid preview.
// Historical uploads still carry a WebP thumbnail (baked pre-fix), which is
// a still first-frame — rendering the thumbnail would freeze the animation
// and the user would see it as a static image ("why is my GIF a PNG"). New
// uploads skip thumbnail generation for GIFs server-side, so this is just
// belt + suspenders for both paths.
function previewSrc(a: ApiAttachment): string {
  if (isGif(a)) return a.url;
  return a.thumbnailUrl ?? a.thumbUrl ?? a.url;
}

function isPdf(a: ApiAttachment): boolean {
  return a.contentType === "application/pdf" || a.filename.toLowerCase().endsWith(".pdf");
}

// downloadUrl is the spec field; fall back to url + ?download=1 for older payloads.
function downloadHref(a: ApiAttachment): string {
  if (a.downloadUrl) return a.downloadUrl;
  return a.url.includes("?") ? `${a.url}&download=1` : `${a.url}?download=1`;
}

const MAX_VISIBLE = 4;

/**
 * Renders the attachments attached to a chat message. Built mobile-first for
 * field-crew threads: large tap targets (≥44pt), lazy-loaded thumbnails, and a
 * fullscreen lightbox with keyboard (Esc) + click-outside dismissal.
 */
export function MessageAttachments({ atts }: { atts: ApiAttachment[] }) {
  const [lightbox, setLightbox] = useState<ApiAttachment | null>(null);
  const images = atts.filter(isImage);
  const others = atts.filter((a) => !isImage(a));
  const visibleImages = images.slice(0, MAX_VISIBLE);
  const overflow = images.length - visibleImages.length;

  // Esc closes the lightbox.
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setLightbox(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);

  if (atts.length === 0) return null;

  return (
    <>
      {visibleImages.length > 0 && (
        <div
          className={`mt-2 grid gap-2 ${visibleImages.length === 1 ? "grid-cols-1 max-w-md" : "grid-cols-2 max-w-lg"}`}
          data-testid="message-attachments-images"
        >
          {visibleImages.map((a, idx) => {
            const showOverlay = idx === MAX_VISIBLE - 1 && overflow > 0;
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => setLightbox(a)}
                className="relative group rounded-lg overflow-hidden bg-[hsl(220_60%_9%)] border border-[hsl(220_40%_22%)] hover:border-vs-red transition-colors min-h-[44px]"
                data-testid={`attachment-image-${a.id}`}
              >
                <img
                  src={previewSrc(a)}
                  alt={a.filename}
                  className="w-full h-auto max-h-80 object-cover"
                  loading="lazy"
                  width={a.width ?? undefined}
                  height={a.height ?? undefined}
                />
                {showOverlay ? (
                  <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                    <span className="text-white text-lg font-semibold">+{overflow + 1}</span>
                  </div>
                ) : (
                  <>
                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
                      <ZoomIn className="w-6 h-6 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>
                    <div className="absolute bottom-0 left-0 right-0 px-2 py-1 bg-gradient-to-t from-black/80 to-transparent">
                      <div className="text-[11px] text-white/90 truncate">{a.filename}</div>
                    </div>
                  </>
                )}
              </button>
            );
          })}
        </div>
      )}

      {others.length > 0 && (
        <div className="mt-2 space-y-1.5 max-w-md" data-testid="message-attachments-files">
          {others.map((a) => (
            <a
              key={a.id}
              href={downloadHref(a)}
              target="_blank"
              rel="noreferrer noopener"
              className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-[hsl(220_50%_16%)] border border-[hsl(220_40%_22%)] hover:border-vs-red transition-colors group min-h-[44px]"
              data-testid={`attachment-file-${a.id}`}
            >
              <div className="w-9 h-9 rounded-md bg-[hsl(var(--vs-accent)/0.18)] border border-[hsl(var(--vs-accent)/0.4)] flex items-center justify-center shrink-0">
                <FileText className="w-4 h-4 text-vs-red" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-sm text-white truncate">{a.filename}</div>
                <div className="text-[11px] text-[hsl(0_0%_60%)] font-mono">
                  {isPdf(a) ? "PDF" : a.contentType.split("/")[1]?.toUpperCase() ?? "FILE"} · {fmtSize(a.sizeBytes)}
                </div>
              </div>
              <Download className="w-4 h-4 text-[hsl(0_0%_60%)] group-hover:text-vs-red shrink-0" />
            </a>
          ))}
        </div>
      )}

      <AnimatePresence>
        {lightbox && (
          <motion.div
            className="fixed inset-0 z-[60] bg-black/90 flex items-center justify-center p-6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setLightbox(null)}
            data-testid="modal-lightbox"
          >
            <button
              type="button"
              className="absolute top-4 right-4 w-11 h-11 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center"
              onClick={() => setLightbox(null)}
              title="Close (Esc)"
              data-testid="button-lightbox-close"
            >
              <X className="w-5 h-5" />
            </button>
            <a
              href={downloadHref(lightbox)}
              download={lightbox.filename}
              onClick={(e) => e.stopPropagation()}
              className="absolute top-4 right-[4.5rem] w-11 h-11 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center"
              title="Download"
              data-testid="button-lightbox-download"
            >
              <Download className="w-5 h-5" />
            </a>
            <motion.img
              src={lightbox.url}
              alt={lightbox.filename}
              className="max-w-full max-h-full object-contain rounded-lg shadow-2xl"
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
            />
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-md bg-black/70 text-white text-sm font-mono">
              {lightbox.filename} · {fmtSize(lightbox.sizeBytes)}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
