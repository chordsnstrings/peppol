"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
  Plus,
  Trash2,
  Save,
  Send,
  Eye,
  Sparkles,
  Clock,
  AlertTriangle,
  CheckCircle2,
  Info,
  X,
  ArrowLeft,
  Wand2,
} from "lucide-react";
import { cn, formatDate, id as makeId } from "@/lib/utils";
import { formatMoney, parseMoneyToMinor, minorToMajor } from "@/lib/domain/money";
import { TAX_PROFILE_LIST, DOC_TYPE_LABEL, UNIT_CODES, getProfile } from "@/lib/domain/tax";
import { CURRENCIES } from "@/lib/domain/peppol";
import { validateInvoice, emptyLine } from "@/lib/domain/validation";
import { useAppState } from "@/lib/app-state";
import {
  getById,
} from "@/lib/db/database";
import {
  makeCreditNote,
  makeDraft,
  nextInvoiceNumber,
  persistInvoice,
  recalc,
  saveEntity,
  sendInvoice,
} from "@/lib/db/repo";
import { taxAdvisories } from "@/lib/domain/advice";
import { CREDIT_REASONS } from "@/lib/domain/tax";
import { Lightbulb } from "lucide-react";
import type { Invoice, InvoiceLine, TaxProfileCode } from "@/lib/domain/types";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, Input, Label, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Modal } from "@/components/ui/modal";
import { Sheet } from "@/components/ui/modal";
import { CustomerPicker } from "@/components/invoice/customer-picker";
import { InvoicePreview } from "@/components/invoice/invoice-preview";
import { toast } from "sonner";

