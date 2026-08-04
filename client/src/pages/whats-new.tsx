// Full-page /whats-new archive of recent Bulldog Contracts updates. Uses the
// same PatchNotesList component that the header sparkle modal renders so the
// two surfaces never disagree.

import { Sparkles } from "lucide-react";
import {
  PatchNotesList,
  usePatchNotesGeneratedAt,
} from "@/components/PatchNotesList";

export default function WhatsNewPage() {
  const generatedAt = usePatchNotesGeneratedAt();
  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
      <header className="mb-6 flex items-start gap-3">
        <div className="rounded-lg bg-[#0090F0]/10 p-2">
          <Sparkles className="h-6 w-6 text-[#0090F0]" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-semibold text-slate-900">
            What's new in Bulldog Chat
          </h1>
          <p className="mt-1 text-sm text-slate-500">
            The latest 10 updates that shipped to production. Each entry links
            to the pull request on GitHub if you want the full diff.
          </p>
          {generatedAt ? (
            <p className="mt-2 text-[11px] text-slate-400">
              List refreshed {new Date(generatedAt).toLocaleString()}.
            </p>
          ) : null}
        </div>
      </header>
      <section className="rounded-xl border border-slate-200 bg-white p-4 sm:p-6">
        <PatchNotesList />
      </section>
    </div>
  );
}
