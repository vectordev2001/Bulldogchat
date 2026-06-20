// Phase 1.9.4 — meeting notes history popover.
//
// Lists every clerk session that ran on this channel. For each row we show:
//   - title (Claude-generated) or "Notes #N" fallback
//   - date / duration / attendees count
//   - status badge (uploaded / failed / processing)
//   - inline summary preview (first ~3 lines of the markdown)
//   - Synology remote path (the operator's NAS file)
//
// We intentionally don't render the PDF inline — it's on Synology, not on
// chat's S3, so the canonical place to read it is the NAS. We show the
// Claude markdown right in the dialog as the "online" copy.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileText, ChevronDown, ChevronRight, Loader2, CheckCircle2, AlertTriangle, Trash2 } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";

interface NoteRow {
  id: number;
  channelId: number;
  startedAt: number;
  endedAt?: number | null;
  status:
    | "recording"
    | "transcribing"
    | "summarizing"
    | "rendering"
    | "uploading"
    | "uploaded"
    | "failed";
  title?: string | null;
  summaryMarkdown?: string | null;
  attendees: Array<{ name: string; email?: string }>;
  synologyStatus?: string | null;
  synologyRemotePath?: string | null;
  synologyReason?: string | null;
  durationSeconds?: number | null;
  pdfSizeBytes?: number | null;
  errorMessage?: string | null;
}

interface Props {
  channelId: number;
  open: boolean;
  onClose: () => void;
}

function fmtDate(ms?: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}
function fmtDuration(sec?: number | null): string {
  if (sec == null) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}
