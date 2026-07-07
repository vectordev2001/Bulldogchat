import { useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2, Search, X } from "lucide-react";
import { apiCreateTitledDm, apiRenameDm, queryClient } from "@/lib/queryClient";
import { Avatar } from "./Avatar";
import type { ApiUser } from "@/types/api";

// Titled Chats (Phase 2.5) — one dialog, two modes:
//   mode="create" — title input + participant picker, always POSTs
//     /api/dms/titled (never find-or-create; a new channel is always made).
//   mode="rename" — title input only (no picker; membership doesn't change
//     on rename), PATCHes /api/dms/:id. Clearing the field sends `null` so
//     the row falls back to the participant-name-list label.
interface CreateProps {
  mode: "create";
  me: ApiUser;
  orgMembers: ApiUser[];
  onClose: () => void;
  onDone: (dmId: number) => void;
}

interface RenameProps {
  mode: "rename";
  dmId: number;
  currentTitle: string | null;
  onClose: () => void;
  onDone: (dmId: number) => void;
}

type Props = CreateProps | RenameProps;

export function TitledChatDialog(props: Props) {
  const { onClose, onDone } = props;
  const [title, setTitle] = useState(props.mode === "rename" ? props.currentTitle ?? "" : "");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const candidates = useMemo(() => {
    if (props.mode !== "create") return [];
    const q = search.toLowerCase();
    return props.orgMembers
      .filter((u) => u.id !== props.me.id && !u.deactivated)
      .filter(
        (u) =>
          !q ||
          u.name.toLowerCase().includes(q) ||
          u.email.toLowerCase().includes(q) ||
          (u.title ?? "").toLowerCase().includes(q),
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [props, search]);

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const trimmedTitle = title.trim();

  const mutation = useMutation({
    mutationFn: async () => {
      if (props.mode === "create") {
        return apiCreateTitledDm<{ id: number }>({
          title: trimmedTitle,
          memberIds: Array.from(selected),
        });
      }
      // Rename: empty string clears the title (server also treats "" as
      // null, but we normalize here too so the optimistic UI matches).
      return apiRenameDm<{ id: number }>(props.dmId, trimmedTitle.length > 0 ? trimmedTitle : null);
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/dms"] });
      onDone(data.id ?? (props.mode === "rename" ? props.dmId : data.id));
    },
  });

  const canSubmit =
    props.mode === "create"
      ? trimmedTitle.length > 0 && trimmedTitle.length <= 80 && selected.size > 0 && !mutation.isPending
      : trimmedTitle.length <= 80 && !mutation.isPending;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div
        className="w-full max-w-md bg-[hsl(220_55%_14%)] border border-black/40 rounded-lg shadow-xl flex flex-col max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="h-12 px-4 flex items-center justify-between border-b border-black/40">
          <div className="text-sm font-display tracking-wide text-white">
            {props.mode === "create" ? "New titled chat" : "Rename chat"}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded hover:bg-[hsl(220_45%_25%)] text-[hsl(0_0%_70%)] hover:text-white"
            aria-label="Close"
            data-testid="button-close-titled-chat-dialog"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-3 pt-3 space-y-1">
          <label htmlFor="titled-chat-title" className="text-[11px] uppercase tracking-wide text-[hsl(0_0%_55%)]">
            Title
          </label>
          <input
            id="titled-chat-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={props.mode === "rename" ? "Clear to use participant names" : "e.g. Q3 Budget Review"}
            maxLength={80}
            autoFocus
            className="w-full bg-[hsl(220_60%_9%)] border border-black/40 text-sm text-white placeholder:text-[hsl(0_0%_45%)] rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-vs-red"
            data-testid="input-titled-chat-title"
          />
          <div className="text-[10px] text-[hsl(0_0%_45%)] text-right">{trimmedTitle.length}/80</div>
        </div>

        {props.mode === "create" && (
          <>
            <div className="px-3 pt-1">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[hsl(0_0%_50%)]" />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search people"
                  className="w-full bg-[hsl(220_60%_9%)] border border-black/40 text-sm text-white placeholder:text-[hsl(0_0%_45%)] rounded-md pl-8 pr-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-vs-red"
                  data-testid="input-titled-chat-picker-search"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-2 py-2 space-y-0.5 min-h-0">
              {candidates.length === 0 ? (
                <div className="px-2 py-3 text-xs text-[hsl(0_0%_60%)] text-center">No matching people.</div>
              ) : (
                candidates.map((u) => {
                  const checked = selected.has(u.id);
                  return (
                    <button
                      type="button"
                      key={u.id}
                      onClick={() => toggle(u.id)}
                      className={`w-full flex items-center gap-2 px-2 py-2 rounded-md text-left transition-colors ${
                        checked ? "bg-[hsl(220_55%_22%)]" : "hover:bg-[hsl(220_45%_25%)]"
                      }`}
                      data-testid={`button-pick-titled-user-${u.id}`}
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
          </>
        )}

        <div className="h-14 px-3 flex items-center justify-between border-t border-black/40 gap-2 shrink-0">
          <div className="text-[11px] text-[hsl(0_0%_55%)]">
            {props.mode === "create"
              ? selected.size === 0
                ? "Pick one or more people"
                : `${selected.size} ${selected.size === 1 ? "person" : "people"} selected`
              : "Leave blank to clear the custom title"}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1.5 text-sm rounded-md text-[hsl(0_0%_75%)] hover:bg-[hsl(220_45%_25%)] hover:text-white"
              data-testid="button-cancel-titled-chat-dialog"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => mutation.mutate()}
              disabled={!canSubmit}
              className="px-3 py-1.5 text-sm rounded-md bg-vs-red text-white font-medium disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
              data-testid="button-confirm-titled-chat-dialog"
            >
              {mutation.isPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {props.mode === "create" ? "Create" : "Save"}
            </button>
          </div>
        </div>

        {mutation.isError && (
          <div className="px-3 pb-2 text-[11px] text-red-400">
            {(mutation.error as Error).message || "Something went wrong"}
          </div>
        )}
      </div>
    </div>
  );
}
