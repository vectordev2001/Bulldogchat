import { useEffect, useRef, useState } from "react";
import type { DevicePrefs } from "./hooks/useDevicePreferences";

// ── DeviceSettingsMenu ───────────────────────────────────────────────────────
// Popover attached to the in-call gear icon (CallView.tsx). Lists the
// available camera / microphone / speaker devices and lets the user pick one;
// selection is applied immediately by the caller via onSelect* callbacks and
// persisted by useDevicePreferences upstream. This component owns only
// enumeration + the popover UI (outside-click / ESC to close, upward-opening
// popover, keyboard-operable native <select>s) — it has no opinion on how a
// selection is actually applied to LiveKit.

export type DeviceKind = "videoinput" | "audioinput" | "audiooutput";

export interface EnumeratedDevice {
  deviceId: string;
  label: string;
}

/** Pure helper: maps raw MediaDeviceInfo-shaped records to the UI's simpler
 * EnumeratedDevice shape, filtering by kind and filling in "Device N" labels
 * when the browser withholds labels (no mic/cam permission granted yet).
 * Exported + pure so it's testable without a real MediaDevices API. */
export function mapDevices(
  devices: Array<{ kind: string; deviceId: string; label: string }>,
  kind: DeviceKind,
): EnumeratedDevice[] {
  return devices
    .filter((d) => d.kind === kind)
    .map((d, i) => ({
      deviceId: d.deviceId,
      label: d.label && d.label.trim().length > 0 ? d.label : `Device ${i + 1}`,
    }));
}

interface DeviceSettingsMenuProps {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement>;
  prefs: DevicePrefs;
  onSelectCamera: (deviceId: string) => void;
  onSelectMic: (deviceId: string) => void;
  onSelectSpeaker: (deviceId: string) => void;
  speakerSupported: boolean;
}

export function DeviceSettingsMenu({
  open,
  onClose,
  anchorRef,
  prefs,
  onSelectCamera,
  onSelectMic,
  onSelectSpeaker,
  speakerSupported,
}: DeviceSettingsMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [cameras, setCameras] = useState<EnumeratedDevice[]>([]);
  const [mics, setMics] = useState<EnumeratedDevice[]>([]);
  const [speakers, setSpeakers] = useState<EnumeratedDevice[]>([]);

  const refreshDevices = () => {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.enumerateDevices) return;
    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        setCameras(mapDevices(devices, "videoinput"));
        setMics(mapDevices(devices, "audioinput"));
        setSpeakers(mapDevices(devices, "audiooutput"));
      })
      .catch(() => {
        /* best-effort — enumeration can fail without permission in some browsers */
      });
  };

  // Populate the lists once the popover opens, and keep them fresh on
  // devicechange (USB headset plugged in, Bluetooth speaker connects, etc.).
  useEffect(() => {
    if (!open) return;
    refreshDevices();
    const md = typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;
    md?.addEventListener?.("devicechange", refreshDevices);
    return () => md?.removeEventListener?.("devicechange", refreshDevices);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Close on outside click / ESC.
  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, onClose, anchorRef]);

  if (!open) return null;

  return (
    <div
      ref={menuRef}
      data-testid="bulldog-chat-widget-device-menu"
      className="bcw-absolute bcw-bottom-full bcw-mb-2 bcw-left-1/2 bcw--translate-x-1/2 bcw-w-56 bcw-rounded-lg bcw-bg-[hsl(220,60%,10%)] bcw-border bcw-border-white/10 bcw-shadow-xl bcw-p-3 bcw-flex bcw-flex-col bcw-gap-3 bcw-z-20"
      role="menu"
    >
      <DeviceSelectField
        label="Camera"
        kind="camera"
        devices={cameras}
        value={prefs.videoInput}
        onChange={onSelectCamera}
      />
      <DeviceSelectField
        label="Microphone"
        kind="mic"
        devices={mics}
        value={prefs.audioInput}
        onChange={onSelectMic}
      />
      <DeviceSelectField
        label="Speaker"
        kind="speaker"
        devices={speakers}
        value={prefs.audioOutput}
        onChange={onSelectSpeaker}
        disabled={!speakerSupported}
        disabledTitle="Speaker selection not supported in this browser."
      />
    </div>
  );
}

function DeviceSelectField({
  label,
  kind,
  devices,
  value,
  onChange,
  disabled,
  disabledTitle,
}: {
  label: string;
  kind: "camera" | "mic" | "speaker";
  devices: EnumeratedDevice[];
  value: string | undefined;
  onChange: (deviceId: string) => void;
  disabled?: boolean;
  disabledTitle?: string;
}) {
  return (
    <label className="bcw-flex bcw-flex-col bcw-gap-1 bcw-text-[11px] bcw-text-white/70" title={disabled ? disabledTitle : undefined}>
      <span>{label}</span>
      <select
        data-testid={`bulldog-chat-widget-device-select-${kind}`}
        className="bcw-bg-[hsl(220,60%,14%)] bcw-text-white bcw-text-xs bcw-rounded bcw-px-2 bcw-py-1.5 bcw-border bcw-border-white/10 disabled:bcw-opacity-40 disabled:bcw-cursor-not-allowed"
        value={value ?? ""}
        disabled={disabled}
        title={disabled ? disabledTitle : undefined}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">System default</option>
        {devices.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function GearIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}

export function DeviceGearButton({
  active,
  onClick,
  buttonRef,
}: {
  active: boolean;
  onClick: () => void;
  buttonRef: React.RefObject<HTMLButtonElement>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      data-testid="bulldog-chat-widget-device-gear"
      onClick={onClick}
      title="Device settings"
      className={`bcw-w-9 bcw-h-9 bcw-rounded-full bcw-flex bcw-items-center bcw-justify-center bcw-text-white bcw-transition-colors ${
        active ? "bcw-bg-white/15 hover:bcw-bg-white/25" : "bcw-bg-bcw-navy-light hover:bcw-bg-white/10"
      }`}
    >
      <GearIcon />
    </button>
  );
}
