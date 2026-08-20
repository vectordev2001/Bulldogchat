/**
 * <FeedbackDialog /> — shared "send feedback / help ticket / suggestion" form.
 *
 * Vendored (not npm) into each Bulldog Suite app so it looks and feels native
 * to that app's design system. POSTs to bulldog-auth's shared endpoint:
 *
 *   POST https://auth.bulldogops.com/api/feedback
 *   multipart/form-data:
 *     type         "bug" | "suggestion" | "question"
 *     summary      required, <=200 chars
 *     description  optional, <=10000 chars
 *     appName      required (e.g. "contracts", "ops", "chat")
 *     pageUrl      auto-captured from window.location
 *     screenshot   optional image file
 *
 * The submitter never sees where it's routed — the response is opaque on
 * purpose. Just shows "Sent, thanks."
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useToast } from "@/hooks/use-toast";
import { Bug, Lightbulb, HelpCircle, Paperclip, X as XIcon, Loader2 } from "lucide-react";

export type FeedbackType = "bug" | "suggestion" | "question";

export interface FeedbackDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** App slug the server records against the ticket. */
  appName: "contracts" | "ops" | "chat" | "auth" | string;
  /** Optional override — defaults to https://auth.bulldogops.com. */
  apiBase?: string;
  /** Optional initial type. Defaults to "suggestion". */
  initialType?: FeedbackType;
}

const TYPE_OPTIONS: Array<{
  value: FeedbackType;
  label: string;
  description: string;
  Icon: typeof Bug;
}> = [
  { value: "bug", label: "Bug", description: "Something isn't working right.", Icon: Bug },
  { value: "suggestion", label: "Suggestion", description: "An idea for making this better.", Icon: Lightbulb },
  { value: "question", label: "Question", description: "Not sure how something works.", Icon: HelpCircle },
];

const MAX_SUMMARY = 200;
const MAX_DESCRIPTION = 10_000;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ACCEPTED_MIME = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/heic"];

