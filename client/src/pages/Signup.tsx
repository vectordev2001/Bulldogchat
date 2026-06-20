import { useState } from "react";
import { useLocation, Link } from "wouter";
import { useAuth } from "@/lib/auth";
import { AuthShell, Field, inputCls } from "./Login";
import { Loader2, ArrowRight } from "lucide-react";
import { VectorLogo } from "@/components/VectorLogo";

export default function Signup() {
  const { signup } = useAuth();
  const [, setLocation] = useLocation();
  const [orgName, setOrgName] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await signup(orgName.trim(), name.trim(), email.trim(), password);
      setLocation("/");
    } catch (err: any) {
      setError(err?.body?.message ?? "Could not create account.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthShell>
      <div className="text-center mb-7">
        <VectorLogo size={56} className="mx-auto text-vs-blue" monochrome />
        <h1 className="font-display text-2xl text-white mt-4 tracking-tight">Start a new workspace</h1>
        <p className="text-sm text-[hsl(0_0%_70%)] mt-1">Spin up a Bulldog Chat org in seconds</p>
      </div>

      <form onSubmit={onSubmit} className="space-y-3.5" data-testid="form-signup">
        <Field label="Company / Organization">
          <input required value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="Vector Services" className={inputCls} data-testid="input-org" />
        </Field>
        <Field label="Your name">
          <input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Jordan Bieler" className={inputCls} data-testid="input-name" />
        </Field>
        <Field label="Work email">
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@company.com" className={inputCls} data-testid="input-email" />
        </Field>
        <Field label="Password (8+ characters)">
          <input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" className={inputCls} data-testid="input-password" />
        </Field>

        {error && (
          <div className="text-[12.5px] rounded-md bg-[hsl(174_70%_55%/0.12)] border border-[hsl(174_70%_55%/0.4)] text-[hsl(174_85%_72%)] px-3 py-2" data-testid="text-error">
            {error}
          </div>
        )}

        <button
          type="submit"
          disabled={loading}
          className="w-full h-11 rounded-lg bg-vs-red hover:bg-[hsl(174_75%_60%)] text-white font-semibold flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
          data-testid="button-submit-signup"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <>Create workspace <ArrowRight className="w-4 h-4" /></>}
        </button>
      </form>

      <div className="mt-7 pt-5 border-t border-[hsl(220_40%_25%)] text-center text-[12.5px] text-[hsl(0_0%_65%)]">
        Already have an account?{" "}
        <Link href="/login" className="text-vs-blue hover:underline font-medium" data-testid="link-login">Sign in</Link>
      </div>
    </AuthShell>
  );
}
