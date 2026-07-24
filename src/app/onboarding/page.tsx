"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Building2,
  BadgeCheck,
  ShieldCheck,
  FileSpreadsheet,
  PenLine,
  Plug,
  Sparkles,
  Loader2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppState } from "@/lib/app-state";
import { createEntity, createOrganization } from "@/lib/db/repo";
import { metaSet } from "@/lib/db/database";
import { derivePeppolId, EMIRATES, validateTIN, validateTRN } from "@/lib/domain/peppol";
import { Logo } from "@/components/shell/logo";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Segmented } from "@/components/ui/controls";
import { Badge } from "@/components/ui/badge";

type Locale = "en" | "ar";

interface Draft {
  yourName: string;
  orgName: string;
  locale: Locale;
  legalNameEn: string;
  legalNameAr: string;
  emirate: string;
  street: string;
  poBox: string;
  tradeLicenseNo: string;
  vatRegistered: boolean;
  trn: string;
  tin: string;
  invoiceStyle: "editor" | "excel" | "software";
}

const STEPS = [
  { key: "account", title: "Your account", icon: Sparkles },
  { key: "entity", title: "Business details", icon: Building2 },
  { key: "tax", title: "Tax identity", icon: BadgeCheck },
  { key: "style", title: "How you invoice", icon: PenLine },
];

