import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Avatar } from "./Avatar";
import type { ApiUser, UserRole } from "@/types/api";
import { useCalls } from "@/lib/CallContext";
import { Phone, Video, X, UserPlus, Loader2, Check, Search } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";

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
  /** Effective channel members (already scope-filtered). */
  members: ApiUser[];
  /** Current user id — used to hide call buttons on self row. */
  meId?: number;
  /** Full org roster — needed for the "Add members" picker. */
  orgMembers?: ApiUser[];
  /** Active channel id — needed to POST add-member. */
  channelId?: number;
  /** Current user's role — admins see the Add Members button. */
  myRole?: UserRole;
  /** Mobile drawer mode: render as a slide-over overlay instead of a static sidebar. */
  mobile?: boolean;
  /** Called when the mobile drawer is dismissed (backdrop tap or close button). */
  onClose?: () => void;
}

export function MemberList({ members, meId, orgMembers, channelId, myRole, mobile, onClose }: Props) {
  const [addOpen, setAddOpen] = useState(false);

  const online = members.filter((m) => m.status !== "offline");
  const offline = members.filter((m) => m.status === "offline");
  online.sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role));

  const canAdd = myRole === "admin" && !!channelId && !!orgMembers;

  // Inner content (header + body) reused by both desktop sidebar and mobile drawer.
  const body = (
    <>
      <div className="px-4 py-3 border-b border-black/30 flex items-start justify-between gap-2">
        <div>
          <div className="text-[10px] uppercase tracking-[0.16em] text-vs-red font-bold">Roster</div>
          <div className="text-sm text-white mt-0.5">
            {members.length} members · <span className="text-vs-green">{online.length} online</span>
          </div>
        </div>
        {mobile && (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close members"
            className="p-1.5 -mr-1 rounded-md text-white/70 hover:text-white hover:bg-black/30"
            data-testid="button-close-members"
          >
            <X className="w-5 h-5" />
          </button>
        )}
      </div>

      {canAdd && (
        <div className="px-2 pt-2">
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-md bg-vs-red hover:bg-vs-red/90 text-white text-xs font-bold uppercase tracking-wider transition-colors"
            data-testid="button-add-members"
          >
            <UserPlus className="w-3.5 h-3.5" />
            Add members
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-2 py-3">
        <RoleGroup label={`Online — ${online.length}`} members={online} meId={meId} />
        {offline.length > 0 && <RoleGroup label={`Offline — ${offline.length}`} members={offline} meId={meId} dimmed />}
      </div>
    </>
  );

  if (mobile) {
    return (
      <>
        <div
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
          onClick={onClose}
          aria-hidden
          data-testid="backdrop-members"
        />
        <aside
          className="fixed top-0 right-0 z-50 h-full w-[85vw] max-w-[320px] vs-navy border-l border-black/30 flex flex-col md:hidden shadow-2xl"
          role="dialog"
          aria-label="Channel members"
          data-testid="drawer-members"
        >
          {body}
        </aside>
        {addOpen && channelId && orgMembers && (
          <AddMembersDialog
            channelId={channelId}
            current={members}
            orgMembers={orgMembers}
            onClose={() => setAddOpen(false)}
          />
        )}
      </>
    );
  }

  return (
    <>
      <aside
        className="w-[240px] shrink-0 vs-navy border-l border-black/30 flex flex-col"
        data-testid="sidebar-members"
      >
        {body}
      </aside>
      {addOpen && channelId && orgMembers && (
        <AddMembersDialog
          channelId={channelId}
          current={members}
          orgMembers={orgMembers}
          onClose={() => setAddOpen(false)}
        />
      )}
    </>
  );
}

function RoleGroup({ label, members, meId, dimmed }: { label: string; members: ApiUser[]; meId?: number; dimmed?: boolean }) {
  return (
    <div className="mb-4">
      <div className="px-2 py-1 text-[10px] uppercase tracking-[0.16em] font-bold text-[hsl(0_0%_55%)]">{label}</div>
      <div className="space-y-0.5">
        {members.map((m) => (
          <MemberRow key={m.id} member={m} meId={meId} dimmed={dimmed} />
        ))}
      </div>
    </div>
  );
}

function MemberRow({ member, meId, dimmed }: { member: ApiUser; meId?: number; dimmed?: boolean }) {
  const { startCall, active, outgoing } = useCalls();
  const isMe = meId != null && member.id === meId;
  const busy = !!active || !!outgoing;

  const onCall = (e: React.MouseEvent, kind: "voice" | "video") => {
    e.stopPropagation();
    e.preventDefault();
    if (isMe || busy) return;
    void startCall({
      calleeId: member.id,
      calleeName: member.name,
      calleeHue: member.hue,
      kind,
    });
  };

  return (
    <div
      className={[
        "group flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-[hsl(232_45%_27%)] transition-colors",
        isMe ? "" : "cursor-pointer",
        dimmed ? "opacity-50" : "",
      ].join(" ")}
      data-testid={`member-${member.id}`}
    >
      <Avatar
        member={{
          name: member.name,
          hue: member.hue,
          status: member.status,
          presence: (member as { presence?: "online" | "away" | "busy" | "offline" }).presence,
        }}
        size={32}
        showStatus
      />
      <div className="min-w-0 flex-1">
        <div className={`text-sm font-semibold truncate ${ROLE_TINT[member.role]}`}>
          {member.name}{isMe ? " (you)" : ""}
        </div>
        <div className="text-[10px] text-[hsl(0_0%_60%)] truncate font-mono uppercase tracking-wider">
          {ROLE_LABEL[member.role]}{member.title ? ` · ${member.title}` : ""}
        </div>
      </div>

      {!isMe && (
        // On mobile (touch, no hover) the call buttons stay visible; on
        // desktop they fade in on row hover.
        <div className="flex items-center gap-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
          <button
            type="button"
            onClick={(e) => onCall(e, "voice")}
            disabled={busy}
            title={busy ? "In a call" : `Voice call ${member.name}`}
            aria-label={`Voice call ${member.name}`}
            className="p-1.5 rounded-md text-vs-green hover:bg-black/30 disabled:opacity-40 disabled:cursor-not-allowed"
            data-testid={`button-call-voice-${member.id}`}
          >
            <Phone className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={(e) => onCall(e, "video")}
            disabled={busy}
            title={busy ? "In a call" : `Video call ${member.name}`}
            aria-label={`Video call ${member.name}`}
            className="p-1.5 rounded-md text-vs-blue-light hover:bg-black/30 disabled:opacity-40 disabled:cursor-not-allowed"
            data-testid={`button-call-video-${member.id}`}
          >
            <Video className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// AddMembersDialog — admin-only picker that lists org members not already
// in this channel, lets the admin select one or more, and POSTs to
// /api/channels/:id/members. Server enforces admin role; we just provide
// the UI surface. Works on iPhone (full-screen sheet on mobile).
// ──────────────────────────────────────────────────────────────────────────

function AddMembersDialog({
  channelId,
  current,
  orgMembers,
  onClose,
}: {
  channelId: number;
  current: ApiUser[];
  orgMembers: ApiUser[];
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [q, setQ] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const currentIds = useMemo(() => new Set(current.map((m) => m.id)), [current]);
  const candidates = useMemo(() => {
    const term = q.trim().toLowerCase();
    return orgMembers
      .filter((m) => !m.deactivated && !currentIds.has(m.id))
      .filter((m) => !term || m.name.toLowerCase().includes(term) || (m.title?.toLowerCase().includes(term) ?? false))
      .sort((a, b) => ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) || a.name.localeCompare(b.name));
  }, [orgMembers, currentIds, q]);

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const addMut = useMutation({
    mutationFn: async () => {
      const userIds = Array.from(selected);
      if (userIds.length === 0) return;
      return apiRequest("POST", `/api/channels/${channelId}/members`, { userIds });
    },
    onSuccess: () => {
      // Channel members + org members queries both refresh so the new
      // additions show up in MemberList and in the call picker.
      void queryClient.invalidateQueries({ queryKey: ["channel-members", channelId] });
      void queryClient.invalidateQueries({ queryKey: ["/api/org/members"] });
      void queryClient.invalidateQueries({ queryKey: [`/api/channels/${channelId}/members`] });
      onClose();
    },
    onError: (e: unknown) => {
      setErr(e instanceof Error ? e.message : "Failed to add members");
    },
  });

  return (
    <div className="fixed inset-0 z-[60] flex items-end md:items-center justify-center">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} aria-hidden />
      <div
        className="relative w-full md:w-[420px] max-h-[85vh] md:max-h-[600px] vs-navy border border-black/40 rounded-t-2xl md:rounded-xl flex flex-col shadow-2xl"
        role="dialog"
        aria-label="Add members to channel"
        data-testid="dialog-add-members"
      >
        <div className="px-4 py-3 border-b border-black/30 flex items-center justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-[0.16em] text-vs-red font-bold">Add Members</div>
            <div className="text-sm text-white mt-0.5">
              {candidates.length === 0 ? "No one to add" : `${candidates.length} available`}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1.5 rounded-md text-white/70 hover:text-white hover:bg-black/30"
            data-testid="button-add-members-close"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-3 pt-3">
          <div className="flex items-center gap-2 bg-[hsl(232_60%_9%)] border border-[hsl(232_40%_22%)] rounded-md px-2 py-1.5">
            <Search className="w-3.5 h-3.5 text-[hsl(0_0%_55%)]" />
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name or title"
              className="flex-1 bg-transparent text-sm text-white placeholder:text-[hsl(0_0%_45%)] outline-none"
              data-testid="input-add-members-search"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2 min-h-[120px]">
          {candidates.length === 0 ? (
            <div className="text-center text-xs text-[hsl(0_0%_55%)] py-8 px-4">
              Every available org member is already in this channel.
            </div>
          ) : (
            <div className="space-y-0.5">
              {candidates.map((m) => {
                const isSel = selected.has(m.id);
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => toggle(m.id)}
                    className={[
                      "w-full flex items-center gap-2 px-2 py-2 rounded-md text-left transition-colors",
                      isSel ? "bg-vs-red/20 ring-1 ring-vs-red" : "hover:bg-[hsl(232_45%_27%)]",
                    ].join(" ")}
                    data-testid={`button-add-candidate-${m.id}`}
                  >
                    <Avatar
                      member={{
                        name: m.name,
                        hue: m.hue,
                        status: m.status,
                        presence: (m as { presence?: "online" | "away" | "busy" | "offline" }).presence,
                      }}
                      size={32}
                      showStatus
                    />
                    <div className="min-w-0 flex-1">
                      <div className={`text-sm font-semibold truncate ${ROLE_TINT[m.role]}`}>{m.name}</div>
                      <div className="text-[10px] text-[hsl(0_0%_60%)] truncate font-mono uppercase tracking-wider">
                        {ROLE_LABEL[m.role]}{m.title ? ` · ${m.title}` : ""}
                      </div>
                    </div>
                    <div
                      className={[
                        "w-5 h-5 rounded-md border flex items-center justify-center shrink-0",
                        isSel ? "bg-vs-red border-vs-red" : "border-[hsl(232_40%_30%)]",
                      ].join(" ")}
                      aria-hidden
                    >
                      {isSel && <Check className="w-3.5 h-3.5 text-white" />}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {err && (
          <div className="px-4 py-2 text-xs text-vs-red border-t border-black/30">{err}</div>
        )}

        <div className="px-3 py-3 border-t border-black/30 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-2 rounded-md text-xs font-bold uppercase tracking-wider text-white/70 hover:text-white hover:bg-black/30"
            data-testid="button-add-members-cancel"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={selected.size === 0 || addMut.isPending}
            onClick={() => {
              setErr(null);
              addMut.mutate();
            }}
            className="px-4 py-2 rounded-md bg-vs-red hover:bg-vs-red/90 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-bold uppercase tracking-wider transition-colors flex items-center gap-2"
            data-testid="button-add-members-submit"
          >
            {addMut.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Add {selected.size > 0 ? `(${selected.size})` : ""}
          </button>
        </div>
      </div>
    </div>
  );
}
