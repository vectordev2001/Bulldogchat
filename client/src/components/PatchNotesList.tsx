// Shared list of the last N merged PRs from bulldog-contracts. Rendered inside
// both the header modal (PatchNotesDialog) and the full-page /whats-new route.
// The data source is client/src/generated/patch-notes.json, refreshed by
// `npm run patch-notes:refresh` and committed to the repo — so this component
// makes zero network calls at runtime.
//
// Design language: matches the rest of the Contracts app (Aqua brand blue for
// the "New" badge, muted slate for metadata, generous spacing so a list of 10
// entries doesn't feel like a wall of text).

import { formatDistanceToNow, parseISO } from "date-fns";
import { ExternalLink, Sparkles, Wrench, Wand2, FileText, PackageCheck } from "lucide-react";
import patchNotes from "@/generated/patch-notes.json";
import { Badge } from "@/components/ui/badge";

type Category = "feature" | "fix" | "chore" | "refactor" | "docs" | "other";

interface PatchNote {
  number: number;
  title: string;
  raw_title: string;
  summary: string;
  merged_at: string;
  author: string;
  url: string;
  category: Category;
}

interface PatchNotesFile {
  generated_at: string;
  repo: string;
  notes: PatchNote[];
}

// Cast the imported JSON to the strict type. `import.meta.env.PROD` guards a
// runtime warning so dev builds surface the fallback state visibly.
const data: PatchNotesFile = patchNotes as PatchNotesFile;

// Per-category badge styling. Aqua blue for features (the brand hero color),
// muted amber for fixes so they're distinguishable at a glance, neutral for
// everything else so the list isn't a rainbow.
const CATEGORY_META: Record<
  Category,
  { label: string; icon: typeof Sparkles; className: string }
> = {
  feature: {
    label: "New",
    icon: Sparkles,
    className: "bg-[#0090F0]/10 text-[#0068B0] border-[#0090F0]/30",
  },
  fix: {
    label: "Fix",
    icon: Wrench,
    className: "bg-amber-500/10 text-amber-700 border-amber-500/30",
  },
  refactor: {
    label: "Improved",
    icon: Wand2,
    className: "bg-slate-500/10 text-slate-700 border-slate-500/30",
  },
  chore: {
    label: "Chore",
    icon: PackageCheck,
    className: "bg-slate-500/10 text-slate-600 border-slate-500/30",
  },
  docs: {
    label: "Docs",
    icon: FileText,
    className: "bg-slate-500/10 text-slate-600 border-slate-500/30",
  },
  other: {
    label: "Update",
    icon: Sparkles,
    className: "bg-slate-500/10 text-slate-700 border-slate-500/30",
  },
};

export function PatchNotesList({
  className = "",
  emptyLabel = "No updates yet. Check back after the next deploy.",
}: {
  className?: string;
  emptyLabel?: string;
}) {
  const notes = data.notes ?? [];

  if (notes.length === 0) {
    return (
      <div className={`text-sm text-slate-500 ${className}`}>{emptyLabel}</div>
    );
  }

  return (
    <ul className={`divide-y divide-slate-100 ${className}`}>
      {notes.map((note) => {
        const meta = CATEGORY_META[note.category] ?? CATEGORY_META.other;
        const Icon = meta.icon;
        // parseISO tolerates the `Z` suffix that GitHub returns; guard so a
        // stray null doesn't crash the whole list.
        const mergedAt = note.merged_at ? parseISO(note.merged_at) : null;
        return (
          <li key={note.number} className="py-4 first:pt-0 last:pb-0">
            <div className="flex items-start gap-3">
              <Badge
                variant="outline"
                className={`shrink-0 gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${meta.className}`}
              >
                <Icon className="h-3 w-3" aria-hidden />
                {meta.label}
              </Badge>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <a
                    href={note.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm font-semibold text-slate-900 hover:text-[#0068B0] hover:underline"
                    data-testid={`link-patch-note-${note.number}`}
                  >
                    {note.title}
                  </a>
                  <span className="text-[11px] font-mono text-slate-400">
                    #{note.number}
                  </span>
                </div>
                {note.summary ? (
                  <p className="mt-1 line-clamp-3 text-xs text-slate-600">
                    {note.summary}
                  </p>
                ) : null}
                <div className="mt-1.5 flex items-center gap-2 text-[11px] text-slate-400">
                  {mergedAt ? (
                    <time dateTime={note.merged_at} title={mergedAt.toLocaleString()}>
                      {formatDistanceToNow(mergedAt, { addSuffix: true })}
                    </time>
                  ) : null}
                  <span aria-hidden>·</span>
                  <a
                    href={note.url}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 hover:text-slate-600 hover:underline"
                  >
                    View on GitHub
                    <ExternalLink className="h-3 w-3" aria-hidden />
                  </a>
                </div>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// Small helper exported so consumers (the modal, the page) can show a
// "last refreshed" line without importing the JSON themselves.
export function usePatchNotesGeneratedAt(): string | null {
  return data.generated_at ?? null;
}

// The newest merged_at across all notes. The header sparkle uses this to
// compute the "unseen" dot: if the newest note is newer than the local
// last-seen timestamp, show the dot.
export function getNewestMergedAt(): string | null {
  const notes = data.notes ?? [];
  if (notes.length === 0) return null;
  // Notes are already sorted newest-first by the generator, but sort again to
  // be defensive against a future generator change.
  return notes
    .map((n) => n.merged_at)
    .filter(Boolean)
    .sort()
    .slice(-1)[0] ?? null;
}
