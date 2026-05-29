// Bulldog Chat logo — chevron of stacked angled lines with three red stars above.
// Works at 24px–200px.

interface Props {
  size?: number;
  className?: string;
  stars?: boolean;
  monochrome?: boolean;
}

export function VectorLogo({ size = 40, className = "", stars = true, monochrome = false }: Props) {
  const navy = monochrome ? "currentColor" : "hsl(232 50% 20%)";
  const red = monochrome ? "currentColor" : "hsl(2 70% 55%)";
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Bulldog Chat"
      className={className}
    >
      {/* Three small red 5-point stars above the chevron */}
      {stars && (
        <g>
          <Star cx={20} cy={10} r={2.2} fill={red} />
          <Star cx={32} cy={8} r={2.2} fill={red} />
          <Star cx={44} cy={10} r={2.2} fill={red} />
        </g>
      )}

      {/* Chevron — stacked angled lines forming an upward V shape */}
      {/* Outer chevron */}
      <path
        d="M8 50 L32 22 L56 50"
        stroke={navy}
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Middle chevron */}
      <path
        d="M16 50 L32 32 L48 50"
        stroke={navy}
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.85"
      />
      {/* Inner chevron */}
      <path
        d="M24 50 L32 42 L40 50"
        stroke={navy}
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.7"
      />
    </svg>
  );
}

function Star({ cx, cy, r, fill }: { cx: number; cy: number; r: number; fill: string }) {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const angle = (i * Math.PI) / 5 - Math.PI / 2;
    const radius = i % 2 === 0 ? r : r * 0.42;
    pts.push(`${cx + Math.cos(angle) * radius},${cy + Math.sin(angle) * radius}`);
  }
  return <polygon points={pts.join(" ")} fill={fill} />;
}

// Wordmark version — for header/login
export function VectorWordmark({ className = "" }: { className?: string }) {
  return (
    <div className={`inline-flex items-center gap-2.5 ${className}`}>
      <VectorLogo size={32} />
      <div className="font-display text-white tracking-[0.18em] text-sm uppercase">
        Bulldog <span className="text-vs-red">Chat</span>
      </div>
    </div>
  );
}
