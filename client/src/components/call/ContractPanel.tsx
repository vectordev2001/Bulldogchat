/**
 * ContractPanel — resizable right-side panel that shows a linked contract
 * PDF during an active call. Drag the left edge to resize (clamped
 * 280–800px).
 *
 * The PDF is fetched same-origin through the chat server proxy
 * (/api/contracts-proxy/:channelId) which forwards the session auth to the
 * contracts service and streams the bytes back. We then render the bytes via
 * a blob object URL inside an <object> tag — loading the cross-origin file
 * directly 401s because the auth cookie doesn't ride along on a document load.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { X, FileText, Loader2, AlertTriangle, ExternalLink } from "lucide-react";

const MIN_W = 280;
const MAX_W = 800;

export function ContractPanel({
  title,
  channelId,
  pdfUrl,
  width,
  onWidthChange,
  onClose,
}: {
  title: string;
  channelId: number;
  // Original cross-origin URL — used only for the "open in new tab" fallback.
  pdfUrl: string;
  width: number;
  onWidthChange: (w: number) => void;
  onClose: () => void;
}) {
  const draggingRef = useRef(false);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    draggingRef.current = true;
  }, []);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      // Panel is docked right: width grows as the cursor moves left.
      const next = Math.min(MAX_W, Math.max(MIN_W, window.innerWidth - e.clientX));
      onWidthChange(next);
    };
    const onUp = () => { draggingRef.current = false; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [onWidthChange]);

  // Fetch the PDF through the same-origin proxy and hand it to <object> as a
  // blob URL. credentials:"include" sends the session cookie automatically.
  useEffect(() => {
    let revokeUrl: string | null = null;
    let cancelled = false;
    setError(null);
    setObjectUrl(null);
    fetch(`/api/contracts-proxy/${channelId}`, { credentials: "include" })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(`PDF ${r.status}`))))
      .then((blob) => {
        if (cancelled) return;
        const url = URL.createObjectURL(blob);
        revokeUrl = url;
        setObjectUrl(url);
      })
      .catch((e) => { if (!cancelled) setError(e.message || "Failed to load PDF"); });
    return () => {
      cancelled = true;
      if (revokeUrl) URL.revokeObjectURL(revokeUrl);
    };
  }, [channelId]);

  return (
    <div
      className="relative shrink-0 h-full flex flex-col bg-[hsl(232_55%_11%)] border-l border-[hsl(232_40%_22%)]"
      style={{ width }}
      data-testid="panel-contract"
    >
      {/* Drag handle */}
      <div
        onMouseDown={onMouseDown}
        className="absolute left-0 top-0 bottom-0 w-1.5 -ml-0.5 cursor-col-resize hover:bg-vs-blue/40 z-10"
        title="Drag to resize"
        data-testid="contract-panel-resize"
      />
      <div className="h-12 px-3 flex items-center gap-2 border-b border-[hsl(232_40%_22%)] shrink-0">
        <FileText className="w-4 h-4 text-vs-blue-light shrink-0" />
        <span className="text-sm font-display text-white truncate flex-1">{title}</span>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded text-[hsl(0_0%_70%)] hover:text-white hover:bg-black/30"
          aria-label="Close contract"
          data-testid="button-close-contract"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="flex-1 min-h-0 relative bg-white">
        {objectUrl ? (
          <object
            data={objectUrl}
            type="application/pdf"
            className="w-full h-full"
            data-testid="contract-pdf-object"
          >
            <div className="flex flex-col items-center justify-center h-full gap-2 text-[hsl(232_30%_30%)] p-4 text-center text-sm">
              <span>Preview unavailable in this browser.</span>
              <a
                href={pdfUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-vs-blue hover:underline"
              >
                <ExternalLink className="w-3.5 h-3.5" /> Open in new tab
              </a>
            </div>
          </object>
        ) : error ? (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-[hsl(232_30%_35%)] p-4 text-center text-sm">
            <AlertTriangle className="w-6 h-6 text-vs-red" />
            <span>Couldn't load contract PDF ({error}).</span>
            <a
              href={pdfUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-vs-blue hover:underline"
              data-testid="link-open-contract-tab"
            >
              <ExternalLink className="w-3.5 h-3.5" /> Open in new tab
            </a>
          </div>
        ) : (
          <div className="flex items-center justify-center h-full text-[hsl(232_30%_40%)]">
            <Loader2 className="w-6 h-6 animate-spin" />
          </div>
        )}
      </div>
    </div>
  );
}
