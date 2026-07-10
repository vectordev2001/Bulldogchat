/**
 * DeviceSelector — labeled dropdown for picking the active microphone, camera,
 * or speaker. Used on the prejoin (Join.tsx) and inside the meeting room
 * (Room.tsx) so users can always see *which* mic and camera they're publishing
 * from at a glance, without hunting for a tiny chevron carat.
 *
 * Two visual variants:
 *
 *   - `panel`  — full-width labeled row used on the prejoin page. Renders
 *                an icon + label ("Microphone") above a wide trigger that
 *                shows the current device name (truncated). Designed to sit
 *                beneath the camera preview.
 *
 *   - `pill`   — compact dark-on-dark pill used inside the in-call bottom
 *                bar. Same dropdown content, narrower trigger, fits next to
 *                the mic/cam toggle buttons without dominating the bar.
 *
 * The dropdown content is the same in both variants. We refresh the device
 * list on every `devicechange` event so plugging/unplugging a headset live
 * is reflected without remounting.
 */
import { useEffect, useState } from "react";
import { Mic, Video, Volume2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { listMediaDevices, type DeviceList, type DevicePrefs } from "../../lib/meet-devices";

export type DeviceSelectorKind = "audioInput" | "videoInput" | "audioOutput";

const KIND_META: Record<DeviceSelectorKind, { label: string; placeholder: string; fallbackPrefix: string; Icon: typeof Mic }> = {
  audioInput: { label: "Microphone", placeholder: "Default microphone", fallbackPrefix: "Microphone", Icon: Mic },
  videoInput: { label: "Camera", placeholder: "Default camera", fallbackPrefix: "Camera", Icon: Video },
  audioOutput: { label: "Speaker", placeholder: "Default speaker", fallbackPrefix: "Speaker", Icon: Volume2 },
};

export function DeviceSelector({
  kind,
  prefs,
  onPick,
  variant = "panel",
}: {
  kind: DeviceSelectorKind;
  prefs: DevicePrefs;
  /** Called with the newly chosen deviceId. Parent persists + applies. */
  onPick: (deviceId: string) => void;
  /** `panel` for prejoin (full-width labeled row), `pill` for in-call bottom bar. */
  variant?: "panel" | "pill";
}) {
  const [devices, setDevices] = useState<DeviceList>({
    audioInputs: [],
    videoInputs: [],
    audioOutputs: [],
  });

  // Keep the list fresh: load on mount, refresh on devicechange.
  useEffect(() => {
    let active = true;
    const refresh = () => listMediaDevices().then((d) => active && setDevices(d));
    void refresh();
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    return () => {
      active = false;
      navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
    };
  }, []);

  const list =
    kind === "audioInput"
      ? devices.audioInputs
      : kind === "videoInput"
        ? devices.videoInputs
        : devices.audioOutputs;
  const value =
    kind === "audioInput"
      ? prefs.audioInput
      : kind === "videoInput"
        ? prefs.videoInput
        : prefs.audioOutput;

  const meta = KIND_META[kind];

  // Build items with stable fallback labels for unlabeled devices (which
  // happens briefly before the user has granted media permission).
  const items = list.map((d, i) => ({
    deviceId: d.deviceId,
    label: d.label || `${meta.fallbackPrefix} ${i + 1}`,
  }));

  // Resolve the currently-selected label to render in the trigger. If no
  // explicit preference is saved we fall back to the first device's label
  // (which is what the browser will publish from anyway).
  const currentLabel =
    items.find((d) => d.deviceId === value)?.label ?? items[0]?.label ?? meta.placeholder;

  if (variant === "pill") {
    return (
      <div className="flex min-w-0 items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-white/85" data-testid={`device-selector-${kind}`}>
        <meta.Icon size={12} className="shrink-0 text-white/60" />
        <Select
          value={value ?? items[0]?.deviceId ?? ""}
          onValueChange={(v) => onPick(v)}
        >
          <SelectTrigger
            data-testid={`device-selector-trigger-${kind}`}
            className="h-6 max-w-[10rem] border-0 bg-transparent px-1 text-xs text-white/85 hover:bg-white/10 focus:ring-0"
          >
            <SelectValue placeholder={meta.placeholder}>
              <span className="truncate" title={currentLabel}>{currentLabel}</span>
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {items.length === 0 ? (
              <div className="px-2 py-2 text-xs text-muted-foreground" data-testid={`device-selector-empty-${kind}`}>
                No devices found
              </div>
            ) : (
              items.map((d) => (
                <SelectItem key={d.deviceId} value={d.deviceId} data-testid={`device-selector-item-${kind}-${d.deviceId.slice(0, 8)}`}>
                  {d.label}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid={`device-selector-${kind}`}>
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <meta.Icon size={13} />
        <span>{meta.label}</span>
      </div>
      <Select
        value={value ?? items[0]?.deviceId ?? ""}
        onValueChange={(v) => onPick(v)}
      >
        <SelectTrigger
          data-testid={`device-selector-trigger-${kind}`}
          className="h-10 text-sm"
        >
          <SelectValue placeholder={meta.placeholder}>
            <span className="truncate" title={currentLabel}>{currentLabel}</span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {items.length === 0 ? (
            <div className="px-2 py-2 text-xs text-muted-foreground" data-testid={`device-selector-empty-${kind}`}>
              No devices found
            </div>
          ) : (
            items.map((d) => (
              <SelectItem key={d.deviceId} value={d.deviceId} data-testid={`device-selector-item-${kind}-${d.deviceId.slice(0, 8)}`}>
                {d.label}
              </SelectItem>
            ))
          )}
        </SelectContent>
      </Select>
    </div>
  );
}
