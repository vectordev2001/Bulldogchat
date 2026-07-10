/**
 * DeviceMenu — Teams-style caret split-button companion for the mic/camera
 * toggles in Bulldog Meet.
 *
 * Rendered as a small "^" chevron tab attached to the right side of a parent
 * BarBtn. Clicking opens a compact popover that lists the available devices
 * of the requested `kind` and lets the user switch on the fly. Selection
 * persists to localStorage via meet-devices and applies live through the
 * `onPick` callback the parent wires to its LiveKit room (Room.tsx) or its
 * prejoin preview (Join.tsx).
 *
 * Why not just reuse MeetSettingsModal? Because Teams trains users to expect
 * device switching to be one click + one selection — opening a centered modal
 * just to flip from "MacBook Mic" to "AirPods" is too heavy. We keep
 * MeetSettingsModal for the all-up Devices view (also reachable from the gear
 * button) and add this lightweight per-button affordance.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronUp, Check } from "lucide-react";
import { listMediaDevices, type DeviceList, type DevicePrefs } from "../../lib/meet-devices";

export type DeviceMenuKind = "audioInput" | "videoInput";

export function DeviceMenu({
  kind,
  prefs,
  onPick,
}: {
  /** Which DevicePrefs field this menu drives. */
  kind: DeviceMenuKind;
  prefs: DevicePrefs;
  /** Called with the newly chosen deviceId. The parent is responsible for
   * persisting to localStorage (already done by its onDeviceChange) and
   * applying to the live LiveKit room or prejoin preview track. */
  onPick: (deviceId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState<DeviceList>({
    audioInputs: [],
    videoInputs: [],
    audioOutputs: [],
  });
  const ref = useRef<HTMLDivElement>(null);

  // Pull the device list lazily — opening the menu is the trigger. Refresh
  // on `devicechange` so plugging/unplugging a headset updates the list
  // without closing the popover.
  useEffect(() => {
    if (!open) return;
    let active = true;
    listMediaDevices().then((d) => active && setDevices(d));
    const refresh = () => listMediaDevices().then((d) => active && setDevices(d));
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    return () => {
      active = false;
      navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
    };
  }, [open]);

  // Click-outside-to-close. We attach a single window listener while open;
  // cheaper than a full Popover/Portal setup and the trigger is small enough
  // that we don't need anchor positioning math beyond `absolute`.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current) return;
      if (e.target instanceof Node && ref.current.contains(e.target)) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const list = kind === "audioInput" ? devices.audioInputs : devices.videoInputs;
  const value = kind === "audioInput" ? prefs.audioInput : prefs.videoInput;
  const label = kind === "audioInput" ? "Choose microphone" : "Choose camera";

  // If the browser hasn't surfaced labels yet (no permission grant), our
  // mic/cam toggles couldn't have published anything either, so the list is
  // either empty or full of unlabeled entries. Fall back to numbered labels.
  const items = useMemo(
    () =>
      list.map((d, i) => ({
        deviceId: d.deviceId,
        label: d.label || `${kind === "audioInput" ? "Microphone" : "Camera"} ${i + 1}`,
      })),
    [list, kind],
  );

  return (
    <div ref={ref} className="relative" data-testid={`device-menu-${kind}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={`button-device-menu-${kind}`}
        className={`flex h-6 w-5 items-center justify-center rounded-full border border-white/15 bg-white/10 text-white transition hover:bg-white/20 ${
          open ? "ring-2 ring-primary" : ""
        }`}
      >
        <ChevronUp size={12} />
      </button>

      {open && (
        <div
          role="menu"
          aria-label={label}
          className="absolute bottom-[calc(100%+8px)] left-1/2 z-50 w-64 -translate-x-1/2 rounded-xl border border-border bg-card p-1.5 text-sm text-foreground shadow-2xl"
          data-testid={`popover-device-menu-${kind}`}
        >
          <div className="px-2.5 pb-1.5 pt-1 text-[10px] font-mono uppercase tracking-wider text-muted-foreground">
            {label}
          </div>
          {items.length === 0 ? (
            <div className="px-2.5 py-2 text-xs text-muted-foreground">No devices found</div>
          ) : (
            items.map((d) => {
              const selected = d.deviceId === value;
              return (
                <button
                  key={d.deviceId}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  onClick={() => {
                    onPick(d.deviceId);
                    setOpen(false);
                  }}
                  data-testid={`menuitem-device-${kind}-${d.deviceId.slice(0, 8)}`}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition hover-elevate ${
                    selected ? "bg-primary/10 text-primary" : ""
                  }`}
                >
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                    {selected ? <Check size={14} /> : null}
                  </span>
                  <span className="truncate">{d.label}</span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