export function FeedbackDialog({
  open,
  onOpenChange,
  appName,
  apiBase = "https://auth.bulldogops.com",
  initialType = "suggestion",
}: FeedbackDialogProps) {
  const [type, setType] = useState<FeedbackType>(initialType);
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const { toast } = useToast();

  // Reset when the dialog closes so the next open is clean.
  useEffect(() => {
    if (!open) {
      setType(initialType);
      setSummary("");
      setDescription("");
      setFile(null);
      setPreview(null);
      setSubmitting(false);
      setError(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }, [open, initialType]);

  // Object-URL lifecycle for the preview thumbnail.
  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const onPickFile = useCallback((f: File | undefined | null) => {
    if (!f) return;
    if (!ACCEPTED_MIME.includes(f.type.toLowerCase())) {
      setError("Screenshot must be a PNG, JPEG, GIF, WebP, or HEIC image.");
      return;
    }
    if (f.size > MAX_FILE_BYTES) {
      setError("Screenshot is larger than 10 MB.");
      return;
    }
    setError(null);
    setFile(f);
  }, []);

  const removeFile = useCallback(() => {
    setFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, []);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = summary.trim();
      if (!trimmed) {
        setError("Please add a short summary.");
        return;
      }
      setError(null);
      setSubmitting(true);
      try {
        const form = new FormData();
        form.set("type", type);
        form.set("summary", trimmed.slice(0, MAX_SUMMARY));
        form.set("description", description.trim().slice(0, MAX_DESCRIPTION));
        form.set("appName", appName);
        form.set("pageUrl", typeof window !== "undefined" ? window.location.href : "");
        if (file) form.set("screenshot", file, file.name);
        const res = await fetch(`${apiBase}/api/feedback`, {
          method: "POST",
          credentials: "include",
          body: form,
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(payload?.message || `Send failed (HTTP ${res.status}).`);
        }
        toast({
          title:
            type === "bug"
              ? "Report received"
              : type === "question"
                ? "Question received"
                : "Suggestion received",
          description: "Thanks for the feedback. We read every one of these.",
        });
        onOpenChange(false);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Something went wrong.";
        setError(msg);
      } finally {
        setSubmitting(false);
      }
    },
    [apiBase, appName, description, file, onOpenChange, summary, toast, type],
  );

  const summaryLeft = MAX_SUMMARY - summary.length;
  const descriptionLeft = MAX_DESCRIPTION - description.length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Send feedback</DialogTitle>
          <DialogDescription>
            Report a bug, share an idea, or ask a question. Screenshots help.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label>Type</Label>
            <RadioGroup
              value={type}
              onValueChange={(v) => setType(v as FeedbackType)}
              className="grid grid-cols-3 gap-2"
            >
              {TYPE_OPTIONS.map(({ value, label, description: desc, Icon }) => {
                const active = type === value;
                return (
                  <label
                    key={value}
                    htmlFor={`fb-type-${value}`}
                    className={[
                      "flex cursor-pointer flex-col items-start gap-1 rounded-md border p-3 text-left transition",
                      active
                        ? "border-primary bg-primary/5"
                        : "border-input hover:bg-muted/50",
                    ].join(" ")}
                    data-testid={`radio-feedback-type-${value}`}
                  >
                    <div className="flex items-center gap-2">
                      <RadioGroupItem id={`fb-type-${value}`} value={value} />
                      <Icon className="h-4 w-4" aria-hidden />
                      <span className="text-sm font-medium">{label}</span>
                    </div>
                    <span className="text-xs text-muted-foreground">{desc}</span>
                  </label>
                );
              })}
            </RadioGroup>
          </div>

          <div className="space-y-1">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="fb-summary">Summary</Label>
              <span
                className={[
                  "text-xs",
                  summaryLeft < 20 ? "text-destructive" : "text-muted-foreground",
                ].join(" ")}
              >
                {summaryLeft}
              </span>
            </div>
            <Input
              id="fb-summary"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
              maxLength={MAX_SUMMARY}
              placeholder="Short title for what happened"
              required
              data-testid="input-feedback-summary"
              autoFocus
            />
          </div>

          <div className="space-y-1">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="fb-description">Details</Label>
              <span className="text-xs text-muted-foreground">
                {descriptionLeft > 0 ? `${MAX_DESCRIPTION - descriptionLeft}/${MAX_DESCRIPTION}` : "max reached"}
              </span>
            </div>
            <Textarea
              id="fb-description"
              value={description}
              onChange={(e) => setDescription(e.target.value.slice(0, MAX_DESCRIPTION))}
              rows={5}
              placeholder="What did you expect? What actually happened? Steps to reproduce, if any."
              data-testid="input-feedback-description"
            />
          </div>

          <div className="space-y-1">
            <Label>Screenshot (optional)</Label>
            {file ? (
              <div className="flex items-center gap-3 rounded-md border p-2">
                {preview ? (
                  <img
                    src={preview}
                    alt="Screenshot preview"
                    className="h-14 w-14 rounded object-cover"
                  />
                ) : (
                  <div className="flex h-14 w-14 items-center justify-center rounded bg-muted text-muted-foreground">
                    <Paperclip className="h-5 w-5" />
                  </div>
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm">{file.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {(file.size / 1024).toFixed(0)} KB
                  </div>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={removeFile}
                  aria-label="Remove screenshot"
                  data-testid="button-feedback-remove-file"
                >
                  <XIcon className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <label
                htmlFor="fb-screenshot"
                className="flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed p-3 text-sm text-muted-foreground hover:bg-muted/50"
                data-testid="button-feedback-attach"
              >
                <Paperclip className="h-4 w-4" />
                Attach a screenshot
              </label>
            )}
            <input
              ref={fileInputRef}
              id="fb-screenshot"
              type="file"
              accept={ACCEPTED_MIME.join(",")}
              className="hidden"
              onChange={(e) => onPickFile(e.target.files?.[0])}
            />
          </div>

          {error ? (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm text-destructive"
              data-testid="text-feedback-error"
            >
              {error}
            </div>
          ) : null}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={submitting || summary.trim().length === 0}
              data-testid="button-feedback-submit"
            >
              {submitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Sending
                </>
              ) : (
                "Send"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
