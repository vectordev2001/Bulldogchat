import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { apiRequest } from "@/lib/queryClient";
import { FileText, Loader2, ExternalLink, AlertCircle } from "lucide-react";
import type { ApiChannel } from "@/types/api";

interface Props {
  open: boolean;
  onClose: () => void;
  messageId: number;
  messageText: string;
  channel: ApiChannel;
}

interface PromoteResp {
  ok: true;
  coId: number;
  coNumber: string;
  deepLink: string;
  existing: boolean;
  contractId: number;
  contractTitle: string;
}

/**
 * Promote-to-Change-Order dialog. Long-pressing a message and picking
 * "Promote to Change Order" opens this. The user can adjust the CO title
 * and description before submitting. On success we deep-link them into
 * Contracts and drop a system card in the source channel.
 *
 * Idempotent on the server \u2014 posting twice returns the same CO with
 * existing=true, so re-opens are safe.
 */
export function PromoteToChangeOrderDialog({ open, onClose, messageId, messageText, channel }: Props) {
  const suggestedTitle = messageText.trim().split(/\r?\n/)[0]?.slice(0, 120) || "";
  const [title, setTitle] = useState(suggestedTitle);
  const [description, setDescription] = useState(messageText);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<PromoteResp | null>(null);

  const contractsBase = ((import.meta as any).env?.VITE_CONTRACTS_APP_URL as string | undefined)
    || "https://vectorcontracts.bulldogops.com";

  const linkedContract = channel.linkedContract ?? null;

  async function handleSubmit() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const resp = await apiRequest<PromoteResp>(
        "POST",
        `/api/messages/${messageId}/promote-to-change-order`,
        {
          title: title.trim() || undefined,
          description: description.trim() || undefined,
          quotedText: messageText,
        },
      );
      setDone(resp);
    } catch (err) {
      setError((err as Error).message || "Failed to promote to Change Order");
    } finally {
      setSubmitting(false);
    }
  }

  function handleClose() {
    if (submitting) return;
    setTitle(suggestedTitle);
    setDescription(messageText);
    setError(null);
    setDone(null);
    onClose();
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-vs-blue-light" />
            Promote to Change Order
          </DialogTitle>
          <DialogDescription>
            {linkedContract ? (
              <>Creates a draft change order on <span className="font-mono text-[hsl(var(--vs-text))]">{linkedContract.title || "the linked contract"}</span>.</>
            ) : (
              <>This channel isn't linked to a contract. Attach one from the channel header to enable Promote to Change Order.</>
            )}
          </DialogDescription>
        </DialogHeader>

        {!linkedContract ? (
          <div className="text-sm text-[hsl(var(--vs-text-muted))] rounded-md border border-border p-3 bg-secondary">
            No contract linked to this channel.
          </div>
        ) : done ? (
          <div className="space-y-3">
            <div className="rounded-md border border-[hsl(var(--vs-info)/0.4)] bg-[hsl(var(--vs-info)/0.08)] p-3">
              <div className="text-sm font-semibold text-[hsl(var(--vs-text))]">
                {done.existing ? "This message already has a change order" : "Change order created"}
              </div>
              <div className="text-xs text-[hsl(var(--vs-text-muted))] mt-1">
                <span className="font-mono">{done.coNumber}</span> on {done.contractTitle}
              </div>
            </div>
            <a
              href={`${contractsBase}${done.deepLink}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 px-3 py-2 rounded-md bg-vs-blue-light/20 text-vs-blue-light border border-vs-blue-light/40 hover:bg-vs-blue-light/30 text-sm"
              data-testid="link-open-co"
            >
              <ExternalLink className="w-4 h-4" />
              Open in Contracts
            </a>
            <div className="flex justify-end">
              <button
                type="button"
                onClick={handleClose}
                className="px-3 py-1.5 rounded-md text-sm bg-secondary border border-border hover:border-[hsl(var(--vs-accent))] text-[hsl(var(--vs-text))]"
                data-testid="button-close-promoted"
              >
                Close
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <label className="text-xs font-mono uppercase tracking-wider text-[hsl(var(--vs-text-muted))] block mb-1">Title</label>
              <input
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Short summary of the change"
                maxLength={200}
                className="w-full px-3 py-2 rounded-md bg-secondary border border-border text-sm text-[hsl(var(--vs-text))] focus:outline-none focus:border-[hsl(var(--vs-accent))]"
                data-testid="input-co-title"
              />
            </div>
            <div>
              <label className="text-xs font-mono uppercase tracking-wider text-[hsl(var(--vs-text-muted))] block mb-1">Description</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={5}
                maxLength={20000}
                className="w-full px-3 py-2 rounded-md bg-secondary border border-border text-sm text-[hsl(var(--vs-text))] focus:outline-none focus:border-[hsl(var(--vs-accent))] resize-y"
                data-testid="input-co-description"
              />
              <div className="text-[10px] text-[hsl(var(--vs-text-subtle))] mt-1">
                The original message text is quoted on the change order for context.
              </div>
            </div>

            {error && (
              <div className="rounded-md border border-vs-red/40 bg-vs-red/10 px-3 py-2 text-xs text-vs-red flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{error}</span>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={handleClose}
                disabled={submitting}
                className="px-3 py-1.5 rounded-md text-sm bg-secondary border border-border hover:border-[hsl(var(--vs-accent))] text-[hsl(var(--vs-text))] disabled:opacity-40"
                data-testid="button-cancel-promote"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting}
                className="px-3 py-1.5 rounded-md text-sm bg-vs-blue-light/20 text-vs-blue-light border border-vs-blue-light/40 hover:bg-vs-blue-light/30 disabled:opacity-40 flex items-center gap-2"
                data-testid="button-submit-promote"
              >
                {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
                {submitting ? "Creating\u2026" : "Create Change Order"}
              </button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
