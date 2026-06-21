import { SiZoom, SiGooglemeet } from "react-icons/si";
import type { Origin } from "@/lib/meeting";
import VectorEmblem from "@/assets/vector-emblem.svg?react";

// ── App-identity logo ──────────────────────────────────────────────────────
// The real Vector emblem (vectorservicesus.com), rendered identically across
// every Bulldog Suite app. App identity comes from the wordmark and the active
// tab pill, NOT from per-app recoloring of the mark. Native colors are kept:
// #246387 blue, #C5A582 tan, #E75B50 red.

type AppId = "chat" | "contracts" | "ops";

/**
 * <BulldogLogo /> — the shared Vector emblem for the unified header.
 * `size` is the rendered width in px; height is derived from the SVG's native
 * aspect ratio (~1583:1749, taller than wide). The `app` prop is accepted for
 * call-site API compatibility but no longer affects rendering.
 */
export function BulldogLogo({
  app = "chat",
  size = 32,
  className = "h-7 md:h-8 w-auto",
}: {
  app?: AppId;
  size?: number;
  className?: string;
}) {
  void app;
  // `className` (h-7 md:h-8 w-auto) drives the responsive 28→32px sizing and
  // preserves aspect ratio; `size` is the fallback width when no class is given.
  return (
    <VectorEmblem
      width={size}
      role="img"
      aria-label="Vector"
      className={className}
    />
  );
}

// react-icons/si has no Microsoft Teams glyph in this version, so we draw a
// small honest Teams-colored mark inline.
export function TeamsLogo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-label="Microsoft Teams" fill="#5059C9">
      <path d="M14.5 9.5h7.1c.5 0 .9.4.9.9v6c0 2.2-1.8 4-4 4-1.9 0-3.5-1.3-3.9-3.1V9.5z" opacity="0.85" />
      <circle cx="19" cy="5.2" r="2.3" opacity="0.85" />
      <circle cx="10.5" cy="5" r="3" />
      <path d="M2.8 8.5h10.4c.6 0 1.1.5 1.1 1.1v6.6c0 2.6-2.1 4.8-4.8 4.8h-2c-2.6 0-4.8-2.1-4.8-4.8V9.6c0-.6.5-1.1 1.1-1.1z" />
      <rect x="4.4" y="10.3" width="7.4" height="1.7" rx="0.5" fill="#fff" />
      <rect x="7.3" y="11" width="1.7" height="6.4" rx="0.5" fill="#fff" />
    </svg>
  );
}

/**
 * Bulldog Meet logo: a rounded square containing an abstract speech-bubble +
 * video-tile glyph. Uses theme tokens so it adapts to light/dark contexts.
 */
export function BulldogMark({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-label="Bulldog Meet logo"
      className={className}
    >
      <rect x="1" y="1" width="30" height="30" rx="8" fill="hsl(var(--primary))" />
      <rect x="7" y="9.5" width="13" height="11" rx="2.5" fill="hsl(var(--primary-foreground))" opacity="0.95" />
      <path d="M20.5 13.2 L25 10.4 V19.6 L20.5 16.8 Z" fill="hsl(var(--primary-foreground))" opacity="0.95" />
      <path d="M10 20.5 L10 24.5 L14 20.5 Z" fill="hsl(var(--primary-foreground))" opacity="0.95" />
    </svg>
  );
}

export function BulldogWordmark({ className = "" }: { className?: string }) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <BulldogMark size={26} />
      <span className="font-display font-bold tracking-tight text-foreground">
        Bulldog <span className="text-primary">Meet</span>
      </span>
    </div>
  );
}

export function PlatformLogo({ origin, size = 18 }: { origin: Origin; size?: number }) {
  if (origin === "teams") return <TeamsLogo size={size} />;
  if (origin === "zoom") return <SiZoom size={size} style={{ color: "#0B5CFF" }} />;
  if (origin === "meet") return <SiGooglemeet size={size} style={{ color: "#00897B" }} />;
  return <BulldogMark size={size} />;
}

export function initials(name: string) {
  return name
    .split(" ")
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}
