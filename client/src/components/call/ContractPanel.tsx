/**
 * ContractPanel — resizable right-side panel that shows a linked contract
 * PDF in a sandboxed iframe during an active call. Drag the left edge to
 * resize (clamped 280–800px).
 */
import { useCallback, useEffect, useRef } from "react";
import { X, FileText } from "lucide-react";

const MIN_W = 280;
const MAX_W = 800;

export function ContractPanel({
  title,
  pdfUrl,
  width,
  onWidthChange,
  onClose,
}: {
  title: string;
  pdfUrl: string;
  width: number;
  onWidthChange: (w: number) => void;
  onClose: () => void;
}) {
  const draggingRef = useRef(false);

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
      <iframe
        src={pdfUrl}
        title={title}
        sandbox="allow-same-origin allow-scripts allow-popups"
        className="flex-1 w-full bg-white"
      />
    </div>
  );
}
