/**
 * VirtualBackgroundPicker — popover for choosing a call virtual background.
 * Options: None / Blur / four preset gradient scenes (rendered onto an
 * offscreen canvas by the processor) / upload a custom image. The chosen
 * selection is persisted to localStorage and reported to the parent via
 * onSelect.
 */
import { useRef } from "react";
import { X, Upload, CircleSlash, Aperture } from "lucide-react";
import type { BackgroundMode } from "@/lib/virtual-background";

export interface BgSelection {
  mode: BackgroundMode;
  /** Stable id used to highlight the active swatch + persist to storage. */
  id: string;
}

// Preset "scenes" are gradient backgrounds. The src is a `preset:<id>`
// sentinel — the processor builds the actual gradient onto an offscreen
// canvas at the video resolution (avoids SVG-tiling/dimension issues).
// `swatchStyle` is the matching CSS gradient used to render the picker swatch.
const PRESETS: Array<{ id: string; label: string; src: string; swatchStyle: string }> = [
  { id: "office", label: "Office", src: "preset:office", swatchStyle: "linear-gradient(135deg, #4a5568, #2d3748)" },
  { id: "library", label: "Library", src: "preset:library", swatchStyle: "linear-gradient(135deg, #7c4a2d, #5d3520)" },
  { id: "outdoor", label: "Outdoor", src: "preset:outdoor", swatchStyle: "linear-gradient(135deg, #5b9bd5, #3a7ca5)" },
  { id: "gradient", label: "Gradient", src: "preset:gradient", swatchStyle: "linear-gradient(135deg, #667eea, #764ba2)" },
];

const STORAGE_KEY = "bulldog.call.virtualBackground";

export function loadSavedSelection(): BgSelection {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as BgSelection;
      if (parsed && parsed.mode && parsed.id) return parsed;
    }
  } catch { /* ignore */ }
  return { id: "none", mode: { kind: "none" } };
}

export function saveSelection(sel: BgSelection): void {
  try {
    // Don't persist large custom-upload data URIs — they can blow the
    // localStorage quota. Persist everything else as-is.
    if (sel.id === "custom") {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ id: "blur", mode: { kind: "blur", amount: 8 } }));
    } else {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(sel));
    }
  } catch { /* ignore */ }
}

export function VirtualBackgroundPicker({
  current,
  onSelect,
  onClose,
}: {
  current: BgSelection;
  onSelect: (sel: BgSelection) => void;
  onClose: () => void;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);

  const pick = (sel: BgSelection) => {
    saveSelection(sel);
    onSelect(sel);
  };

  const onUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const src = String(reader.result);
      pick({ id: "custom", mode: { kind: "image", src } });
    };
    reader.readAsDataURL(file);
  };

  const swatch = (id: string, label: string, node: React.ReactNode, sel: BgSelection) => {
    const activeSel = current.id === id;
    return (
      <button
        key={id}
        type="button"
        onClick={() => pick(sel)}
        className={[
          "relative w-full aspect-video rounded-lg overflow-hidden border-2 flex items-center justify-center text-[10px] font-mono uppercase tracking-wider",
          activeSel ? "border-vs-blue" : "border-[hsl(232_40%_25%)] hover:border-[hsl(232_40%_40%)]",
        ].join(" ")}
        data-testid={`bg-option-${id}`}
        title={label}
      >
        {node}
        <span className="absolute bottom-0 left-0 right-0 bg-black/50 text-white px-1 py-0.5 text-[9px]">{label}</span>
      </button>
    );
  };

  return (
    <div
      className="absolute bottom-20 left-1/2 -translate-x-1/2 z-[120] w-[320px] rounded-xl bg-[hsl(232_55%_13%)] border border-[hsl(232_40%_25%)] shadow-2xl p-3"
      onClick={(e) => e.stopPropagation()}
      data-testid="popover-virtual-background"
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-display text-white">Background effects</span>
        <button type="button" onClick={onClose} className="p-1 rounded text-[hsl(0_0%_70%)] hover:text-white" aria-label="Close">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="grid grid-cols-3 gap-2">
        {swatch("none", "None", <CircleSlash className="w-5 h-5 text-[hsl(0_0%_60%)]" />, { id: "none", mode: { kind: "none" } })}
        {swatch("blur", "Blur", <Aperture className="w-5 h-5 text-vs-blue-light" />, { id: "blur", mode: { kind: "blur", amount: 8 } })}
        {PRESETS.map((p) =>
          swatch(
            p.id,
            p.label,
            <span className="absolute inset-0" style={{ background: p.swatchStyle }} />,
            { id: p.id, mode: { kind: "image", src: p.src } },
          ),
        )}
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className={[
            "w-full aspect-video rounded-lg border-2 border-dashed flex flex-col items-center justify-center gap-1 text-[10px] font-mono",
            current.id === "custom" ? "border-vs-blue text-vs-blue-light" : "border-[hsl(232_40%_25%)] text-[hsl(0_0%_60%)] hover:border-[hsl(232_40%_40%)]",
          ].join(" ")}
          data-testid="bg-option-upload"
        >
          <Upload className="w-4 h-4" />
          Upload
        </button>
      </div>
      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onUpload} />
    </div>
  );
}
