import { useState } from "react";
import { useLocation, Link } from "wouter";
import { useAuth } from "@/lib/auth";
import { VectorLogo } from "@/components/VectorLogo";
import { Loader2, ArrowRight, ShieldCheck } from "lucide-react";

export default function Login() {
  const { login } = useAuth();
  const [, setLocation] = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(email.trim(), password);
      setLocation("/");
    } catch (err: any) {
      setError(err?.body?.message ?? "Invalid email or password.");
    } finally {
      setLoading(false);
    }
  };

  const fillDemo = (e: React.MouseEvent) => {
    e.preventDefault();
    setEmail("admin@vectorservicesus.com");
    setPassword("Vector2026!");
  };

  return (
    <AuthShell>
      <div className="text-center mb-7">
        <VectorLogo size={56} className="mx-auto text-vs-blue" monochrome />
        <h1 className="font-display text-2xl text-white mt-4 tracking-tight">Welcome back</h1>
        <p className="text-sm text-[hsl(0_0%_70%)] mt-1">Sign in to Bulldog Chat</p>
      </div>

      <form onSubmit={onSubmit} className="space-y-3.5" data-testid="form-login">
        <Field label="Work email">
          <input
            type="email"
            required
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@vectorservicesus.com"
            className={inputCls}
            data-testid="input-email"
          />
        </Field>
        <Field label="Password">
          <input
            type="password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            className={inputCls}
            data-testid="input-password"
          />
        </Field>

        {error && (
          <div className="text-[12.5px] rounded-md bg-[hsl(var(--vs-accent)/0.12)] border border-[hsl(var(--vs-accent)/0.4)] text-[hsl(var(--vs-accent))] px-3 py-2" data-testid="text-error">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading || !email || !password}
          className="w-full h-11 rounded-lg bg-vs-red hover:bg-[hsl(var(--vs-red-bright))] text-white font-semibold flex items-center justify-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          data-testid="button-submit-login"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <>Sign in <ArrowRight className="w-4 h-4" /></>}
        </button>
      </form>

      <button
        type="button"
        onClick={fillDemo}
        className="mt-4 w-full text-[11px] font-mono uppercase tracking-[0.18em] text-[hsl(0_0%_60%)] hover:text-vs-blue transition-colors flex items-center justify-center gap-2"
        data-testid="button-fill-demo"
      >
        <ShieldCheck className="w-3 h-3" /> Use demo credentials
      </button>

      <div className="mt-7 pt-5 border-t border-[hsl(220_40%_25%)] text-center text-[12.5px] text-[hsl(0_0%_65%)]">
        New to Bulldog Chat?{" "}
        <Link href="/signup" className="text-vs-blue hover:underline font-medium" data-testid="link-signup">
          Create an organization
        </Link>
      </div>
    </AuthShell>
  );
}

// ─────────── shared shell ───────────
export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen w-full flex">
      {/* Left hero — desktop only */}
      <div className="hidden lg:flex flex-1 vs-navy relative overflow-hidden flex-col justify-between p-12">
        <div className="absolute inset-0 vs-grain opacity-30" />
        <div className="relative z-10">
          <VectorLogo size={44} className="text-white" monochrome />
          <div className="mt-2 font-display text-white text-sm tracking-[0.18em] uppercase">Bulldog Chat</div>
        </div>
        <div className="relative z-10 max-w-md">
          <div className="text-[11px] font-mono uppercase tracking-[0.22em] text-vs-red mb-3">
            Rooted in Service · Driven by Discipline
          </div>
          <h2 className="font-display text-white text-3xl leading-tight tracking-tight">
            Field crews talk.<br/>
            Office hears.<br/>
            <span className="text-vs-blue-light">Work moves.</span>
          </h2>
          <p className="mt-5 text-[hsl(0_0%_75%)] text-sm leading-relaxed">
            Project-scoped sitrep and net channels for utility construction. Built for substations,
            fiber crews, pole replacements, and the office that backs them up.
          </p>
        </div>
        <div className="relative z-10 text-[10px] font-mono uppercase tracking-[0.18em] text-[hsl(0_0%_55%)]">
          Service-Disabled Veteran-Owned · Pacific Northwest
        </div>
      </div>

      {/* Right form panel */}
      <div className="flex-1 lg:max-w-[480px] flex items-center justify-center p-6 bg-[hsl(220_60%_9%)]">
        <div className="w-full max-w-sm">{children}</div>
      </div>
    </div>
  );
}

export const inputCls =
  "w-full h-10 px-3 rounded-md bg-[hsl(220_50%_14%)] border border-[hsl(220_40%_25%)] text-sm text-white placeholder:text-[hsl(0_0%_45%)] focus:outline-none focus:border-vs-red focus:ring-2 focus:ring-vs-red/30 transition-colors";

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-[11px] uppercase tracking-[0.14em] font-bold text-[hsl(0_0%_65%)] mb-1">{label}</div>
      {children}
    </label>
  );
}
