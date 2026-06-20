// Gradient initial avatar — colors derived from a hue.
// Works with both API users ({name,hue,status}) and lightweight call participants.

interface AvatarMember {
  name?: string;
  initials?: string;
  hue: number;
  status?: string;
  // Phase 1.9 presence state. When present, takes priority over `status`
  // for picking the bottom-right dot color.
  presence?: "online" | "away" | "busy" | "offline";
}

interface Props {
  member: AvatarMember;
  size?: number;
  showStatus?: boolean;
  ring?: "none" | "red" | "blue" | "green" | "amber";
  className?: string;
}

// Bottom-right dot colors. Phase 1.9 introduces explicit presence states;
// legacy `status` values (idle/dnd) are kept as aliases so older rows still
// render correctly until v11/v12 backfills land everywhere.
export const PRESENCE_COLOR: Record<string, string> = {
  online: "hsl(145 60% 48%)",   // green
  away: "hsl(45 100% 55%)",     // yellow
  busy: "hsl(174 70% 55%)",       // red
  offline: "hsl(220 10% 45%)",  // grey
  // legacy aliases
  idle: "hsl(45 100% 55%)",
  dnd: "hsl(174 70% 55%)",
};
const STATUS_COLOR = PRESENCE_COLOR;

const RING_COLOR: Record<string, string> = {
  none: "transparent",
  red: "hsl(174 70% 55%)",
  blue: "hsl(199 100% 68%)",
  green: "hsl(145 60% 48%)",
  amber: "hsl(35 100% 60%)",
};

function initialsFor(m: AvatarMember): string {
  if (m.initials) return m.initials.slice(0, 2).toUpperCase();
  if (!m.name) return "?";
  return m.name.split(/\s+/).slice(0, 2).map(s => s[0] ?? "").join("").toUpperCase();
}

export function Avatar({ member, size = 36, showStatus = false, ring = "none", className = "" }: Props) {
  const initials = initialsFor(member);
  const ringWidth = ring === "none" ? 0 : 2;
  const gradId = `g-${initials}-${member.hue}`;

  const c1 = `hsl(${member.hue} 70% 55%)`;
  const c2 = `hsl(${(member.hue + 35) % 360} 60% 30%)`;

  return (
    <div
      className={`relative inline-flex shrink-0 ${className}`}
      style={{ width: size, height: size }}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 40 40"
        style={{
          borderRadius: "50%",
          boxShadow: ringWidth ? `0 0 0 ${ringWidth}px ${RING_COLOR[ring]}` : undefined,
          display: "block",
        }}
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={c1} />
            <stop offset="100%" stopColor={c2} />
          </linearGradient>
        </defs>
        <rect width="40" height="40" rx="20" fill={`url(#${gradId})`} />
        <text
          x="20"
          y="20"
          textAnchor="middle"
          dominantBaseline="central"
          fontFamily="Satoshi, sans-serif"
          fontWeight="700"
          fontSize="15"
          fill="hsl(220 60% 9%)"
        >
          {initials}
        </text>
      </svg>

      {showStatus && (member.presence || member.status) && (
        <span
          className="absolute"
          style={{
            right: -1,
            bottom: -1,
            width: Math.max(10, size * 0.3),
            height: Math.max(10, size * 0.3),
            borderRadius: "50%",
            background:
              (member.presence && PRESENCE_COLOR[member.presence]) ??
              (member.status && STATUS_COLOR[member.status]) ??
              PRESENCE_COLOR.online,
            boxShadow: "0 0 0 2px hsl(220 50% 20%)",
          }}
        />
      )}
    </div>
  );
}
