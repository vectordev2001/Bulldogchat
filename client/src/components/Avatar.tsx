// Gradient initial avatar — colors derived from a hue.
// Works with both API users ({name,hue,status}) and lightweight call participants.

interface AvatarMember {
  name?: string;
  initials?: string;
  hue: number;
  status?: string;
}

interface Props {
  member: AvatarMember;
  size?: number;
  showStatus?: boolean;
  ring?: "none" | "red" | "blue" | "green" | "amber";
  className?: string;
}

const STATUS_COLOR: Record<string, string> = {
  online: "hsl(145 60% 48%)",
  idle: "hsl(35 100% 60%)",
  dnd: "hsl(2 70% 55%)",
  offline: "hsl(232 10% 45%)",
};

const RING_COLOR: Record<string, string> = {
  none: "transparent",
  red: "hsl(2 70% 55%)",
  blue: "hsl(218 100% 68%)",
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
          fill="hsl(232 60% 9%)"
        >
          {initials}
        </text>
      </svg>

      {showStatus && member.status && (
        <span
          className="absolute"
          style={{
            right: -1,
            bottom: -1,
            width: Math.max(10, size * 0.3),
            height: Math.max(10, size * 0.3),
            borderRadius: "50%",
            background: STATUS_COLOR[member.status] ?? STATUS_COLOR.online,
            boxShadow: "0 0 0 2px hsl(232 50% 20%)",
          }}
        />
      )}
    </div>
  );
}
