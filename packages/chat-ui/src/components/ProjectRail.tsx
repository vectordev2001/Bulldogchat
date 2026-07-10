import { Plus, Settings, LogOut, Check, Circle, Star } from "lucide-react";
import { VectorLogo } from "./VectorLogo";
import type { ApiProject, UserPresence } from "../types/api";
import { useAuth } from "../lib/auth-context";
import { useState } from "react";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuTrigger, DropdownMenuSeparator, DropdownMenuLabel,
} from "./ui/dropdown-menu";
import { InviteDialog } from "./InviteDialog";
import { usePresence } from "../hooks/use-presence";
import { PRESENCE_COLOR } from "./Avatar";

const PRESENCE_OPTIONS: Array<{
  value: UserPresence;
  label: string;
  hint: string;
}> = [
  { value: "online", label: "Online", hint: "Ready to chat" },
  { value: "busy", label: "Busy", hint: "Do not disturb — push notifications off" },
  { value: "offline", label: "Appear offline", hint: "Hide your activity" },
];
const PRESENCE_LABEL: Record<UserPresence, string> = {
  online: "Online",
  away: "Away",
  busy: "Busy",
  offline: "Offline",
};

interface Props {
  projects: ApiProject[];
  activeId: number | null;
  onSelect: (id: number) => void;
  unreadByProjectId?: Record<number, number>;
  // Companies that have any unread signal (chat or missed call). Rendered
  // as a small star overlay in the pill's top-right corner so the user can
  // scan the rail at a glance without opening each company. See
  // `use-unread` for how this is computed + kept live.
  hasUnreadByProjectId?: Record<number, boolean>;
  // Right-click a company pill to clear every unread signal for that
  // company at once. Wired to POST /api/projects/:id/read in Home.tsx.
  onMarkAllRead?: (projectId: number) => void;
  sseStatus: "connecting" | "open" | "closed";
}

