// Phase 1.9.3 — banner pinned at the top of a channel that has a contract
// linked to it. Shows the title, ref, and quick-action buttons:
//   • Open contract  → window.open(appUrl) into bulldog-contracts
//   • View PDF       → opens pdfUrl in a new tab (in-call panel covers the
//                      richer experience; this is the in-channel quick view)
//
// Admin/foreman can also detach the contract via the X button. Detach
// posts an empty body to POST /api/channels/:id/linked-contract.

import { useState } from "react";
import { ExternalLink, FileText, X, Loader2 } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { ActionPill } from "@/components/ui/action-pill";
import type { ApiChannel, ApiLinkedContract, ApiUser } from "@/types/api";

interface Props {
  channel: ApiChannel;
  contract: ApiLinkedContract;
  me: ApiUser | null;
}

export function ContractBanner({ channel, contract, me }: Props) {
  const [detaching, setDetaching] = useState(false);
  const canDetach = me?.role === "admin" || me?.role === "foreman";

  const onDetach = async () => {
    if (!confirm(`Detach "${contract.title}" from this channel?`)) return;
    setDetaching(true);
    try {
      await apiRequest("POST", `/api/channels/${channel.id}/linked-contract`, {});
      await queryClient.invalidateQueries({ queryKey: ["/api/projects", channel.projectId, "channels"] });
    } catch (e) {
      // Surface so Josh sees why it didn't go through.
      alert("Could not detach contract: " + ((e as any)?.body?.message ?? (e as Error).message));
    } finally {
      setDetaching(false);
    }
  };

  return (
    <div
      className="flex items-center gap-2 border-b border-[hsl(232_40%_22%)] bg-[hsl(232_50%_15%)] px-4 py-1.5 text-xs shrink-0"
      data-testid="contract-banner"
    >
      <FileText className="h-3.5 w-3.5 text-vs-blue-light shrink-0" />
      <div className="flex min-w-0 items-center gap-2">
        <span className="font-medium text-white truncate" data-testid="contract-banner-title">
          {contract.title}
        </span>
        {contract.ref && (
          <span className="rounded bg-[hsl(232_40%_25%)] px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-[hsl(0_0%_75%)]">
            {contract.ref}
          </span>
        )}
      </div>
      <div className="ml-auto flex items-center gap-1.5">
        {contract.pdfUrl && (
          <ActionPill asChild variant="primary">
            <a
              href={contract.pdfUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="contract-banner-pdf"
            >
              <FileText /> View PDF
            </a>
          </ActionPill>
        )}
        <ActionPill asChild variant="primary">
          <a
            href={contract.appUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="contract-banner-open"
          >
            Open <ExternalLink />
          </a>
        </ActionPill>
        {canDetach && (
          <ActionPill
            variant="neutral"
            onClick={onDetach}
            disabled={detaching}
            title="Detach contract"
            data-testid="contract-banner-detach"
          >
            {detaching ? <Loader2 className="animate-spin" /> : <X />}
          </ActionPill>
        )}
      </div>
    </div>
  );
}
