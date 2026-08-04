// Sparkle icon that lives in the top header next to the notifications bell.
// Clicking opens a dialog listing the last 10 merged PRs. Shows a small dot
// when the newest patch note is newer than the user's last-seen timestamp
// (stored in localStorage).

import { useEffect, useMemo, useState } from "react";
import { Sparkles } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  PatchNotesList,
  getNewestMergedAt,
  usePatchNotesGeneratedAt,
} from "@/components/PatchNotesList";

// localStorage key. Namespaced under `bulldog:` so it doesn't collide with
// other apps that share the auth subdomain.
const LAST_SEEN_KEY = "bulldog:chat:patchNotesLastSeen";

// Read the last-seen timestamp lazily so SSR / hydration tests don't touch
// localStorage before it exists. The hook returns [lastSeen, markSeen].
function useLastSeen(): [string | null, () => void] {
  const [lastSeen, setLastSeen] = useState<string | null>(null);
  useEffect(() => {
    try {
      setLastSeen(window.localStorage.getItem(LAST_SEEN_KEY));
    } catch {
      // localStorage can throw in privacy mode / when quota exceeded. Ignore
      // and treat as "never seen" — worst case the dot just always shows.
    }
  }, []);
  const markSeen = () => {
    const now = new Date().toISOString();
    try {
      window.localStorage.setItem(LAST_SEEN_KEY, now);
    } catch {
      // Same as above — non-fatal.
    }
    setLastSeen(now);
  };
  return [lastSeen, markSeen];
}

export function PatchNotesTrigger() {
  const [open, setOpen] = useState(false);
  const [lastSeen, markSeen] = useLastSeen();
  const generatedAt = usePatchNotesGeneratedAt();

  // Compute unseen status once per render. If we've never seen the notes at
  // all, everything is unseen; otherwise compare timestamps.
  const hasUnseen = useMemo(() => {
    const newest = getNewestMergedAt();
    if (!newest) return false;
    if (!lastSeen) return true;
    return new Date(newest).getTime() > new Date(lastSeen).getTime();
  }, [lastSeen]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Mark seen on OPEN, not close, so the dot disappears the instant the
        // user acknowledges the update. Closing without opening wouldn't count.
        if (next) markSeen();
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="What's new"
          className="relative h-9 w-9"
          data-testid="button-patch-notes-open"
        >
          <Sparkles className="h-5 w-5 text-slate-600" aria-hidden />
          {hasUnseen ? (
            <span
              // Small dot, positioned like the notifications-bell unread
              // indicator so the two feel like siblings in the header.
              className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-[#0090F0] ring-2 ring-white"
              aria-hidden
            />
          ) : null}
          <span className="sr-only">Open patch notes</span>
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-[#0090F0]" aria-hidden />
            What's new in Bulldog Chat
          </DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto pr-1">
          <PatchNotesList />
        </div>
        <DialogFooter className="flex items-center justify-between gap-2 sm:justify-between">
          {generatedAt ? (
            <span className="text-[11px] text-slate-400">
              Updated {new Date(generatedAt).toLocaleDateString()}
            </span>
          ) : (
            <span />
          )}
          <Link href="/whats-new" onClick={() => setOpen(false)}>
            <Button variant="outline" size="sm">
              See all updates
            </Button>
          </Link>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