export function ProjectRail({ projects, activeId, onSelect, unreadByProjectId, hasUnreadByProjectId, onMarkAllRead, sseStatus }: Props) {
  const { user, logout } = useAuth();
  const { presence, manualPresence, setManualPresence } = usePresence();
  const [inviteOpen, setInviteOpen] = useState(false);

  const isAdmin = user?.role === "admin";

  return (
    <aside
      className="flex flex-col items-center w-[72px] shrink-0 vs-navy-deep border-r border-black/40 py-3 gap-1.5"
      data-testid="rail-projects"
    >
      <button
        type="button"
        className="w-12 h-12 rounded-2xl flex items-center justify-center hover:rounded-xl transition-all bg-[hsl(220_45%_27%)] hover:bg-vs-red group relative"
        onClick={() => projects[0] && onSelect(projects[0].id)}
        title="Bulldog Chat"
        data-testid="button-home"
      >
        <VectorLogo size={32} className="text-white" monochrome />
        <ConnectionDot status={sseStatus} />
      </button>

      <div className="h-[2px] w-8 bg-[hsl(220_40%_25%)] rounded-full my-1" />

      <div className="flex flex-col gap-1.5 overflow-y-auto flex-1 w-full items-center px-1">
        {projects.map((p) => (
          <ProjectPill
            key={p.id}
            project={p}
            active={p.id === activeId}
            unread={unreadByProjectId?.[p.id] ?? 0}
            hasUnread={!!hasUnreadByProjectId?.[p.id]}
            onClick={() => onSelect(p.id)}
            onMarkAllRead={onMarkAllRead ? () => onMarkAllRead(p.id) : undefined}
          />
        ))}
      </div>

      <div className="h-[2px] w-8 bg-[hsl(220_40%_25%)] rounded-full my-1" />

      {isAdmin && (
        <button
          type="button"
          onClick={() => setInviteOpen(true)}
          className="w-12 h-12 rounded-2xl flex items-center justify-center bg-[hsl(220_45%_27%)] hover:rounded-xl hover:bg-vs-blue transition-all text-vs-blue hover:text-[hsl(220_60%_9%)]"
          title="Invite a teammate"
          data-testid="button-invite"
        >
          <Plus className="w-5 h-5" />
        </button>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="relative w-12 h-12 rounded-2xl flex items-center justify-center hover:bg-[hsl(220_45%_27%)] transition-all text-[hsl(0_0%_70%)]"
            title={`Status: ${PRESENCE_LABEL[presence]} — click to change`}
            data-testid="button-app-settings"
            aria-label={`Status: ${PRESENCE_LABEL[presence]}`}
          >
            <Settings className="w-5 h-5" />
            {/* Presence dot — colored per Phase 1.9 state. Replaces the old
                static green dot the user reported as inert. */}
            <span
              className="absolute top-1 right-1 w-3 h-3 rounded-full ring-2 ring-[hsl(220_60%_9%)]"
              style={{ background: PRESENCE_COLOR[presence] ?? PRESENCE_COLOR.online }}
              data-testid="status-presence-dot"
            />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="end" className="w-60 bg-popover border-popover-border text-popover-foreground">
          <DropdownMenuLabel className="text-[hsl(var(--vs-text-muted))]">
            <div className="font-semibold text-[hsl(var(--vs-text))] truncate">{user?.name}</div>
            <div className="text-[10px] font-mono uppercase tracking-wider text-vs-accent">{user?.role}</div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator className="bg-border" />
          <DropdownMenuLabel className="text-[10px] font-mono uppercase tracking-wider text-[hsl(var(--vs-text-subtle))] pt-2 pb-1">
            Status
          </DropdownMenuLabel>
          {PRESENCE_OPTIONS.map((opt) => {
            // Show check next to the user's *manual* pick — 'away' is
            // automatic so it never shows as a selectable option.
            const selected = manualPresence === opt.value;
            return (
              <DropdownMenuItem
                key={opt.value}
                onClick={() => setManualPresence(opt.value)}
                className="text-sm cursor-pointer focus:bg-accent focus:text-accent-foreground flex items-center gap-2"
                data-testid={`menu-presence-${opt.value}`}
              >
                <Circle
                  className="w-2.5 h-2.5 shrink-0"
                  style={{ color: PRESENCE_COLOR[opt.value], fill: PRESENCE_COLOR[opt.value] }}
                />
                <div className="flex-1 min-w-0">
                  <div className="truncate">{opt.label}</div>
                  <div className="text-[10px] text-[hsl(var(--vs-text-subtle))] truncate">{opt.hint}</div>
                </div>
                {selected && <Check className="w-3.5 h-3.5 text-vs-accent shrink-0" />}
              </DropdownMenuItem>
            );
          })}
          {presence === "away" && (
            <div className="px-2 py-1 text-[10px] text-[hsl(45_90%_65%)] font-mono uppercase tracking-wider">
              Currently away (auto)
            </div>
          )}
          <DropdownMenuSeparator className="bg-border" />
          <DropdownMenuItem className="text-sm cursor-pointer focus:bg-accent focus:text-accent-foreground" data-testid="menu-profile">
            Profile
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => logout()} className="text-sm cursor-pointer focus:bg-accent focus:text-accent-foreground text-vs-danger" data-testid="menu-logout">
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
      className={`absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ring-2 ring-[hsl(220_60%_9%)] ${color}`}
      data-testid="status-connection"
    />
  );
}

function ProjectPill({
  project,
  active,
  unread,
  hasUnread,
  onClick,
  onMarkAllRead,
}: {
  project: ApiProject;
  active: boolean;
  unread: number;
  hasUnread: boolean;
  onClick: () => void;
  onMarkAllRead?: () => void;
}) {
  const c1 = `hsl(${project.hue} 70% 55%)`;
  const c2 = `hsl(${(project.hue + 30) % 360} 60% 30%)`;

  return (
    <button
      type="button"
      onClick={onClick}
      onContextMenu={(e) => {
        if (!onMarkAllRead) return;
        e.preventDefault();
        if (!hasUnread && (unread ?? 0) === 0) return;
        onMarkAllRead();
      }}
      title={onMarkAllRead ? `${project.name} — right-click to mark all read` : project.name}
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
          : "hsl(220 45% 27%)",
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
          active ? "text-[hsl(220_60%_9%)]" : "text-[hsl(0_0%_92%)]",
        ].join(" ")}
      >
        {project.short}
      </span>

      {unread > 0 && !active && (
        <span className="absolute -bottom-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-vs-red text-white text-[10px] font-bold flex items-center justify-center ring-2 ring-[hsl(220_60%_9%)]">
          {unread > 99 ? "99+" : unread}
        </span>
      )}

      {/*
         Unread-star overlay. Fires whenever this company has ANY unread
         signal (new chat or missed call), regardless of whether it's
         also the active company. That way the star is a stable at-a-glance
         indicator on the rail even for the pill you're currently viewing
         (it clears once the channel is marked read). Uses vs-amber so it
         doesn't clash with the red numeric badge above.
       */}
      {hasUnread && (
        <span
          className="absolute -top-1 -right-1 w-4 h-4 flex items-center justify-center rounded-full bg-[hsl(220_60%_9%)] ring-2 ring-[hsl(220_60%_9%)]"
          data-testid={`badge-unread-star-${project.id}`}
          title="New activity"
          aria-label="New activity"
        >
          <Star className="w-3 h-3 text-vs-amber fill-vs-amber" />
        </span>
      )}
    </button>
  );
}
