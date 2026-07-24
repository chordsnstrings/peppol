"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { Repeat, Plus, Play, Trash2, Zap, CalendarClock } from "lucide-react";
import { useAppState } from "@/lib/app-state";
import { useCollection } from "@/lib/db/hooks";
import { useInvoices } from "@/hooks/use-entity-data";
import { saveTemplate, deleteTemplate, makeTemplateFromInvoice, makeInvoiceFromTemplate } from "@/lib/db/repo";
import { runRecurring } from "@/lib/recurring-client";
import { CADENCES, cadenceLabel, isDue } from "@/lib/domain/recurring";
import { formatMoney } from "@/lib/domain/money";
import { formatDate } from "@/lib/utils";
import type { Invoice, RecurringCadence, RecurringTemplate } from "@/lib/domain/types";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/controls";
import { EmptyState } from "@/components/ui/empty-state";
import { Modal, ConfirmDialog } from "@/components/ui/modal";
import { toast } from "sonner";

const inputCls =
  "mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none ring-primary/30 focus:ring-2";

export default function RecurringPage() {
  const { currentEntity } = useAppState();
  const router = useRouter();
  const { data: templates } = useCollection<RecurringTemplate>("recurring", {
    index: currentEntity ? { name: "entityId", value: currentEntity.id } : undefined,
    sort: (a, b) => a.nextRunDate.localeCompare(b.nextRunDate),
    deps: [currentEntity?.id],
  });
  const { invoices } = useInvoices((i) => i.direction === "OUTBOUND");

  const [creating, setCreating] = React.useState(false);
  const [deleting, setDeleting] = React.useState<RecurringTemplate | null>(null);
  const [running, setRunning] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  // New-template form state
  const [srcId, setSrcId] = React.useState("");
  const [name, setName] = React.useState("");
  const [cadence, setCadence] = React.useState<RecurringCadence>("MONTHLY");
  const [start, setStart] = React.useState(new Date().toISOString().slice(0, 10));
  const [autoSend, setAutoSend] = React.useState(false);

  const dueCount = templates.filter((t) => t.active && isDue(t.nextRunDate)).length;

  const create = async () => {
    if (!currentEntity) return;
    const src = invoices.find((i) => i.id === srcId);
    if (!src) {
      toast.error("Pick an invoice to base the template on");
      return;
    }
    const t = makeTemplateFromInvoice(currentEntity, src, {
      name: name.trim() || `${src.buyer.nameEn || "Customer"} — ${cadenceLabel(cadence).toLowerCase()}`,
      cadence,
      nextRunDate: start,
      autoSend,
    });
    await saveTemplate(t);
    toast.success("Recurring template created");
    setCreating(false);
    setSrcId("");
    setName("");
  };

  const generateNow = async (t: RecurringTemplate) => {
    if (!currentEntity) return;
    setBusyId(t.id);
    try {
      const inv = await makeInvoiceFromTemplate(currentEntity, t);
      await saveTemplate({ ...t, generatedCount: (t.generatedCount ?? 0) + 1, lastRunAt: new Date().toISOString() });
      toast.success("Draft created", { description: `${inv.number} is ready to review.` });
      router.push(`/invoices/${inv.id}`);
    } catch {
      toast.error("Couldn't generate");
    } finally {
      setBusyId(null);
    }
  };

  const toggleActive = async (t: RecurringTemplate, v: boolean) => {
    await saveTemplate({ ...t, active: v });
  };

  const runDue = async () => {
    setRunning(true);
    try {
      const { generated, sent } = await runRecurring();
      toast.success(
        generated === 0 ? "Nothing due" : `Generated ${generated} invoice${generated === 1 ? "" : "s"}`,
        { description: sent > 0 ? `${sent} sent automatically.` : undefined },
      );
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't run");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Recurring invoices"
        description="Bill the same customers on a schedule — generate drafts to review, or auto-send them."
        icon={<Repeat />}
        actions={
          <>
            <Button variant="outline" icon={<CalendarClock />} loading={running} onClick={runDue}>
              Run due{dueCount > 0 ? ` (${dueCount})` : ""}
            </Button>
            <Button icon={<Plus />} onClick={() => setCreating(true)}>
              <span className="hidden sm:inline">New template</span>
            </Button>
          </>
        }
      />

      {templates.length === 0 ? (
        <EmptyState
          icon={<Repeat />}
          title="No recurring templates yet"
          description="Create one from an existing invoice to bill a customer weekly, monthly, quarterly or yearly."
          action={
            <Button icon={<Plus />} onClick={() => setCreating(true)}>
              New template
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3">
          {templates.map((t, i) => {
            const total = t.lines.reduce((s, l) => s + l.lineNetMinor + l.lineVatMinor, 0);
            const due = t.active && isDue(t.nextRunDate);
            return (
              <motion.div key={t.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }}>
                <Card>
                  <CardContent className="flex flex-wrap items-center gap-4 p-4">
                    <div className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <Repeat className="size-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate font-medium">{t.name}</p>
                        <Badge tone={t.active ? (due ? "gold" : "success") : "neutral"} size="sm" dot>
                          {t.active ? (due ? "Due now" : "Active") : "Paused"}
                        </Badge>
                        {t.autoSend && <Badge tone="info" size="sm">Auto-send</Badge>}
                      </div>
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        {t.buyer.nameEn || "Customer"} · {cadenceLabel(t.cadence)} · {formatMoney(total, t.currency)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        Next: {formatDate(t.nextRunDate)}
                        {t.generatedCount ? ` · ${t.generatedCount} generated` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch checked={t.active} onCheckedChange={(v) => toggleActive(t, v)} aria-label="Active" />
                      <Button size="sm" variant="outline" icon={<Play />} loading={busyId === t.id} onClick={() => generateNow(t)}>
                        Generate
                      </Button>
                      <Button size="sm" variant="ghost" icon={<Trash2 />} onClick={() => setDeleting(t)} aria-label="Delete" />
                    </div>
                  </CardContent>
                </Card>
              </motion.div>
            );
          })}
        </div>
      )}

      {/* New template */}
      <Modal open={creating} onClose={() => setCreating(false)} title="New recurring template" size="md">
        <div className="space-y-4 p-5 sm:p-6">
          <div>
            <label className="text-sm font-medium">Base it on an invoice</label>
            <select value={srcId} onChange={(e) => setSrcId(e.target.value)} className={inputCls}>
              <option value="">Select an invoice…</option>
              {invoices.slice(0, 50).map((inv: Invoice) => (
                <option key={inv.id} value={inv.id}>
                  {inv.number || "Draft"} — {inv.buyer.nameEn || "Customer"} ({formatMoney(inv.totals.taxInclusiveMinor, inv.currency)})
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-muted-foreground">Its buyer and line items become the template.</p>
          </div>
          <div>
            <label className="text-sm font-medium">Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Monthly retainer — Acme" className={inputCls} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium">Cadence</label>
              <select value={cadence} onChange={(e) => setCadence(e.target.value as RecurringCadence)} className={inputCls}>
                {CADENCES.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-sm font-medium">First run</label>
              <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className={inputCls} />
            </div>
          </div>
          <div className="flex items-center justify-between rounded-lg bg-muted/50 p-3">
            <div className="flex items-center gap-2 text-sm">
              <Zap className="size-4 text-info" /> Auto-send when generated
            </div>
            <Switch checked={autoSend} onCheckedChange={setAutoSend} />
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button onClick={create}>Create template</Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting) await deleteTemplate(deleting.id);
          toast.success("Template deleted");
          setDeleting(null);
        }}
        title="Delete this template?"
        description={`${deleting?.name} will stop generating invoices.`}
        confirmLabel="Delete"
        tone="destructive"
      />
    </div>
  );
}
