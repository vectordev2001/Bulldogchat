import { Avatar } from "./Avatar";
import type { ApiUser, UserRole } from "@/types/api";

const ROLE_ORDER: UserRole[] = ["admin", "foreman", "safety", "office", "field"];
const ROLE_TINT: Record<UserRole, string> = {
  admin:   "text-[hsl(2_85%_72%)]",
  foreman: "text-vs-blue-light",
  safety:  "text-[hsl(2_85%_72%)]",
  office:  "text-[hsl(35_100%_70%)]",
  field:   "text-vs-green",
};
const ROLE_LABEL: Record<UserRole, string> = {
  admin: "Admin", foreman: "Foreman", office: "Office", field: "Field Crew", safety: "Safety",
};

interface Props {
  members: ApiUser[];
}

export function MemberList({ members }: Props) {
  const online = members.filter((m) => m.status !== "offline");
  const offline = members.filter((m) => m.status === "offline");
  online.sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));

  return (
    <aside
      className="w-[240px] shrink-0 vs-navy border-l border-black/30 flex-col hidden xl:flex"
      data-testid="sidebar-members"
    >
      <div className="px-4 py-3 border-b border-black/30">
        <div className="text-[10px] uppercase tracking-[0.16em] text-vs-red font-bold">Roster</div>
        <div className="text-sm text-white mt-0.5">
          {members.length} members · <span className="text-vs-green">{online.length} online</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-3">
        <RoleGroup label={`Online — ${online.length}`} members={online} />
        {offline.length > 0 && <RoleGroup label={`Offline — ${offline.length}`} members={offline} dimmed />}
      </div>
    </aside>
  );
}

function RoleGroup({ label, members, dimmed }: { label: string; members: ApiUser[]; dimmed?: boolean }) {
  return (
    <div className="mb-4">
      <div className="px-2 py-1 text-[10px] uppercase tracking-[0.16em] font-bold text-[hsl(0_0%_55%)]">{label}</div>
      <div className="space-y-0.5">
        {members.map((m) => (
          <MemberRow key={m.id} member={m} dimmed={dimmed} />
        ))}
      </div>
    </div>
  );
}

function MemberRow({ member, dimmed }: { member: ApiUser; dimmed?: boolean }) {
  return (
    <div
      className={[
        "flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-[hsl(232_45%_27%)] transition-colors cursor-pointer",
        dimmed ? "opacity-50" : "",
      ].join(" ")}
      data-testid={`member-${member.id}`}
    >
      <Avatar member={{ name: member.name, hue: member.hue, status: member.status }} size={32} showStatus />
      <div className="min-w-0 flex-1">
        <div className={`text-sm font-semibold truncate ${ROLE_TINT[member.role]}`}>{member.name}</div>
        <div className="text-[10px] text-[hsl(0_0%_60%)] truncate font-mono uppercase tracking-wider">
          {ROLE_LABEL[member.role]}{member.title ? ` · ${member.title}` : ""}
        </div>
      </div>
    </div>
  );
}
