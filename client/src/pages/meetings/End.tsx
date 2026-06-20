import { useRoute } from "wouter";
import { PlayCircle, UserPlus, CalendarPlus, Sparkles, Clock, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BulldogWordmark } from "@/components/BulldogLogo";
import { ThemeToggle } from "@/components/MeetingThemeToggle";
import { useMeeting } from "@/lib/meeting";

export default function End() {
  const [, params] = useRoute("/end/:code");
  const code = (params?.code ?? "").split("?")[0];
  const { lastDuration, participantCount, title } = useMeeting();
  const dur = lastDuration;
  const peopleCount = Math.max(1, participantCount);
  const meetingTitle = title || "Meeting";
  const fmtDur = (s: number) => {
    const mm = Math.floor(s / 60);
    const ss = s % 60;
    if (mm < 1) return `${ss} sec`;
    return `${mm} min ${ss} sec`;
  };

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="flex items-center justify-between px-5 py-4 sm:px-8">
        <BulldogWordmark />
        <ThemeToggle />
      </header>

      <main className="mx-auto flex w-full max-w-lg flex-1 flex-col justify-center px-5 pb-16">
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-accent text-primary">
            <Sparkles size={22} />
          </div>
          <h1 className="font-display text-xl font-bold tracking-tight" data-testid="text-thanks">
            Thanks for joining
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {meetingTitle} · <span className="font-mono">{code}</span>
          </p>
        </div>

        <div className="mt-7 rounded-2xl border border-card-border bg-card p-6 shadow-sm">
          <div className="grid grid-cols-2 gap-4">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                <Clock size={18} className="text-primary" />
              </span>
              <div>
                <div className="text-xs text-muted-foreground">Duration</div>
                <div className="font-display text-base font-semibold" data-testid="text-duration">
                  {fmtDur(dur)}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted">
                <Users size={18} className="text-primary" />
              </span>
              <div>
                <div className="text-xs text-muted-foreground">Participants</div>
                <div className="font-display text-base font-semibold" data-testid="text-participants">
                  {peopleCount} {peopleCount === 1 ? "person" : "people"}
                </div>
              </div>
            </div>
          </div>

          <div className="mt-5 flex items-start gap-2.5 rounded-lg bg-accent/60 px-3 py-3 text-sm text-accent-foreground">
            <Sparkles size={16} className="mt-0.5 shrink-0 text-primary" />
            <span>If enabled, an AI summary is emailed to recipients shortly after the meeting ends.</span>
          </div>
        </div>

        <div className="mt-6 space-y-3">
          <Button data-testid="button-view-recording" variant="outline" className="h-12 w-full justify-start gap-3 text-base">
            <PlayCircle size={18} /> View recording
          </Button>
          <Button data-testid="button-create-account" className="h-12 w-full justify-start gap-3 text-base font-semibold">
            <UserPlus size={18} /> Create a Bulldog account to save this transcript
          </Button>
          <Button data-testid="button-schedule" variant="outline" className="h-12 w-full justify-start gap-3 text-base">
            <CalendarPlus size={18} /> Schedule a follow-up meeting
          </Button>
        </div>

        <a
          href="https://chat.bulldogops.com/"
          data-testid="link-home"
          className="mt-6 block text-center text-sm font-medium text-muted-foreground hover:text-foreground"
        >
          Back to Bulldog Chat
        </a>
      </main>
    </div>
  );
}
