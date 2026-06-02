import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Avatar } from "./Avatar";
import type { ApiUser, UserRole } from "@/types/api";
import { useCalls } from "@/lib/CallContext";
import { Phone, Video, X, UserPlus, Loader2, Check, Search, PhoneCall } from "lucide-react";
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
  /** Active channel id — needed to POST add-member and for routing
   *  per-row "call their cell" through the group-call/start endpoint. */
  channelId?: number;
  /** Active channel name — surfaces as the SIP caller-id channel label
   *  ("Bulldog · #channel-name") when ringing a member's cell phone. */
  channelName?: string;
  /** Current user's role — admins see the Add Members button. */
  myRole?: UserRole;
  /** Mobile drawer mode: render as a slide-over overlay instead of a static sidebar. */
  mobile?: boolean;
  /** Called when the mobile drawer is dismissed (backdrop tap or close button). */
  onClose?: () => void;
}

export function MemberList({ members, meId, orgMembers, channelId, channelName, myRole, mobile, onClose }: Props) {
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
        <RoleGroup label={`Online — ${online.length}`} members={online} meId={meId} channelId={channelId} channelName={channelName} />
        {offline.length > 0 && <RoleGroup label={`Offline — ${offline.length}`} members={offline} meId={meId} channelId={channelId} channelName={channelName} dimmed />}
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

function RoleGroup({
  label, members, meId, channelId, channelName, dimmed,
}: {
  label: string;
  members: ApiUser[];
  meId?: number;
  channelId?: number;
  channelName?: string;
  dimmed?: boolean;
}) {
  return (
    <div className="mb-4">
      <div className="px-2 py-1 text-[10px] uppercase tracking-[0.16em] font-bold text-[hsl(0_0%_55%)]">{label}</div>
      <div className="space-y-0.5">
        {members.map((m) => (
          <MemberRow
            key={m.id}
            member={m}
            meId={meId}
            channelId={channelId}
            channelName={channelName}
            dimmed={dimmed}
          />
        ))}
      </div>
    </div>
  );
}

function MemberRow({
  member, meId, channelId, channelName, dimmed,
}: {
  member: ApiUser;
  meId?: number;
  channelId?: number;
  channelName?: string;
  dimmed?: boolean;
}) {
  const { startCall, startGroupCall, active, outgoing } = useCalls();
  const [chooserOpen, setChooserOpen] = useState(false);
  const isMe = meId != null && member.id === meId;
  const busy = !!active || !!outgoing;
  const memberPhone = (member as { phone?: string | null }).phone ?? null;

  const openChooser = () => {
    if (isMe || busy) return;
    setChooserOpen(true);
  };

  const callInApp = (kind: "voice" | "video") => {
    setChooserOpen(false);
    if (isMe || busy) return;
    void startCall({
      calleeId: member.id,
      calleeName: member.name,
      calleeHue: member.hue,
      kind,
    });
  };

  // "Call their cell" — use the group-call/start endpoint with a single
  // phoneInviteeId so the server looks up the member's saved phone and
  // bridges the call via Twilio (caller-id 'Bulldog · #channel'). We
  // route through startGroupCall so the caller still lands in the same
  // LiveKit room and can be joined from the chat or web app too.
  const callCell = () => {
    setChooserOpen(false);
    if (isMe || busy || !channelId || !memberPhone) return;
    void startGroupCall({
      channelId,
      channelName: channelName ?? "channel",
      inviteeIds: [],
      phoneInviteeIds: [member.id],
      kind: "voice",
    });
  };

  return (
    <>
      <button
        type="button"
        onClick={openChooser}
        disabled={isMe || busy}
        className={[
          "w-full group flex items-center gap-2 px-2 py-1.5 rounded-md text-left",
          "hover:bg-[hsl(232_45%_27%)] transition-colors",
          isMe ? "cursor-default" : busy ? "cursor-not-allowed opacity-60" : "cursor-pointer",
          dimmed ? "opacity-50" : "",
        ].join(" ")}
        data-testid={`member-${member.id}`}
        aria-label={isMe ? member.name : `Call ${member.name}`}
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
          // Tiny inline phone icon hints that the row is tappable. Real
          // routing choice (app vs cell) happens in the chooser dialog.
          <Phone className="w-3.5 h-3.5 text-[hsl(0_0%_50%)] group-hover:text-vs-red transition-colors shrink-0" />
        )}
      </button>

      {chooserOpen && !isMe && (
        <CallTargetDialog
          memberName={member.name}
          memberPhone={memberPhone}
          channelLabel={channelName ?? "channel"}
          onClose={() => setChooserOpen(false)}
          onCallAppVoice={() => callInApp("voice")}
          onCallAppVideo={() => callInApp("video")}
          onCallCell={callCell}
        />
      )}
    </>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// CallTargetDialog — modal shown when a member row is tapped. Lets the
// caller pick between in-app voice, in-app video, or ringing the member's
// cell phone. Cell option is disabled if no phone is on file. Mobile-first
// styling: full-width bottom sheet on small screens, centered card on md+.
// ──────────────────────────────────────────────────────────────────────────

function CallTargetDialog({
  memberName, memberPhone, channelLabel,
  onClose, onCallAppVoice, onCallAppVideo, onCallCell,
}: {
  memberName: string;
  memberPhone: string | null;
  channelLabel: string;
  onClose: () => void;
  onCallAppVoice: () => void;
  onCallAppVideo: () => void;
  onCallCell: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[100] flex items-end md:items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
      data-testid="dialog-call-target"
    >
      <div
        className="w-full md:w-[420px] md:max-w-[92vw] bg-[hsl(232_55%_13%)] border border-[hsl(232_40%_25%)] md:rounded-2xl rounded-t-2xl shadow-2xl overflow-hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-[hsl(232_40%_22%)] flex items-center justify-between">
          <div className="min-w-0">
            <div className="text-sm font-display text-white truncate">Call {memberName}</div>
            <div className="text-[10px] text-[hsl(0_0%_60%)] font-mono uppercase tracking-wider">
              How do you want to reach them?
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-md text-[hsl(0_0%_70%)] hover:text-white hover:bg-black/30"
            aria-label="Close"
            data-testid="button-call-target-close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-3 flex flex-col gap-2">
          {/* In-app voice */}
          <button
            type="button"
            onClick={onCallAppVoice}
            className="flex items-center gap-3 px-3 py-3 rounded-xl bg-[hsl(232_50%_18%)] hover:bg-[hsl(232_50%_22%)] border border-[hsl(232_40%_25%)] transition-colors text-left"
            data-testid="button-call-target-app-voice"
          >
            <div className="w-10 h-10 rounded-full bg-vs-green/15 border border-vs-green/40 flex items-center justify-center shrink-0">
              <Phone className="w-5 h-5 text-vs-green" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-white">Voice call in app</div>
              <div className="text-[11px] text-[hsl(0_0%_65%)]">Rings them on Bulldog Chat (web + mobile)</div>
            </div>
          </button>

          {/* In-app video */}
          <button
            type="button"
            onClick={onCallAppVideo}
            className="flex items-center gap-3 px-3 py-3 rounded-xl bg-[hsl(232_50%_18%)] hover:bg-[hsl(232_50%_22%)] border border-[hsl(232_40%_25%)] transition-colors text-left"
            data-testid="button-call-target-app-video"
          >
            <div className="w-10 h-10 rounded-full bg-vs-blue-light/15 border border-vs-blue-light/40 flex items-center justify-center shrink-0">
              <Video className="w-5 h-5 text-vs-blue-light" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-white">Video call in app</div>
              <div className="text-[11px] text-[hsl(0_0%_65%)]">Rings them on Bulldog Chat with camera on</div>
            </div>
          </button>

          {/* Cell phone */}
          <button
            type="button"
            onClick={onCallCell}
            disabled={!memberPhone}
            className="flex items-center gap-3 px-3 py-3 rounded-xl bg-[hsl(232_50%_18%)] hover:bg-[hsl(232_50%_22%)] border border-[hsl(232_40%_25%)] transition-colors text-left disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-[hsl(232_50%_18%)]"
            data-testid="button-call-target-cell"
          >
            <div className="w-10 h-10 rounded-full bg-vs-red/15 border border-vs-red/40 flex items-center justify-center shrink-0">
              <PhoneCall className="w-5 h-5 text-vs-red" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-white">Call their cell phone</div>
              <div className="text-[11px] text-[hsl(0_0%_65%)] truncate">
                {memberPhone
                  ? `Dials ${memberPhone} · caller ID “Bulldog · #${channelLabel}”`
                  : "No phone number on file"}
              </div>
            </div>
          </button>
        </div>
      </div>
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
