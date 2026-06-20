import { useState } from "react";
import { FileText, Download, X, ZoomIn } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import type { ApiAttachment } from "@/types/api";

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function isImage(a: ApiAttachment): boolean {
  return a.contentType.startsWith("image/");
}

function isPdf(a: ApiAttachment): boolean {
  return a.contentType === "application/pdf" || a.filename.toLowerCase().endsWith(".pdf");
}

export function AttachmentList({ atts }: { atts: ApiAttachment[] }) {
  const [lightbox, setLightbox] = useState<ApiAttachment | null>(null);
  const images = atts.filter(isImage);
  const others = atts.filter((a) => !isImage(a));

  return (
    <>
      {images.length > 0 && (
        <div className={`mt-2 grid gap-2 ${images.length === 1 ? "grid-cols-1 max-w-md" : "grid-cols-2 max-w-lg"}`}>
          {images.map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setLightbox(a)}
              className="relative group rounded-lg overflow-hidden bg-[hsl(220_60%_9%)] border border-[hsl(220_40%_22%)] hover:border-vs-red transition-colors"
              data-testid={`attachment-image-${a.id}`}
            >
              <img
                src={a.thumbnailUrl ?? a.url}
                alt={a.filename}
                className="w-full h-auto max-h-72 object-cover"
                loading="lazy"
              />
              <div className="absolute inset-0 bg-black/0 group-hover:bg-black/30 transition-colors flex items-center justify-center">
                <ZoomIn className="w-6 h-6 text-white opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
              <div className="absolute bottom-0 left-0 right-0 px-2 py-1 bg-gradient-to-t from-black/80 to-transparent">
                <div className="text-[11px] text-white/90 truncate">{a.filename}</div>
              </div>
            </button>
          ))}
        </div>
      )}
      {others.length > 0 && (
        <div className="mt-2 space-y-1.5 max-w-md">
          {others.map((a) => (
            <a
              key={a.id}
              href={a.url}
              target="_blank"
              rel="noreferrer noopener"
              className="flex items-center gap-3 px-3 py-2 rounded-lg bg-[hsl(220_50%_16%)] border border-[hsl(220_40%_22%)] hover:border-vs-red transition-colors group"
              data-testid={`attachment-file-${a.id}`}
            >
              <div className="w-9 h-9 rounded-md bg-[hsl(174_70%_55%/0.18)] border border-[hsl(174_70%_55%/0.4)] flex items-center justify-center shrink-0">
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
              className="absolute top-4 right-4 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center"
              onClick={() => setLightbox(null)}
              title="Close (Esc)"
            >
              <X className="w-5 h-5" />
            </button>
            <a
              href={lightbox.url}
              download={lightbox.filename}
              onClick={(e) => e.stopPropagation()}
              className="absolute top-4 right-16 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center"
              title="Download"
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
