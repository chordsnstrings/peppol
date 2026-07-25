"use client";

import * as React from "react";
import { ShieldAlert, KeyRound, Loader2 } from "lucide-react";
import { Logo } from "@/components/shell/logo";
import { Button } from "@/components/ui/button";

/** Standalone operator bootstrap — allowlisted email + bootstrap token → super. */
export default function AdminSetupPage() {
  const [phase, setPhase] = React.useState<"loading" | "ready">("loading");
  const [token, setToken] = React.useState("");
  const [error, setError] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    (async () => {
      const me = await fetch("/api/auth/me", { credentials: "same-origin" });
      if (me.status === 401) {
        window.location.href = `/login?next=${encodeURIComponent("/admin-setup")}`;
        return;
      }
      setPhase("ready");
    })();
  }, []);

  const claim = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/admin/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ token: token.trim() }),
      });
      const body = await res.json();
      if (res.ok) {
        window.location.href = "/admin";
        return;
      }
      setError(body.error ?? "Couldn't claim access.");
    } catch {
      setError("Network error.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-sidebar p-4 text-white">
      <div className="absolute inset-0 bg-dotgrid opacity-[0.12]" />
      <div className="relative w-full max-w-md rounded-2xl border border-white/10 bg-white/[0.04] p-8 backdrop-blur">
        <div className="flex justify-center">
          <Logo tone="light" size={34} />
        </div>
        {phase === "loading" ? (
          <div className="mt-10 flex flex-col items-center gap-3 text-white/70">
            <Loader2 className="size-6 animate-spin" />
          </div>
        ) : (
          <>
            <div className="mt-6 flex items-center justify-center">
              <div className="flex size-11 items-center justify-center rounded-xl bg-destructive/20 text-destructive">
                <ShieldAlert className="size-5" />
              </div>
            </div>
            <h1 className="mt-4 text-center font-display text-xl font-semibold">Claim operator access</h1>
            <p className="mt-2 text-center text-sm text-white/60">
              Enter the platform bootstrap token. Your account must be on the operator allowlist.
            </p>
            <div className="mt-5">
              <label className="flex items-center gap-2 text-xs font-medium text-white/70">
                <KeyRound className="size-3.5" /> Bootstrap token
              </label>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && claim()}
                className="mt-1.5 w-full rounded-lg border border-white/15 bg-white/[0.06] px-3 py-2 text-sm text-white outline-none ring-destructive/40 focus:ring-2"
                autoFocus
              />
            </div>
            {error && <p className="mt-3 text-sm text-[#ef6a5f]">{error}</p>}
            <Button className="mt-5 w-full" loading={busy} onClick={claim}>
              Claim access
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
