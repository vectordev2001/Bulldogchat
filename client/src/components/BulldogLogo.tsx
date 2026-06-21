import { SiZoom, SiGooglemeet } from "react-icons/si";
import type { Origin } from "@/lib/meeting";

// ── App-identity logo ──────────────────────────────────────────────────────
// Canonical Bulldog Suite app-identity logo — three stars in a row above three
// chevron stripes. Each app highlights ONE star and ONE chevron in its accent
// color; everything else uses the muted neutral navy. Self-contained inline SVG.

type App = "chat" | "contracts" | "ops";

interface LogoProps {
  /** App identity — controls which star + chevron is highlighted. */
  app?: App;
  size?: number;
  className?: string;
  stars?: boolean;
  /** Render in a single currentColor tone (no per-app highlight). */
  monochrome?: boolean;
}

const NEUTRAL = "hsl(232 30% 60%)"; // muted navy
const NEUTRAL_STROKE_WIDTH = 5;
const HIGHLIGHT_STROKE_WIDTH = NEUTRAL_STROKE_WIDTH * 1.5; // 1.5× neutral

const NAVY = "#191E4A";
const GOLD = "#C99A2E";
const RED = "#DD403D";

interface AppStyle {
  // Which star (0 = left, 1 = middle, 2 = right) is highlighted.
  star: number;
  starFill: string;
  starOutline?: string;
  // Which chevron (0 = top, 1 = middle, 2 = bottom) is highlighted.
  chevron: number;
  chevronStroke: string;
  chevronOutline?: string;
}

const APP_STYLES: Record<App, AppStyle> = {
  contracts: { star: 0, starFill: GOLD, chevron: 0, chevronStroke: GOLD },
  chat: { star: 1, starFill: NAVY, chevron: 1, chevronStroke: NAVY },
  ops: { star: 2, starFill: RED, chevron: 2, chevronStroke: RED },
};

const STAR_POS = [
  { cx: 20, cy: 10 },
  { cx: 32, cy: 8 },
  { cx: 44, cy: 10 },
];

const CHEVRON_PATHS = [
  "M8 50 L32 22 L56 50",
  "M16 50 L32 32 L48 50",
  "M24 50 L32 42 L40 50",
];

export function BulldogLogo({
  app = "chat",
  size = 40,
  className = "",
  stars = true,
  monochrome = false,
}: LogoProps) {
  const style = APP_STYLES[app];

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label={`Bulldog ${app.charAt(0).toUpperCase()}${app.slice(1)}`}
      className={className}
    >
      {stars && (
        <g>
          {STAR_POS.map((pos, i) => {
            const highlighted = !monochrome && i === style.star;
            const fill = monochrome
              ? "currentColor"
              : highlighted
                ? style.starFill
                : NEUTRAL;
            return (
              <Star
                key={i}
                cx={pos.cx}
                cy={pos.cy}
                r={highlighted ? 2.6 : 2.2}
                fill={fill}
                stroke={highlighted ? style.starOutline : undefined}
              />
            );
          })}
        </g>
      )}
      {CHEVRON_PATHS.map((d, i) => {
        const highlighted = !monochrome && i === style.chevron;
        const stroke = monochrome
          ? "currentColor"
          : highlighted
            ? style.chevronStroke
            : NEUTRAL;
        const strokeWidth = highlighted
          ? HIGHLIGHT_STROKE_WIDTH
          : NEUTRAL_STROKE_WIDTH;
        return (
          <g key={i}>
            {highlighted && style.chevronOutline && (
              // Navy outline behind a light highlight so it stays visible.
              <path
                d={d}
                stroke={style.chevronOutline}
                strokeWidth={strokeWidth + 2}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
            <path
              d={d}
              stroke={stroke}
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
        );
      })}
    </svg>
  );
}

function Star({
  cx,
  cy,
  r,
  fill,
  stroke,
}: {
  cx: number;
  cy: number;
  r: number;
  fill: string;
  stroke?: string;
}) {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const angle = (i * Math.PI) / 5 - Math.PI / 2;
    const radius = i % 2 === 0 ? r : r * 0.42;
    pts.push(`${cx + Math.cos(angle) * radius},${cy + Math.sin(angle) * radius}`);
  }
  return (
    <polygon
      points={pts.join(" ")}
      fill={fill}
      stroke={stroke}
      strokeWidth={stroke ? 1 : undefined}
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
