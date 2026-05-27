import { useEffect, useState } from "react";
import { useLocation, useParams } from "wouter";
import { useAuth } from "@/lib/auth";
import { AuthShell, Field, inputCls } from "./Login";
import { apiRequest } from "@/lib/queryClient";
import { Loader2, ArrowRight } from "lucide-react";
import { VectorLogo } from "@/components/VectorLogo";

interface InvitePayload { orgName: string; role: string; inviterName: string }

export default function AcceptInvite() {
  const params = useParams<{ token: string }>();
  const token = params.token ?? "";
  const { acceptInvite } = useAuth();
  const [, setLocation] = useLocation();
  const [info, setInfo] = useState<InvitePayload | null>(null);
  const [loadingInfo, setLoadingInfo] = useState(true);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await apiRequest<InvitePayload>("GET", `/api/invites/${encodeURIComponent(token)}`);
        if (!cancelled) setInfo(r);
      } catch (e: any) {
        if (!cancelled) setInfoError(e?.body?.message ?? "Invite is invalid or expired.");
      } finally {
        if (!cancelled) setLoadingInfo(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await acceptInvite(token, name.trim(), password);
      setLocation("/");
    } catch (err: any) {
      setError(err?.body?.message ?? "Could not accept invite.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthShell>
      <div className="text-center mb-7">
        <VectorLogo size={56} className="mx-auto text-vs-blue" monochrome />
        <h1 className="font-display text-2xl text-white mt-4 tracking-tight">Join {info?.orgName ?? "the team"}</h1>
        <p className="text-sm text-[hsl(0_0%_70%)] mt-1">
          {info ? `${info.inviterName} invited you as ${info.role}.` : "Setting up your invite…"}
        </p>
      </div>

      {loadingInfo && (
        <div className="text-center text-sm text-[hsl(0_0%_60%)] py-8" data-testid="status-loading">
          <Loader2 className="w-5 h-5 animate-spin mx-auto" />
        </div>
      )}

      {infoError && (
        <div className="text-sm rounded-md bg-[hsl(2_70%_55%/0.12)] border border-[hsl(2_70%_55%/0.4)] text-[hsl(2_85%_72%)] px-4 py-3" data-testid="text-info-error">
          {infoError}
        </div>
      )}

      {info && (
        <form onSubmit={onSubmit} className="space-y-3.5" data-testid="form-accept-invite">
          <Field label="Your name">
            <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="First Last" className={inputCls} data-testid="input-name" />
          </Field>
          <Field label="Password (8+ characters)">
            <input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" className={inputCls} data-testid="input-password" />
          </Field>

          {error && (
            <div className="text-[12.5px] rounded-md bg-[hsl(2_70%_55%/0.12)] border border-[hsl(2_70%_55%/0.4)] text-[hsl(2_85%_72%)] px-3 py-2" data-testid="text-error">{error}</div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full h-11 rounded-lg bg-vs-red hover:bg-[hsl(2_75%_60%)] text-white font-semibold flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
            data-testid="button-submit-invite"
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <>Accept invite <ArrowRight className="w-4 h-4" /></>}
          </button>
        </form>
      )}
    </AuthShell>
  );
}