function fmtBytes(n?: number | null): string {
  if (!n) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function MeetingNotesHistory({ channelId, open, onClose }: Props) {
  const qc = useQueryClient();
  const q = useQuery<NoteRow[]>({
    queryKey: ["/api/channels", channelId, "meeting-notes"],
    enabled: open && !!channelId,
    refetchInterval: open ? 5000 : false,
  });
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null);

  const delMut = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/meeting-notes/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/channels", channelId, "meeting-notes"] });
      setPendingDeleteId(null);
    },
  });

  if (!open) return null;

  const rows = q.data ?? [];

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center p-4 bg-black/60"
      onClick={onClose}
      data-testid="dialog-meeting-notes-history"
    >
      <div
        className="mt-12 w-full max-w-2xl rounded-xl border border-[hsl(220_40%_25%)] bg-[hsl(220_45%_10%)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-5 py-3 border-b border-[hsl(220_40%_25%)]">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-vs-blue-light" />
            <h2 className="text-sm font-semibold text-[hsl(0_0%_92%)]">Meeting notes</h2>
            <span className="text-[10px] text-[hsl(0_0%_60%)] uppercase tracking-wider">AI clerk</span>
          </div>
          <button onClick={onClose} className="text-[hsl(0_0%_60%)] hover:text-white text-xs">Close</button>
        </header>

        <div className="max-h-[70vh] overflow-y-auto">
          {q.isLoading && (
            <div className="flex items-center gap-2 px-5 py-6 text-xs text-[hsl(0_0%_60%)]">
              <Loader2 className="w-3 h-3 animate-spin" /> Loading meeting notes…
            </div>
          )}
          {!q.isLoading && rows.length === 0 && (
            <div className="px-5 py-8 text-center text-xs text-[hsl(0_0%_60%)]">
              No meeting notes yet. Start the AI clerk during a call to take notes.
            </div>
          )}
          {rows.map(row => {
            const expanded = expandedId === row.id;
            const statusColor =
              row.status === "uploaded" ? "text-[hsl(140_60%_70%)] border-[hsl(140_60%_40%)]"
              : row.status === "failed" ? "text-[hsl(174_85%_72%)] border-[hsl(174_70%_45%)]"
              : "text-[hsl(40_85%_75%)] border-[hsl(40_85%_40%)]";
            const statusIcon =
              row.status === "uploaded" ? <CheckCircle2 className="w-3 h-3" />
              : row.status === "failed" ? <AlertTriangle className="w-3 h-3" />
              : <Loader2 className="w-3 h-3 animate-spin" />;
            return (
              <div
                key={row.id}
                className="border-b border-[hsl(220_40%_18%)] last:border-b-0"
                data-testid={`note-row-${row.id}`}
              >
                <div className="flex items-start group">
                  <button
                    type="button"
                    onClick={() => setExpandedId(expanded ? null : row.id)}
                    className="flex-1 text-left px-5 py-3 hover:bg-[hsl(220_50%_14%)]"
                  >
                    <div className="flex items-start gap-2">
                      {expanded ? <ChevronDown className="w-3.5 h-3.5 mt-0.5 text-[hsl(0_0%_55%)]" /> : <ChevronRight className="w-3.5 h-3.5 mt-0.5 text-[hsl(0_0%_55%)]" />}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-[hsl(0_0%_92%)] truncate">
                            {row.title || `Meeting notes #${row.id}`}
                          </span>
                          <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] uppercase tracking-wider ${statusColor}`}>
                            {statusIcon}{row.status}
                          </span>
                        </div>
                        <div className="mt-0.5 text-[11px] text-[hsl(0_0%_60%)] flex flex-wrap gap-x-3 gap-y-0.5">
                          <span>{fmtDate(row.startedAt)}</span>
                          <span>Duration: {fmtDuration(row.durationSeconds)}</span>
                          <span>{row.attendees?.length ?? 0} attendees</span>
                          {row.pdfSizeBytes ? <span>PDF: {fmtBytes(row.pdfSizeBytes)}</span> : null}
                        </div>
                      </div>
                    </div>
                  </button>
                  {pendingDeleteId === row.id ? (
                    <div className="flex items-center gap-1 px-3 py-3 shrink-0">
                      <button
                        type="button"
                        onClick={() => delMut.mutate(row.id)}
                        disabled={delMut.isPending}
                        className="text-[10px] px-2 py-1 rounded bg-vs-red text-white hover:bg-red-700 disabled:opacity-50"
                        data-testid={`confirm-delete-note-${row.id}`}
                      >
                        {delMut.isPending ? "Deleting…" : "Confirm"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setPendingDeleteId(null)}
                        className="text-[10px] px-2 py-1 rounded text-[hsl(0_0%_70%)] hover:text-white"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    // Phase 1.9.36 — always visible (was hover-only, which
                    // made delete invisible on touch). Faint by default,
                    // brightens on hover/tap.
                    <button
                      type="button"
                      onClick={() => setPendingDeleteId(row.id)}
                      className="p-3 text-[hsl(0_0%_45%)] hover:text-vs-red transition-colors shrink-0"
                      title="Delete this meeting note"
                      data-testid={`button-delete-note-${row.id}`}
                      aria-label="Delete"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                {expanded && (
                  <div className="px-10 pb-4 pt-1 text-xs text-[hsl(0_0%_80%)] space-y-2">
                    {row.synologyRemotePath && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-[hsl(0_0%_55%)] mb-0.5">Synology path</div>
                        <code className="text-[11px] text-[hsl(0_0%_85%)] break-all bg-[hsl(220_40%_8%)] px-1.5 py-0.5 rounded">
                          {row.synologyRemotePath}
                        </code>
                      </div>
                    )}
                    {row.status === "failed" && (row.errorMessage || row.synologyReason) && (
                      <div className="text-[hsl(174_85%_75%)]">
                        <div className="text-[10px] uppercase tracking-wider mb-0.5">Error</div>
                        <div className="text-[11px]">{row.errorMessage || row.synologyReason}</div>
                      </div>
                    )}
                    {row.status === "uploaded" && row.synologyStatus && row.synologyStatus !== "uploaded" && (
                      <div className="text-[hsl(40_85%_75%)]">
                        <div className="text-[10px] uppercase tracking-wider mb-0.5">NAS upload failed</div>
                        <div className="text-[11px]">Notes are ready — only the Synology upload didn't complete.{row.synologyReason ? ` (${row.synologyReason})` : ""}</div>
                      </div>
                    )}
                    {row.attendees && row.attendees.length > 0 && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-[hsl(0_0%_55%)] mb-0.5">Attendees</div>
                        <div className="text-[11px]">{row.attendees.map(a => a.name).join(", ")}</div>
                      </div>
                    )}
                    {row.summaryMarkdown && (
                      <div>
                        <div className="text-[10px] uppercase tracking-wider text-[hsl(0_0%_55%)] mb-0.5">Notes</div>
                        <pre className="whitespace-pre-wrap text-[11px] text-[hsl(0_0%_88%)] bg-[hsl(220_40%_8%)] p-3 rounded border border-[hsl(220_40%_18%)] max-h-[40vh] overflow-y-auto">
{row.summaryMarkdown}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