export default function OnboardingPage() {
  const router = useRouter();
  const { ready, onboarded } = useAppState();
  const [step, setStep] = React.useState(0);
  const [dir, setDir] = React.useState(1);
  const [submitting, setSubmitting] = React.useState(false);
  const [d, setD] = React.useState<Draft>({
    yourName: "",
    orgName: "",
    locale: "en",
    legalNameEn: "",
    legalNameAr: "",
    emirate: "DU",
    street: "",
    poBox: "",
    tradeLicenseNo: "",
    vatRegistered: true,
    trn: "",
    tin: "",
    invoiceStyle: "editor",
  });

  React.useEffect(() => {
    if (ready && onboarded) router.replace("/dashboard");
  }, [ready, onboarded, router]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((p) => ({ ...p, [k]: v }));

  const trnCheck = validateTRN(d.trn);
  const tinCheck = validateTIN(d.tin);
  const taxId = d.vatRegistered ? d.trn : d.tin;
  const peppolId = derivePeppolId(taxId);

  const canNext = (): boolean => {
    if (step === 0) return d.orgName.trim().length > 1 && d.yourName.trim().length > 0;
    if (step === 1) return d.legalNameEn.trim().length > 1;
    if (step === 2) return d.vatRegistered ? trnCheck.ok : tinCheck.ok;
    return true;
  };

  const next = () => {
    if (step < STEPS.length - 1) {
      setDir(1);
      setStep((s) => s + 1);
    } else {
      finish();
    }
  };
  const back = () => {
    setDir(-1);
    setStep((s) => Math.max(0, s - 1));
  };

  const finish = async () => {
    setSubmitting(true);
    try {
      const org = await createOrganization(d.orgName, d.locale);
      const entity = await createEntity(org.id, {
        legalNameEn: d.legalNameEn,
        legalNameAr: d.legalNameAr || undefined,
        tradeLicenseNo: d.tradeLicenseNo || undefined,
        trn: d.vatRegistered ? trnCheck.cleaned : undefined,
        tin: !d.vatRegistered ? tinCheck.cleaned : undefined,
        vatRegistered: d.vatRegistered,
        emirate: d.emirate,
        street: d.street || undefined,
        poBox: d.poBox || undefined,
        defaultCurrency: "AED",
      });
      await metaSet("currentEntityId", entity.id);
      await metaSet("locale", d.locale);
      await metaSet("invoiceStyle", d.invoiceStyle);
      await metaSet("onboardedAt", new Date().toISOString());
      // brief celebratory beat before entering the app
      setStep(STEPS.length);
      setTimeout(() => router.replace("/dashboard"), 1400);
    } catch {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-dvh bg-background">
      {/* Brand rail */}
      <aside className="relative hidden w-[42%] max-w-[520px] shrink-0 flex-col justify-between overflow-hidden bg-sidebar p-10 text-white lg:flex">
        <div className="absolute inset-0 bg-dotgrid opacity-[0.15]" />
        <div
          className="absolute -right-24 top-1/4 size-96 rounded-full opacity-30 blur-3xl"
          style={{ background: "radial-gradient(circle, #C9A84C, transparent 70%)" }}
        />
        <div className="relative">
          <Logo tone="light" size={38} />
        </div>
        <div className="relative space-y-8">
          <div>
            <h2 className="font-display text-3xl font-bold leading-tight tracking-tight">
              UAE e-invoicing,
              <br />
              <span className="text-gold-gradient">made effortless.</span>
            </h2>
            <p className="mt-3 max-w-sm text-sm leading-relaxed text-white/60">
              From signup to your first compliant invoice in minutes — no jargon, no double entry,
              no surprises.
            </p>
          </div>
          <ol className="space-y-3">
            {STEPS.map((s, i) => {
              const done = i < step;
              const active = i === step;
              return (
                <li key={s.key} className="flex items-center gap-3">
                  <span
                    className={cn(
                      "flex size-9 items-center justify-center rounded-xl border transition-colors",
                      done && "border-gold/40 bg-gold text-[#0B1A2E]",
                      active && "border-gold/40 bg-white/5 text-gold",
                      !done && !active && "border-white/10 text-white/40",
                    )}
                  >
                    {done ? <Check className="size-4" /> : <s.icon className="size-4" />}
                  </span>
                  <span
                    className={cn(
                      "text-sm font-medium transition-colors",
                      active ? "text-white" : "text-white/50",
                    )}
                  >
                    {s.title}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
        <div className="relative flex items-center gap-2 text-xs text-white/40">
          <ShieldCheck className="size-4" /> Your data stays on this device until you send.
        </div>
      </aside>

      {/* Form */}
      <div className="flex flex-1 flex-col">
        {/* Mobile progress */}
        <div className="flex items-center justify-between px-5 pt-5 lg:hidden">
          <Logo size={30} />
          <span className="text-xs font-medium text-muted-foreground tnum">
            {Math.min(step + 1, STEPS.length)} / {STEPS.length}
          </span>
        </div>
        <div className="h-1 w-full bg-muted lg:hidden">
          <motion.div
            className="h-full bg-gold"
            animate={{ width: `${(Math.min(step, STEPS.length) / STEPS.length) * 100}%` }}
          />
        </div>

        <div className="flex flex-1 items-center justify-center p-5 sm:p-10">
          <div className="w-full max-w-md">
            <AnimatePresence mode="wait" custom={dir}>
              {step === STEPS.length ? (
                <motion.div
                  key="done"
                  initial={{ opacity: 0, scale: 0.9 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="flex flex-col items-center text-center"
                >
                  <motion.div
                    initial={{ scale: 0 }}
                    animate={{ scale: 1 }}
                    transition={{ type: "spring", stiffness: 260, damping: 16 }}
                    className="flex size-20 items-center justify-center rounded-3xl bg-success text-white"
                  >
                    <Check className="size-10" strokeWidth={3} />
                  </motion.div>
                  <h2 className="mt-6 font-display text-2xl font-bold tracking-tight">
                    You're all set
                  </h2>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Taking you to your dashboard…
                  </p>
                  <Loader2 className="mt-4 size-5 animate-spin text-muted-foreground" />
                </motion.div>
              ) : (
                <motion.div
                  key={step}
                  custom={dir}
                  initial={{ opacity: 0, x: dir * 40 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: dir * -40 }}
                  transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                >
                  {step === 0 && (
                    <StepShell
                      title="Let's get you compliant"
                      subtitle="First, tell us who you are. This creates your workspace."
                    >
                      <Field label="Your name" required>
                        <Input
                          value={d.yourName}
                          onChange={(e) => set("yourName", e.target.value)}
                          placeholder="Ahmed Al Marri"
                          autoFocus
                        />
                      </Field>
                      <Field label="Organization name" required help="Your company or practice name.">
                        <Input
                          value={d.orgName}
                          onChange={(e) => set("orgName", e.target.value)}
                          placeholder="Marri Trading LLC"
                        />
                      </Field>
                      <Field label="Preferred language">
                        <Segmented
                          value={d.locale}
                          onChange={(v) => set("locale", v)}
                          options={[
                            { value: "en", label: "English" },
                            { value: "ar", label: "العربية" },
                          ]}
                        />
                      </Field>
                    </StepShell>
                  )}

                  {step === 1 && (
                    <StepShell
                      title="Your business details"
                      subtitle="These appear on every invoice as the seller."
                    >
                      <Field label="Legal name (English)" required>
                        <Input
                          value={d.legalNameEn}
                          onChange={(e) => set("legalNameEn", e.target.value)}
                          placeholder="Marri Trading LLC"
                          autoFocus
                        />
                      </Field>
                      <Field label="Legal name (Arabic)" hint="optional">
                        <Input
                          dir="rtl"
                          value={d.legalNameAr}
                          onChange={(e) => set("legalNameAr", e.target.value)}
                          placeholder="ماري للتجارة ذ.م.م"
                        />
                      </Field>
                      <div className="grid grid-cols-2 gap-3">
                        <Field label="Emirate">
                          <Select value={d.emirate} onChange={(e) => set("emirate", e.target.value)}>
                            {EMIRATES.map((em) => (
                              <option key={em.code} value={em.code}>
                                {em.name}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <Field label="P.O. Box" hint="optional">
                          <Input value={d.poBox} onChange={(e) => set("poBox", e.target.value)} />
                        </Field>
                      </div>
                      <Field label="Address" hint="optional">
                        <Input
                          value={d.street}
                          onChange={(e) => set("street", e.target.value)}
                          placeholder="Office 1203, Business Bay"
                        />
                      </Field>
                    </StepShell>
                  )}

                  {step === 2 && (
                    <StepShell
                      title="Tax identity"
                      subtitle="We derive your Peppol network ID from this — automatically."
                    >
                      <Field label="Are you VAT registered?">
                        <Segmented
                          value={d.vatRegistered ? "yes" : "no"}
                          onChange={(v) => set("vatRegistered", v === "yes")}
                          options={[
                            { value: "yes", label: "Yes, I have a TRN" },
                            { value: "no", label: "No (TIN only)" },
                          ]}
                        />
                      </Field>

                      {d.vatRegistered ? (
                        <Field
                          label="Tax Registration Number (TRN)"
                          required
                          error={
                            d.trn && !trnCheck.ok && trnCheck.tone === "error"
                              ? trnCheck.message
                              : undefined
                          }
                          help={d.trn ? undefined : "15 digits, from your VAT certificate."}
                        >
                          <Input
                            inputMode="numeric"
                            value={d.trn}
                            onChange={(e) => set("trn", e.target.value)}
                            placeholder="100 1234 5678 9003"
                            invalid={Boolean(d.trn) && !trnCheck.ok && trnCheck.tone === "error"}
                            trailing={
                              d.trn ? (
                                trnCheck.ok ? (
                                  <Check className="text-success" />
                                ) : (
                                  <span className="text-xs text-muted-foreground tnum">
                                    {trnCheck.cleaned.length}/15
                                  </span>
                                )
                              ) : null
                            }
                          />
                        </Field>
                      ) : (
                        <Field
                          label="Tax Identification Number (TIN)"
                          required
                          help="Not VAT registered? You still need a TIN from the FTA."
                        >
                          <Input
                            inputMode="numeric"
                            value={d.tin}
                            onChange={(e) => set("tin", e.target.value)}
                            placeholder="10-digit TIN"
                            trailing={tinCheck.ok ? <Check className="text-success" /> : null}
                          />
                        </Field>
                      )}

                      {d.trn && trnCheck.tone === "warning" && (
                        <p className="-mt-1 text-xs text-[hsl(var(--warning))]">{trnCheck.message}</p>
                      )}

                      <AnimatePresence>
                        {peppolId && (
                          <motion.div
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: "auto" }}
                            exit={{ opacity: 0, height: 0 }}
                            className="overflow-hidden"
                          >
                            <div className="flex items-center gap-3 rounded-xl border border-gold/25 bg-gold/[0.07] p-3.5">
                              <div className="flex size-9 items-center justify-center rounded-lg bg-gold/15 text-[hsl(var(--gold))]">
                                <BadgeCheck className="size-5" />
                              </div>
                              <div className="min-w-0">
                                <p className="text-xs text-muted-foreground">Your Peppol ID</p>
                                <p className="font-mono text-sm font-semibold">{peppolId}</p>
                              </div>
                            </div>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </StepShell>
                  )}

                  {step === 3 && (
                    <StepShell
                      title="How do you invoice today?"
                      subtitle="We'll tailor your dashboard. Nothing is ever locked away."
                    >
                      <div className="grid gap-3">
                        {(
                          [
                            {
                              key: "editor",
                              icon: PenLine,
                              title: "I'll create them here",
                              desc: "A simple editor with compliance on autopilot.",
                            },
                            {
                              key: "excel",
                              icon: FileSpreadsheet,
                              title: "I have Excel sheets",
                              desc: "Upload, map once, and send in bulk.",
                            },
                            {
                              key: "software",
                              icon: Plug,
                              title: "I use accounting software",
                              desc: "Connect Zoho, QuickBooks, Xero or Odoo.",
                            },
                          ] as const
                        ).map((opt) => {
                          const active = d.invoiceStyle === opt.key;
                          return (
                            <button
                              key={opt.key}
                              onClick={() => set("invoiceStyle", opt.key)}
                              className={cn(
                                "flex items-center gap-3.5 rounded-xl border p-4 text-start transition-all",
                                active
                                  ? "border-gold bg-gold/[0.06] ring-1 ring-gold/30"
                                  : "border-border hover:border-muted-foreground/30 hover:bg-accent/50",
                              )}
                            >
                              <div
                                className={cn(
                                  "flex size-11 shrink-0 items-center justify-center rounded-xl [&_svg]:size-5",
                                  active ? "bg-gold text-[#0B1A2E]" : "bg-muted text-muted-foreground",
                                )}
                              >
                                <opt.icon />
                              </div>
                              <div className="flex-1">
                                <p className="text-sm font-semibold">{opt.title}</p>
                                <p className="text-xs text-muted-foreground">{opt.desc}</p>
                              </div>
                              <span
                                className={cn(
                                  "flex size-5 items-center justify-center rounded-full border transition-colors",
                                  active ? "border-gold bg-gold text-[#0B1A2E]" : "border-border",
                                )}
                              >
                                {active && <Check className="size-3.5" strokeWidth={3} />}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </StepShell>
                  )}
                </motion.div>
              )}
            </AnimatePresence>

            {/* Controls */}
            {step < STEPS.length && (
              <div className="mt-8 flex items-center justify-between">
                <Button
                  variant="ghost"
                  onClick={back}
                  disabled={step === 0}
                  icon={<ArrowLeft className="rtl:rotate-180" />}
                  className={cn(step === 0 && "invisible")}
                >
                  Back
                </Button>
                <Button
                  onClick={next}
                  disabled={!canNext() || submitting}
                  loading={submitting}
                  size="lg"
                  className="min-w-[140px]"
                >
                  {step === STEPS.length - 1 ? "Create workspace" : "Continue"}
                  {!submitting && <ArrowRight className="rtl:rotate-180" />}
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StepShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Badge tone="gold" size="sm" className="mb-3">
        Setup
      </Badge>
      <h1 className="font-display text-2xl font-bold tracking-tight">{title}</h1>
      <p className="mt-1.5 text-sm text-muted-foreground">{subtitle}</p>
      <div className="mt-6 space-y-4">{children}</div>
    </div>
  );
}
