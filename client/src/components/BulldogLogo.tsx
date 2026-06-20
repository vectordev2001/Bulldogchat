import { SiZoom, SiGooglemeet } from "react-icons/si";
import type { Origin } from "@/lib/meeting";

// ── App-identity logo ──────────────────────────────────────────────────────
// Shared Bulldog Suite mark: three stars in a row above three chevron stripes,
// approximating the Vector logo (vectorservicesus.com). Each app highlights ONE
// star and ONE chevron in an app-specific color; every other stroke uses the
// muted neutral. Self-contained inline SVG — scales cleanly 28→32px.

type AppId = "chat" | "contracts" | "ops";

const NEUTRAL = "hsl(232 30% 60%)"; // muted navy — everything not highlighted

// Per-app highlight: which star index (0=left,1=mid,2=right) and which chevron
// index (0=top,1=mid,2=bottom) get the accent, plus the accent color. Chat's
// highlight is white, which would vanish on the white header, so it also carries
// a navy outline to stay readable.
const HIGHLIGHT: Record<AppId, { star: number; chevron: number; color: string; outline?: string }> = {
  chat: { star: 1, chevron: 1, color: "#FFFFFF", outline: "hsl(232 50% 20%)" },
  contracts: { star: 0, chevron: 0, color: "#BB936C" },
  ops: { star: 2, chevron: 2, color: "#DD403D" },
};

function starPoints(cx: number, cy: number, r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const angle = (i * Math.PI) / 5 - Math.PI / 2;
    const radius = i % 2 === 0 ? r : r * 0.42;
    pts.push(`${(cx + Math.cos(angle) * radius).toFixed(2)},${(cy + Math.sin(angle) * radius).toFixed(2)}`);
  }
  return pts.join(" ");
}

/**
 * <BulldogLogo app="chat" /> — app-identity mark for the unified header.
 * `size` is the rendered height in px; the viewBox keeps a 2:1 aspect ratio so
 * the row of stars + chevrons stays proportional at any scale.
 */
export function BulldogLogo({
  app,
  size = 32,
  className = "",
}: {
  app: AppId;
  size?: number;
  className?: string;
}) {
  const hl = HIGHLIGHT[app];
  // viewBox 64×32: stars centered around y=9, chevrons nested below.
  const starCx = [16, 32, 48];
  const starR = 5;
  // Three nested chevrons (top widest), drawn as open V strokes.
  const chevrons = [
    "M10 30 L32 14 L54 30", // top
    "M16 30 L32 19 L48 30", // mid
    "M22 30 L32 24 L42 30", // bottom
  ];
  const baseStroke = 2.4;

  return (
    <svg
      width={size * 2}
      height={size}
      viewBox="0 0 64 32"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={`Bulldog ${app.charAt(0).toUpperCase()}${app.slice(1)}`}
      className={className}
    >
      {/* Stars */}
      {starCx.map((cx, i) => {
        const on = i === hl.star;
        return (
          <polygon
            key={`star-${i}`}
            points={starPoints(cx, 9, starR)}
            fill={on ? hl.color : NEUTRAL}
            stroke={on && hl.outline ? hl.outline : "none"}
            strokeWidth={on && hl.outline ? 1 : 0}
            strokeLinejoin="round"
          />
        );
      })}

      {/* Chevron stripes. The highlighted stripe gets a 1.5× stroke; when its
          color is white (Chat) we first lay down a slightly wider navy stroke so
          the white reads as a distinct highlight on the white header. */}
      {chevrons.map((d, i) => {
        const on = i === hl.chevron;
        const w = on ? baseStroke * 1.5 : baseStroke;
        return (
          <g key={`chev-${i}`}>
            {on && hl.outline && (
              <path
                d={d}
                stroke={hl.outline}
                strokeWidth={w + 2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
            <path
              d={d}
              stroke={on ? hl.color : NEUTRAL}
              strokeWidth={w}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
        );
      })}
    </svg>
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
