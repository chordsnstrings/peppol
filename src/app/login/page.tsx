"use client";

import * as React from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowRight, Mail, Lock, ShieldCheck } from "lucide-react";
import { Logo } from "@/components/shell/logo";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";

export default function LoginPage() {
  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Couldn't sign in.");
        setLoading(false);
        return;
      }
      // Honor a safe same-origin ?next= (e.g. the OAuth consent screen).
      const next = new URLSearchParams(window.location.search).get("next");
      const safeNext = next && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
      window.location.href = safeNext;
    } catch {
      setError("Network error. Please try again.");
      setLoading(false);
    }
  };

  return (
    <div className="flex min-h-dvh bg-background">
      <aside className="relative hidden w-[42%] max-w-[520px] shrink-0 flex-col justify-between overflow-hidden bg-sidebar p-10 text-white lg:flex">
        <div className="absolute inset-0 bg-dotgrid opacity-[0.15]" />
        <div
          className="absolute -right-24 top-1/3 size-96 rounded-full opacity-30 blur-3xl"
          style={{ background: "radial-gradient(circle, #C9A84C, transparent 70%)" }}
        />
        <div className="relative">
          <Logo tone="light" size={38} />
        </div>
        <div className="relative">
          <h2 className="font-display text-3xl font-bold leading-tight tracking-tight">
            Welcome back to
            <br />
            <span className="text-gold-gradient">compliant invoicing.</span>
          </h2>
          <p className="mt-3 max-w-sm text-sm leading-relaxed text-white/60">
            Sign in to create, validate and transmit your UAE e-invoices.
          </p>
        </div>
        <div className="relative flex items-center gap-2 text-xs text-white/40">
          <ShieldCheck className="size-4" /> Bank-grade encryption. MFA available.
        </div>
      </aside>

      <div className="flex flex-1 flex-col">
        <div className="flex items-center justify-between p-5 lg:hidden">
          <Logo size={30} />
        </div>
        <div className="flex flex-1 items-center justify-center p-5 sm:p-10">
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
            className="w-full max-w-md"
          >
            <h1 className="font-display text-2xl font-bold tracking-tight">Sign in</h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              Enter your credentials to access your workspace.
            </p>

            <form onSubmit={submit} className="mt-6 space-y-4">
              <Field label="Email">
                <Input
                  type="email"
                  leading={<Mail />}
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@company.ae"
                  autoFocus
                  required
                />
              </Field>
              <Field label="Password">
                <Input
                  type="password"
                  leading={<Lock />}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                />
              </Field>

              {error && (
                <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {error}
                </p>
              )}

              <Button type="submit" size="lg" className="w-full" loading={loading}>
                Sign in
                {!loading && <ArrowRight className="rtl:rotate-180" />}
              </Button>
            </form>

            <p className="mt-6 text-center text-sm text-muted-foreground">
              New to ARKS?{" "}
              <Link href="/onboarding" className="font-medium text-foreground link-underline">
                Create an account
              </Link>
            </p>
          </motion.div>
        </div>
      </div>
    </div>
  );
}
