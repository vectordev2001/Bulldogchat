import { Plus, Settings, LogOut, Bell, BellRing } from "lucide-react";
import { VectorLogo } from "./VectorLogo";
import type { ApiProject } from "@/types/api";
import { useAuth } from "@/lib/auth";
import { useState } from "react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuTrigger, DropdownMenuSeparator, DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { InviteDialog } from "./InviteDialog";
import { NotificationsButton } from "./NotificationsButton";
import { AppSwitcher } from "@/lib/AppSwitcher";

interface Props {
  projects: ApiProject[];
  activeId: number | null;
  onSelect: (id: number) => void;
  unreadByProjectId?: Record<number, number>;
  sseStatus: "connecting" | "open" | "closed";
}

export function ProjectRail({ projects, activeId, onSelect, unreadByProjectId, sseStatus }: Props) {
  const { user, logout } = useAuth();
  const [inviteOpen, setInviteOpen] = useState(false);

  const isAdmin = user?.role === "admin";

  return (
    <aside
      className="flex flex-col items-center w-[72px] shrink-0 vs-navy-deep border-r border-black/40 py-3 gap-1.5"
      data-testid="rail-projects"
    >
      <button
        type="button"
        className="w-12 h-12 rounded-2xl flex items-center justify-center hover:rounded-xl transition-all bg-[hsl(232_45%_27%)] hover:bg-vs-red group relative"
        onClick={() => projects[0] && onSelect(projects[0].id)}
        title="Vector Chat"
        data-testid="button-home"
      >
        <VectorLogo size={32} className="text-white" monochrome />
        <ConnectionDot status={sseStatus} />
      </button>

      <div className="h-[2px] w-8 bg-[hsl(232_40%_25%)] rounded-full my-1" />

      <div className="flex flex-col gap-1.5 overflow-y-auto flex-1 w-full items-center px-1">
        {projects.map((p) => (
          <ProjectPill
            key={p.id}
            project={p}
            active={p.id === activeId}
            unread={unreadByProjectId?.[p.id] ?? 0}
            onClick={() => onSelect(p.id)}
          />
        ))}
      </div>

      <div className="h-[2px] w-8 bg-[hsl(232_40%_25%)] rounded-full my-1" />

      {isAdmin && (
        <button
          type="button"
          onClick={() => setInviteOpen(true)}
          className="w-12 h-12 rounded-2xl flex items-center justify-center bg-[hsl(232_45%_27%)] hover:rounded-xl hover:bg-vs-blue transition-all text-vs-blue hover:text-[hsl(232_60%_9%)]"
          title="Invite a teammate"
          data-testid="button-invite"
        >
          <Plus className="w-5 h-5" />
        </button>
      )}

      <NotificationsButton />

      <div className="w-12 h-12 flex items-center justify-center hover:bg-[hsl(232_45%_27%)] rounded-2xl transition-all">
        <AppSwitcher currentApp="chat" dark />
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="w-12 h-12 rounded-2xl flex items-center justify-center hover:bg-[hsl(232_45%_27%)] transition-all text-[hsl(0_0%_70%)]"
            title="Settings"
            data-testid="button-app-settings"
          >
            <Settings className="w-5 h-5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="end" className="w-56 vs-navy-panel border-[hsl(232_40%_25%)] text-white">
          <DropdownMenuLabel className="text-[hsl(0_0%_70%)]">
            <div className="font-semibold text-white truncate">{user?.name}</div>
            <div className="text-[10px] font-mono uppercase tracking-wider text-vs-blue-light">{user?.role}</div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator className="bg-[hsl(232_40%_25%)]" />
          <DropdownMenuItem className="text-sm cursor-pointer focus:bg-[hsl(232_45%_30%)] focus:text-white" data-testid="menu-profile">
            Profile
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => logout()} className="text-sm cursor-pointer focus:bg-[hsl(232_45%_30%)] focus:text-white text-vs-red" data-testid="menu-logout">
            <LogOut className="w-3.5 h-3.5 mr-2" /> Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {inviteOpen && (
        <InviteDialog
          open={inviteOpen}
          onClose={() => setInviteOpen(false)}
          projects={projects}
          defaultProjectId={activeId ?? projects[0]?.id ?? null}
        />
      )}
    </aside>
  );
}

function ConnectionDot({ status }: { status: "connecting" | "open" | "closed" }) {
  const color =
    status === "open" ? "bg-vs-green" :
    status === "connecting" ? "bg-vs-amber pulse-dot" :
    "bg-vs-red";
  const title =
    status === "open" ? "Live (connected)" :
    status === "connecting" ? "Connecting…" :
    "Offline";
  return (
    <span
      title={title}
      className={`absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-[hsl(232_60%_9%)] ${color}`}
      data-testid="status-connection"
    />
  );
}

function ProjectPill({
  project,
  active,
  unread,
  onClick,
}: {
  project: ApiProject;
  active: boolean;
  unread: number;
  onClick: () => void;
}) {
  const c1 = `hsl(${project.hue} 70% 55%)`;
  const c2 = `hsl(${(project.hue + 30) % 360} 60% 30%)`;

  return (
    <button
      type="button"
      onClick={onClick}
      title={project.name}
      data-testid={`button-project-${project.id}`}
      className={[
        "relative group w-12 h-12 transition-all flex items-center justify-center",
        active
          ? "rounded-xl ring-2 ring-vs-red shadow-lg"
          : "rounded-2xl hover:rounded-xl",
      ].join(" ")}
      style={{
        background: active
          ? `linear-gradient(135deg, ${c1} 0%, ${c2} 100%)`
          : "hsl(232 45% 27%)",
      }}
    >
      <span
        className={[
          "absolute -left-3 w-1.5 rounded-r-full bg-vs-red transition-all",
          active ? "h-8" : "h-0 group-hover:h-4",
        ].join(" ")}
      />
      <span
        className={[
          "font-display text-[11px] tracking-tight",
          active ? "text-[hsl(232_60%_9%)]" : "text-[hsl(0_0%_92%)]",
        ].join(" ")}
      >
        {project.short}
      </span>

      {unread > 0 && !active && (
        <span className="absolute -bottom-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-vs-red text-white text-[10px] font-bold flex items-center justify-center ring-2 ring-[hsl(232_60%_9%)]">
          {unread > 99 ? "99+" : unread}
        </span>
      )}
    </button>
  );
}
