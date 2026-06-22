/**
 * MeetSettingsModal — device picker for the Bulldog Meet flow. Lets the user
 * choose microphone, camera and speaker. Selections persist to localStorage
 * (via meet-devices) and are applied live through the provided callbacks so no
 * rejoin is required.
 *
 * Used by both the prejoin screen (Join.tsx) and the in-call HUD (Room.tsx);
 * the caller wires onChange to whichever apply path it has (preview tracks vs.
 * a live LiveKit Room).
 */
import { useEffect, useState } from "react";
import { X, Mic, Video, Volume2 } from "lucide-react";
import {
  listMediaDevices,
  speakerSelectionSupported,
  type DeviceList,
  type DevicePrefs,
} from "@/lib/meet-devices";

export function MeetSettingsModal({
  prefs,
  onChange,
  onClose,
}: {
  prefs: DevicePrefs;
  /** Fired when a device is picked. kind maps to a DevicePrefs field. */
  onChange: (kind: keyof DevicePrefs, deviceId: string) => void;
  onClose: () => void;
}) {
  const [devices, setDevices] = useState<DeviceList>({
    audioInputs: [],
    videoInputs: [],
    audioOutputs: [],
  });
  const speakerSupported = speakerSelectionSupported();

  useEffect(() => {
    let active = true;
    listMediaDevices().then((d) => {
      if (active) setDevices(d);
    });
    // Device list can change (plug/unplug a headset). Refresh on the event.
    const refresh = () => listMediaDevices().then((d) => active && setDevices(d));
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    return () => {
      active = false;
      navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
    };
  }, []);

  const row = (
    icon: React.ReactNode,
    label: string,
    list: MediaDeviceInfo[],
    value: string | undefined,
    kind: keyof DevicePrefs,
    fallbackLabel: (i: number) => string,
    disabled?: boolean,
  ) => (
    <label className="block">
      <span className="mb-1.5 flex items-center gap-2 text-sm font-medium text-foreground">
        {icon}
        {label}
      </span>
      <select
        data-testid={`select-${kind}`}
        disabled={disabled || list.length === 0}
        value={value ?? ""}
        onChange={(e) => onChange(kind, e.target.value)}
        className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground disabled:opacity-50"
      >
        {list.length === 0 && <option value="">No devices found</option>}
        {list.map((d, i) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || fallbackLabel(i)}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      data-testid="modal-meet-settings"
    >
      <div
        className="w-full max-w-md rounded-2xl border border-border bg-card p-5 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-display text-base font-semibold text-foreground">Settings</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground hover-elevate"
            data-testid="button-close-settings"
          >
            <X size={16} />
          </button>
        </div>

        <div className="space-y-4">
          {row(
            <Mic size={15} className="text-muted-foreground" />,
            "Microphone",
            devices.audioInputs,
            prefs.audioInput,
            "audioInput",
            (i) => `Microphone ${i + 1}`,
          )}
          {row(
            <Video size={15} className="text-muted-foreground" />,
            "Camera",
            devices.videoInputs,
            prefs.videoInput,
            "videoInput",
            (i) => `Camera ${i + 1}`,
          )}
          {row(
            <Volume2 size={15} className="text-muted-foreground" />,
            speakerSupported ? "Speaker" : "Speaker (uses system default)",
            devices.audioOutputs,
            prefs.audioOutput,
            "audioOutput",
            (i) => `Speaker ${i + 1}`,
            !speakerSupported,
          )}
        </div>

        <p className="mt-4 text-xs text-muted-foreground">
          Changes apply immediately and are remembered for your next meeting.
        </p>
      </div>
    </div>
  );
}
