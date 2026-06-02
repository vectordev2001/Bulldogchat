import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Plus, MessageSquare, Search, X, Loader2 } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Avatar } from "./Avatar";
import type { ApiUser, ApiDmChannel } from "@/types/api";

interface Props {
  me: ApiUser;
  orgMembers: ApiUser[];
  activeDmId: number | null;
  onSelectDm: (id: number) => void;
}

// Direct-Messages section that sits at the TOP of the sidebar, above Jobs and
// global Channels. Lists every DM the caller is part of (1:1 and group) plus
// a "+" affordance that opens a member picker to start a new DM. Tapping a
// row swaps the main view to the DM thread; tapping "+" with the same set as
// an existing DM re-opens that thread (the server's find-or-create endpoint
// makes the picker idempotent).
export function DmSection({ me, orgMembers, activeDmId, onSelectDm }: Props) {
  const [open, setOpen] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);

  const dmsQ = useQuery<ApiDmChannel[]>({
    queryKey: ["/api/dms"],
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
  const dms = dmsQ.data ?? [];

  // Build a quick id→user map so each DM row can render member names without
  // a per-row lookup. Falls back to "Unknown user" if a member was deactivated
  // between the DM creation and this render.
  const userById = useMemo(() => {
    const m = new Map<number, ApiUser>();
    for (const u of orgMembers) m.set(u.id, u);
    return m;
  }, [orgMembers]);

  return (
    <>
      <div>
        <button
          type="button"
          onClick={() => setOpen(v => !v)}
          className="w-full flex items-center gap-1 px-1.5 py-1 text-[11px] uppercase tracking-[0.14em] font-bold text-[hsl(0_0%_55%)] hover:text-white"
          data-testid="button-toggle-dms"
        >
          {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          <span className="flex-1 text-left">Direct Messages</span>
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); setPickerOpen(true); }}
            onKeyDown={(e) => { if (e.key === "Enter") { e.stopPropagation(); setPickerOpen(true); } }}
            className="opacity-70 hover:opacity-100 hover:text-white p-0.5 rounded cursor-pointer"
            title="New direct message"
            data-testid="button-new-dm"
          >
            <Plus className="w-3.5 h-3.5" />
          </span>
        </button>

        {open && (
          <div className="space-y-0.5 mt-0.5">
            {dmsQ.isLoading && (
              <div className="px-2 py-1.5 text-[11px] text-[hsl(0_0%_45%)]">Loading…</div>
            )}
            {!dmsQ.isLoading && dms.length === 0 && (
              <div className="px-2 py-1.5 text-[11px] text-[hsl(0_0%_55%)]">
                No direct messages yet.
              </div>
            )}
            {dms.map(dm => (
              <DmRow
                key={dm.id}
                dm={dm}
                me={me}
                userById={userById}
                active={dm.id === activeDmId}
                onClick={() => onSelectDm(dm.id)}
              />
            ))}
          </div>
        )}
      </div>

      {pickerOpen && (
        <NewDmDialog
          me={me}
          orgMembers={orgMembers}
          onClose={() => setPickerOpen(false)}
          onCreated={(dmId) => {
            setPickerOpen(false);
            // Invalidate so the new DM (or surfaced existing one) shows up
            // in the section list, then jump to it.
            queryClient.invalidateQueries({ queryKey: ["/api/dms"] });
            onSelectDm(dmId);
          }}
        />
      )}
    </>
  );
}

interface RowProps {
  dm: ApiDmChannel;
  me: ApiUser;
  userById: Map<number, ApiUser>;
  active: boolean;
  onClick: () => void;
}