export default function InvoiceEditorPage() {
  const router = useRouter();
  const params = useSearchParams();
  const { currentEntity } = useAppState();

  const [inv, setInv] = React.useState<Invoice | null>(null);
  const [isNew, setIsNew] = React.useState(true);
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const [confirmSend, setConfirmSend] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [sending, setSending] = React.useState(false);

  // Initialise draft (new / edit / duplicate / credit note)
  React.useEffect(() => {
    if (!currentEntity) return;
    const from = params.get("from");
    const dup = params.get("duplicate");
    const creditFor = params.get("creditFor");
    (async () => {
      if (from) {
        const existing = await getById("invoices", from);
        if (existing) {
          setInv(existing as Invoice);
          setIsNew(false);
          return;
        }
      }
      const { number } = await nextInvoiceNumber(currentEntity);

      if (creditFor) {
        const source = (await getById("invoices", creditFor)) as Invoice | undefined;
        if (source) {
          setInv({ ...makeCreditNote(currentEntity, source), number });
          setIsNew(true);
          return;
        }
      }

      const draft = makeDraft(currentEntity, { number });
      if (dup) {
        const source = (await getById("invoices", dup)) as Invoice | undefined;
        if (source) {
          draft.buyer = source.buyer;
          draft.customerId = source.customerId;
          draft.currency = source.currency;
          draft.lines = source.lines.map((l) => ({ ...l, id: makeId("ln") }));
        }
      }
      setInv(recalc(draft));
      setIsNew(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentEntity]);

  const live = React.useMemo(() => (inv ? recalc(inv) : null), [inv]);
  const validation = React.useMemo(() => (live ? validateInvoice(live) : null), [live]);
  const advisories = React.useMemo(() => (live ? taxAdvisories(live) : []), [live]);

  if (!inv || !live || !currentEntity) {
    return (
      <div className="flex h-[60vh] items-center justify-center">
        <div className="size-8 animate-spin rounded-full border-2 border-muted border-t-gold" />
      </div>
    );
  }

  const update = (patch: Partial<Invoice>) => setInv((p) => (p ? { ...p, ...patch } : p));
  const updateLine = (lineId: string, patch: Partial<InvoiceLine>) =>
    setInv((p) =>
      p ? { ...p, lines: p.lines.map((l) => (l.id === lineId ? { ...l, ...patch } : l)) } : p,
    );
  const addLine = () =>
    setInv((p) => (p ? { ...p, lines: [...p.lines, emptyLine(p.lines.length + 1)] } : p));
  const removeLine = (lineId: string) =>
    setInv((p) => (p ? { ...p, lines: p.lines.filter((l) => l.id !== lineId) } : p));

  const bumpSeqIfNew = async () => {
    if (isNew) {
      await saveEntity({ ...currentEntity, numberingSeq: currentEntity.numberingSeq + 1 });
    }
  };

  const saveDraft = async () => {
    setSaving(true);
    await persistInvoice(live);
    await bumpSeqIfNew();
    setIsNew(false);
    setSaving(false);
    toast.success("Draft saved", { description: "Autosaved to this device." });
  };

  const doSend = async () => {
    setSending(true);
    try {
      await persistInvoice(live);
      await bumpSeqIfNew();
      const sent = await sendInvoice(live, currentEntity);
      setConfirmSend(false);
      toast.success(
        currentEntity.einvoicingStatus === "LIVE" ? "Queued for the gateway" : "Sent, delivered & reported",
        { description: `${sent.number} is on its way.` },
      );
      router.push(`/invoices/${sent.id}`);
    } catch {
      setSending(false);
      setConfirmSend(false);
      toast.error("Can't send yet", { description: "Resolve the blocking issues first." });
    }
  };

  const nonAED = live.currency !== "AED";

  return (
    <div className="pb-20 md:pb-0">
      <PageHeader
        breadcrumb={[{ label: "Invoices", href: "/invoices" }, { label: isNew ? "New" : live.number }]}
        title={isNew ? "New invoice" : `Edit ${live.number}`}
        description="Fill in the facts — we handle the compliance."
        actions={
          <div className="hidden items-center gap-2 md:flex">
            <Button variant="outline" icon={<Eye />} onClick={() => setPreviewOpen(true)}>
              Preview
            </Button>
            <Button variant="secondary" icon={<Save />} loading={saving} onClick={saveDraft}>
              Save draft
            </Button>
            <Button
              icon={<Send />}
              disabled={!validation?.canSend}
              onClick={() => setConfirmSend(true)}
            >
              Send
            </Button>
          </div>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        {/* Form column */}
        <div className="space-y-5">
          {/* Credit-note context */}
          {live.docType === "TAX_CREDIT_NOTE" && (
            <Card className="border-gold/25 bg-gold/[0.05]">
              <CardContent className="grid gap-3 p-4 sm:grid-cols-2">
                <Field label="Correcting invoice">
                  <Input
                    value={live.precedingInvoices?.[0]?.number ?? ""}
                    onChange={(e) =>
                      update({ precedingInvoices: [{ number: e.target.value, invoiceId: live.precedingInvoices?.[0]?.invoiceId }] })
                    }
                    placeholder="Original invoice number"
                  />
                </Field>
                <Field label="Reason for credit">
                  <Select value={live.creditReason ?? "PRICE"} onChange={(e) => update({ creditReason: e.target.value })}>
                    {CREDIT_REASONS.map((r) => (
                      <option key={r.code} value={r.code}>
                        {r.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              </CardContent>
            </Card>
          )}

          {/* Customer */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Who is this for?</CardTitle>
            </CardHeader>
            <CardContent>
              <CustomerPicker
                buyer={live.buyer}
                onSelect={(party, customerId) => update({ buyer: party, customerId })}
              />
            </CardContent>
          </Card>

          {/* Details */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Details</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Field label="Invoice number">
                <Input value={live.number} onChange={(e) => update({ number: e.target.value })} />
              </Field>
              <Field label="Currency">
                <Select value={live.currency} onChange={(e) => update({ currency: e.target.value })}>
                  {CURRENCIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Issue date">
                <Input
                  type="date"
                  value={live.issueDate}
                  onChange={(e) => update({ issueDate: e.target.value })}
                />
              </Field>
              <Field label="Supply date" help="Drives the 14-day compliance clock.">
                <Input
                  type="date"
                  value={live.supplyDate}
                  onChange={(e) => update({ supplyDate: e.target.value })}
                />
              </Field>
            </CardContent>
          </Card>

          {/* FX panel */}
          <AnimatePresence>
            {nonAED && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="overflow-hidden"
              >
                <Card className="border-info/25 bg-info/[0.04]">
                  <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-end">
                    <div className="flex items-center gap-2 text-sm">
                      <Info className="size-4 text-info" />
                      <span>
                        {live.currency} invoice — we carry the AED tax total at the CBUAE rate.
                      </span>
                    </div>
                    <div className="flex-1" />
                    <Field label="Rate to AED" className="w-32">
                      <Input
                        inputMode="decimal"
                        placeholder="3.6725"
                        value={live.fx?.rateToAED ?? ""}
                        onChange={(e) =>
                          update({
                            fx: {
                              rateToAED: e.target.value,
                              source: "MANUAL",
                              rateDate: live.supplyDate,
                            },
                          })
                        }
                      />
                    </Field>
                  </CardContent>
                </Card>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Lines */}
          <Card>
            <CardHeader className="flex-row items-center justify-between pb-3">
              <CardTitle className="text-base">Line items</CardTitle>
              <Badge tone="gold" size="sm">
                <Sparkles className="size-3" /> {DOC_TYPE_LABEL[live.docType]}
              </Badge>
            </CardHeader>
            <CardContent className="space-y-3">
              {live.lines.length === 0 && (
                <div className="rounded-xl border border-dashed border-border py-8 text-center text-sm text-muted-foreground">
                  No lines yet. Add your first item below.
                </div>
              )}
              <AnimatePresence initial={false}>
                {live.lines.map((line, idx) => (
                  <LineRow
                    key={line.id}
                    line={line}
                    index={idx}
                    currency={live.currency}
                    onChange={(patch) => updateLine(line.id, patch)}
                    onRemove={() => removeLine(line.id)}
                  />
                ))}
              </AnimatePresence>
              <Button variant="outline" icon={<Plus />} className="w-full" onClick={addLine}>
                Add line
              </Button>
            </CardContent>
          </Card>

          {/* Notes */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Notes</CardTitle>
            </CardHeader>
            <CardContent>
              <Textarea
                placeholder="Payment terms, PO reference, thank-you note…"
                value={live.notes ?? ""}
                onChange={(e) => update({ notes: e.target.value })}
              />
            </CardContent>
          </Card>
        </div>

        {/* Summary column */}
        <div className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          {/* Compliance clock */}
          <ComplianceChip inv={live} />

          {/* Totals */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <SummaryRow label="Subtotal" value={formatMoney(live.totals.taxExclusiveMinor, live.currency)} />
              {live.totals.perCategory.map((c) => (
                <SummaryRow
                  key={c.categoryCode + c.ratePercent}
                  label={`VAT ${c.ratePercent}% · ${getProfile(c.profileCode).label.split(" ")[0]}`}
                  value={formatMoney(c.vatMinor, live.currency)}
                  muted
                />
              ))}
              <div className="my-1 h-px bg-border" />
              <div className="flex items-center justify-between">
                <span className="font-semibold">Total due</span>
                <span className="font-display text-xl font-bold tnum">
                  {formatMoney(live.totals.taxInclusiveMinor, live.currency)}
                </span>
              </div>
            </CardContent>
          </Card>

          {/* Validation */}
          <ValidationPanel result={validation} />

          {advisories.length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <Lightbulb className="size-4 text-gold" /> Tax guidance
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2.5">
                {advisories.map((a) => (
                  <div key={a.id} className="rounded-lg bg-muted/50 p-2.5">
                    <p className="flex items-center gap-1.5 text-sm font-medium">
                      {a.tone === "warning" ? (
                        <AlertTriangle className="size-3.5 text-[hsl(var(--warning))]" />
                      ) : (
                        <Info className="size-3.5 text-info" />
                      )}
                      {a.title}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">{a.body}</p>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Mobile sticky action bar */}
      <div className="fixed inset-x-0 bottom-0 z-20 flex items-center gap-2 border-t border-border glass-strong p-3 safe-bottom md:hidden">
        <Button variant="outline" size="icon" onClick={() => setPreviewOpen(true)} aria-label="Preview">
          <Eye />
        </Button>
        <Button variant="secondary" className="flex-1" loading={saving} onClick={saveDraft}>
          Save
        </Button>
        <Button className="flex-1" disabled={!validation?.canSend} onClick={() => setConfirmSend(true)}>
          Send
        </Button>
      </div>

      {/* Preview sheet (mobile) / modal (desktop) */}
      <Sheet open={previewOpen} onClose={() => setPreviewOpen(false)} side="bottom" className="md:hidden">
        <div className="flex items-center justify-between border-b border-border p-4">
          <h3 className="font-semibold">Preview</h3>
          <Button variant="ghost" size="icon-sm" onClick={() => setPreviewOpen(false)}>
            <X />
          </Button>
        </div>
        <div className="p-4">
          <InvoicePreview invoice={live} />
        </div>
      </Sheet>
      <Modal open={previewOpen} onClose={() => setPreviewOpen(false)} size="xl" className="hidden md:block" title="Invoice preview">
        <div className="max-h-[80vh] overflow-y-auto bg-muted/40 p-6">
          <InvoicePreview invoice={live} />
        </div>
      </Modal>

      {/* Send confirmation */}
      <Modal
        open={confirmSend}
        onClose={() => setConfirmSend(false)}
        title="Send this invoice?"
        size="md"
      >
        <div className="p-5 sm:p-6">
          <p className="text-sm text-muted-foreground">Here's exactly what happens when you send:</p>
          <div className="mt-4 space-y-3">
            <FlowStep
              icon={<Send className="text-info" />}
              title="Deliver to the buyer"
              desc={`Transmitted to ${live.buyer.nameEn || "the buyer"} across the Peppol network.`}
            />
            <FlowStep
              icon={<CheckCircle2 className="text-success" />}
              title="Report to the FTA"
              desc="A Tax Data Document is filed for the reporting leg, in near-real-time."
            />
          </div>
          <div className="mt-4 flex items-center justify-between rounded-xl bg-muted/60 p-3.5">
            <span className="text-sm text-muted-foreground">Total</span>
            <span className="font-display text-lg font-bold tnum">
              {formatMoney(live.totals.taxInclusiveMinor, live.currency)}
            </span>
          </div>
          {currentEntity.einvoicingStatus === "SANDBOX" && (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-[hsl(var(--gold))]">
              <Sparkles className="size-3.5" /> Sandbox mode — this is a safe test transmission.
            </p>
          )}
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmSend(false)}>
              Cancel
            </Button>
            <Button icon={<Send />} loading={sending} onClick={doSend}>
              Confirm & send
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/* ---------------- Line row ---------------- */

function LineRow({
  line,
  index,
  currency,
  onChange,
  onRemove,
}: {
  line: InvoiceLine;
  index: number;
  currency: string;
  onChange: (patch: Partial<InvoiceLine>) => void;
  onRemove: () => void;
}) {
  const profile = getProfile(line.taxProfileCode);
  const [priceStr, setPriceStr] = React.useState(
    line.unitPriceMinor ? String(minorToMajor(line.unitPriceMinor)) : "",
  );

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0, marginTop: 0 }}
      className="rounded-xl border border-border bg-background/60 p-3"
    >
      <div className="flex items-start gap-2">
        <span className="mt-2.5 hidden w-5 shrink-0 text-center text-xs font-medium text-muted-foreground sm:block tnum">
          {index + 1}
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <Input
            placeholder="Description (e.g. Consulting services — March)"
            value={line.description}
            onChange={(e) => onChange({ description: e.target.value })}
          />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div>
              <Label className="mb-1 text-[11px] text-muted-foreground">Qty</Label>
              <Input
                inputMode="decimal"
                value={line.qty}
                onChange={(e) => onChange({ qty: Number(e.target.value) || 0 })}
                className="h-9"
              />
            </div>
            <div>
              <Label className="mb-1 text-[11px] text-muted-foreground">Unit</Label>
              <Select
                value={line.unitCode}
                onChange={(e) => onChange({ unitCode: e.target.value })}
                className="h-9"
              >
                {UNIT_CODES.map((u) => (
                  <option key={u.code} value={u.code}>
                    {u.label}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label className="mb-1 text-[11px] text-muted-foreground">Unit price</Label>
              <Input
                inputMode="decimal"
                value={priceStr}
                onChange={(e) => {
                  setPriceStr(e.target.value);
                  onChange({ unitPriceMinor: parseMoneyToMinor(e.target.value) });
                }}
                className="h-9"
              />
            </div>
            <div>
              <Label className="mb-1 text-[11px] text-muted-foreground">Tax</Label>
              <Select
                value={line.taxProfileCode}
                onChange={(e) => onChange({ taxProfileCode: e.target.value as TaxProfileCode })}
                className="h-9"
              >
                {TAX_PROFILE_LIST.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          {profile.requiresExemptionReason && (
            <Input
              placeholder={`Reason for ${profile.label.toLowerCase()}…`}
              value={line.exemptionReason ?? ""}
              onChange={(e) => onChange({ exemptionReason: e.target.value })}
              className="h-9 text-sm"
            />
          )}
          <div className="flex items-center justify-between pt-0.5">
            <span className="text-xs text-muted-foreground">{profile.hint}</span>
            <span className="text-sm font-semibold tnum">
              {formatMoney(line.lineNetMinor, currency)}
            </span>
          </div>
        </div>
        <button
          onClick={onRemove}
          className="mt-1 inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive focus-ring"
          aria-label="Remove line"
        >
          <Trash2 className="size-4" />
        </button>
      </div>
    </motion.div>
  );
}

/* ---------------- Helpers ---------------- */

function SummaryRow({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className={cn(muted ? "text-muted-foreground" : "text-foreground")}>{label}</span>
      <span className="font-medium tnum">{value}</span>
    </div>
  );
}

function ComplianceChip({ inv }: { inv: Invoice }) {
  const { daysRemaining, breached } = inv.compliance;
  const tone = breached ? "error" : daysRemaining <= 3 ? "warning" : "success";
  const toneCls = {
    error: "border-destructive/25 bg-destructive/[0.06] text-destructive",
    warning: "border-warning/30 bg-warning/[0.06] text-[hsl(var(--warning))]",
    success: "border-success/25 bg-success/[0.06] text-success",
  }[tone];
  return (
    <div className={cn("flex items-center gap-2.5 rounded-xl border p-3 text-sm", toneCls)}>
      <Clock className="size-4 shrink-0" />
      <span className="font-medium">
        {breached
          ? "Past the 14-day window — still sendable"
          : `${daysRemaining} day${daysRemaining === 1 ? "" : "s"} left to issue`}
      </span>
    </div>
  );
}

function ValidationPanel({ result }: { result: ReturnType<typeof validateInvoice> | null }) {
  if (!result) return null;
  if (result.issues.length === 0) {
    return (
      <Card className="border-success/25 bg-success/[0.04]">
        <CardContent className="flex items-center gap-3 p-4">
          <CheckCircle2 className="size-5 text-success" />
          <div>
            <p className="text-sm font-semibold">Ready to send</p>
            <p className="text-xs text-muted-foreground">Everything checks out.</p>
          </div>
        </CardContent>
      </Card>
    );
  }
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          Checks
          {result.errors > 0 && <Badge tone="error" size="sm">{result.errors} to fix</Badge>}
          {result.warnings > 0 && <Badge tone="warning" size="sm">{result.warnings} to review</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {result.issues.slice(0, 6).map((issue, i) => (
          <div key={i} className="flex items-start gap-2.5 rounded-lg bg-muted/50 p-2.5">
            {issue.severity === "ERROR" ? (
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
            ) : (
              <Info className="mt-0.5 size-4 shrink-0 text-[hsl(var(--warning))]" />
            )}
            <div className="min-w-0">
              <p className="text-sm">{issue.message}</p>
              {issue.fix && <p className="mt-0.5 text-xs text-muted-foreground">{issue.fix}</p>}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function FlowStep({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="flex gap-3">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted [&_svg]:size-5">
        {icon}
      </div>
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{desc}</p>
      </div>
    </div>
  );
}
