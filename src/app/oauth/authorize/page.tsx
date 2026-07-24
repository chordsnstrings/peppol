"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import { ShieldCheck, Check, Loader2, Bot } from "lucide-react";
import { Logo } from "@/components/shell/logo";
import { Button } from "@/components/ui/button";

const PARAM_KEYS = [
  "client_id",
  "redirect_uri",
  "response_type",
  "code_challenge",
  "code_challenge_method",
  "scope",
  "state",
  "resource",
];

function AuthorizeInner() {
  const params = useSearchParams();
  const [status, setStatus] = React.useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = React.useState<string>("");
  const [clientName, setClientName] = React.useState<string>("An application");
  const [orgName, setOrgName] = React.useState<string>("");
  const [submitting, setSubmitting] = React.useState<"allow" | "deny" | null>(null);

  const payload = React.useMemo(() => {
    const o: Record<string, string> = {};
    for (const k of PARAM_KEYS) {
      const v = params.get(k);
      if (v !== null) o[k] = v;
    }
    return o;
  }, [params]);

  React.useEffect(() => {
    (async () => {
      // Must be signed in — otherwise bounce to login and come back here.
      const me = await fetch("/api/auth/me", { credentials: "same-origin" });
      if (me.status === 401) {
        const here = `/oauth/authorize${window.location.search}`;
        window.location.href = `/login?next=${encodeURIComponent(here)}`;
        return;
      }
      const meBody = await me.json().catch(() => ({}));
      setOrgName(meBody?.org?.name ?? "your workspace");

      const qs = new URLSearchParams(payload).toString();
      const res = await fetch(`/api/oauth/authorize?${qs}`, { credentials: "same-origin" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) {
        setError(body.error ?? "This authorization request is invalid.");
        setStatus("error");
        return;
      }
      setClientName(body.clientName ?? "An application");
      setStatus("ready");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const decide = async (decision: "allow" | "deny") => {
    setSubmitting(decision);
    try {
      const res = await fetch("/api/oauth/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ ...payload, decision }),
      });
      const body = await res.json();
      if (res.ok && body.redirectTo) {
        window.location.href = body.redirectTo;
        return;
      }
      setError(body.error ?? "Something went wrong.");
      setStatus("error");
    } catch {
      setError("Network error.");
      setStatus("error");
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <div className="flex min-h-dvh items-center justify-center bg-sidebar p-4 text-white">
      <div className="absolute inset-0 bg-dotgrid opacity-[0.12]" />
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative w-full max-w-md rounded-2xl border border-white/10 bg-white/[0.04] p-8 backdrop-blur"
      >
        <div className="flex justify-center">
          <Logo tone="light" size={34} />
        </div>

        {status === "loading" && (
          <div className="mt-10 flex flex-col items-center gap-3 text-white/70">
            <Loader2 className="size-6 animate-spin" />
            <p className="text-sm">Preparing authorization…</p>
          </div>
        )}

        {status === "error" && (
          <div className="mt-8 text-center">
            <h1 className="font-display text-xl font-semibold">Authorization failed</h1>
            <p className="mt-2 text-sm text-white/60">{error}</p>
          </div>
        )}

        {status === "ready" && (
          <>
            <div className="mt-6 flex items-center justify-center gap-3">
              <div className="flex size-11 items-center justify-center rounded-xl bg-white/10">
                <Bot className="size-5" />
              </div>
            </div>
            <h1 className="mt-4 text-center font-display text-xl font-semibold">
              Connect {clientName}
            </h1>
            <p className="mt-2 text-center text-sm text-white/60">
              {clientName} wants to access <span className="font-medium text-white/90">{orgName}</span> on
              your behalf.
            </p>

            <ul className="mt-5 space-y-2.5 rounded-xl bg-white/[0.04] p-4 text-sm text-white/80">
              {[
                "Read your businesses, customers and invoices",
                "Create, validate and send invoices",
                "See your usage — nothing else",
              ].map((f) => (
                <li key={f} className="flex items-start gap-2.5">
                  <Check className="mt-0.5 size-4 shrink-0 text-[#C9A84C]" />
                  {f}
                </li>
              ))}
            </ul>

            <div className="mt-6 flex gap-3">
              <Button variant="ghost" className="flex-1 text-white hover:bg-white/10" loading={submitting === "deny"} onClick={() => decide("deny")}>
                Deny
              </Button>
              <Button className="flex-1" loading={submitting === "allow"} onClick={() => decide("allow")}>
                Authorize
              </Button>
            </div>

            <p className="mt-4 flex items-center justify-center gap-1.5 text-[11px] text-white/40">
              <ShieldCheck className="size-3.5" /> You can revoke access anytime in Settings → API.
            </p>
          </>
        )}
      </motion.div>
    </div>
  );
}

export default function AuthorizePage() {
  return (
    <React.Suspense fallback={null}>
      <AuthorizeInner />
    </React.Suspense>
  );
}