// Each row shows a stacked avatar (1:1) or a group icon (3+ members) plus
// a comma-joined member name string. We intentionally do NOT render the
// internal `dm-<ids>-<ts>` channel name — that's just a database handle.
function DmRow({ dm, me, userById, active, onClick }: RowProps) {
  const others = dm.memberIds.filter(id => id !== me.id);
  const otherUsers = others.map(id => userById.get(id)).filter(Boolean) as ApiUser[];
  const isGroup = otherUsers.length > 1;
  const label = otherUsers.length === 0
    ? "Just you"
    : otherUsers.map(u => u.name).join(", ");
  const previewUser = otherUsers[0];

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md transition-colors text-left ${
        active
          ? "bg-[hsl(232_55%_22%)] text-white"
          : "text-[hsl(0_0%_75%)] hover:bg-[hsl(232_45%_25%)] hover:text-white"
      }`}
      data-testid={`button-dm-${dm.id}`}
      title={label}
    >
      {isGroup ? (
        <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-[hsl(232_45%_30%)] shrink-0">
          <MessageSquare className="w-3.5 h-3.5 text-white" />
        </span>
      ) : previewUser ? (
        <Avatar
          member={{ name: previewUser.name, hue: previewUser.hue, status: previewUser.presence ?? "offline" }}
          size={24}
          showStatus
        />
      ) : (
        <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-[hsl(232_45%_30%)] shrink-0">
          <MessageSquare className="w-3.5 h-3.5 text-white" />
        </span>
      )}
      <span className="text-sm truncate min-w-0 flex-1">{label}</span>
    </button>
  );
}

interface DialogProps {
  me: ApiUser;
  orgMembers: ApiUser[];
  onClose: () => void;
  onCreated: (dmId: number) => void;
}

// Member-picker dialog. Same UX shape as the channel call picker / in-call
// add dialog so the behavior stays predictable: search box on top, checkable
// rows below, footer with cancel + create. The endpoint is idempotent so
// "create" against an existing member set just re-surfaces the thread.
function NewDmDialog({ me, orgMembers, onClose, onCreated }: DialogProps) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const candidates = useMemo(() => {
    const q = search.toLowerCase();
    return orgMembers
      .filter(u => u.id !== me.id && !u.deactivated)
      .filter(u =>
        !q ||
        u.name.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q) ||
        (u.title ?? "").toLowerCase().includes(q),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [orgMembers, search, me.id]);

  const toggle = (id: number) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const createMut = useMutation({
    mutationFn: async () => {
      const memberIds = Array.from(selected);
      return await apiRequest<{ id: number; created: boolean }>("POST", "/api/dms", { memberIds });
    },
    onSuccess: (data) => {
      onCreated(data.id);
    },
  });

  const disabled = selected.size === 0 || createMut.isPending;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-md bg-[hsl(232_55%_14%)] border border-black/40 rounded-lg shadow-xl flex flex-col max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-12 px-4 flex items-center justify-between border-b border-black/40">
          <div className="text-sm font-display tracking-wide text-white">New direct message</div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-[hsl(232_45%_25%)] text-[hsl(0_0%_70%)] hover:text-white"
            aria-label="Close"
            data-testid="button-close-dm-picker"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-3 pt-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[hsl(0_0%_50%)]" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search people"
              className="w-full bg-[hsl(232_60%_9%)] border border-black/40 text-sm text-white placeholder:text-[hsl(0_0%_45%)] rounded-md pl-8 pr-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-vs-red"
              data-testid="input-dm-picker-search"
              autoFocus
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5 min-h-0">
          {candidates.length === 0 ? (
            <div className="px-2 py-3 text-xs text-[hsl(0_0%_60%)] text-center">No matching people.</div>
          ) : (
            candidates.map(u => {
              const checked = selected.has(u.id);
              return (
                <button
                  type="button"
                  key={u.id}
                  onClick={() => toggle(u.id)}
                  className={`w-full flex items-center gap-2 px-2 py-2 rounded-md text-left transition-colors ${
                    checked ? "bg-[hsl(232_55%_22%)]" : "hover:bg-[hsl(232_45%_25%)]"
                  }`}
                  data-testid={`button-pick-user-${u.id}`}
                >
                  <Avatar
                    member={{ name: u.name, hue: u.hue, status: u.presence ?? "offline" }}
                    size={28}
                    showStatus
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-white truncate">{u.name}</div>
                    <div className="text-[11px] text-[hsl(0_0%_55%)] truncate">{u.title || u.email}</div>
                  </div>
                  <input
                    type="checkbox"
                    checked={checked}
                    readOnly
                    className="w-4 h-4 accent-vs-red"
                    aria-label={`Select ${u.name}`}
                  />
                </button>
              );
            })
          )}
        </div>

        <div className="h-14 px-3 flex items-center justify-between border-t border-black/40 gap-2">
          <div className="text-[11px] text-[hsl(0_0%_55%)]">
            {selected.size === 0
              ? "Pick one or more people"
              : selected.size === 1
                ? "1 person selected"
                : `${selected.size} people selected`}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-sm rounded-md text-[hsl(0_0%_75%)] hover:bg-[hsl(232_45%_25%)] hover:text-white"
              data-testid="button-cancel-dm-picker"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => createMut.mutate()}
              disabled={disabled}
              className="px-3 py-1.5 text-sm rounded-md bg-vs-red text-white font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
              data-testid="button-confirm-dm-picker"
            >
              {createMut.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {selected.size > 1 ? "Start group" : "Start chat"}
            </button>
          </div>
        </div>

        {createMut.isError && (
          <div className="px-3 pb-2 text-[11px] text-red-400">
            {(createMut.error as Error).message || "Failed to start DM"}
          </div>
        )}
      </div>
    </div>
  );
}
