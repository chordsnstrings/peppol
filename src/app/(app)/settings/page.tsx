"use client";

import * as React from "react";
import { Building2, BadgeCheck, Hash, AlertTriangle, Save, Trash2, Download } from "lucide-react";
import { useAppState } from "@/lib/app-state";
import { saveEntity } from "@/lib/db/repo";
import { downloadText } from "@/lib/domain/ubl";
import { derivePeppolId, EMIRATES, validateTRN } from "@/lib/domain/peppol";
import { useGatewayMode } from "@/lib/gateway/mode";
import { LIVE_ENTITY_ON_SIMULATOR, SIMULATED_ACTIVATION_BLOCK } from "@/lib/gateway/disclosure";
import { RECORD_RETENTION } from "@/lib/gateway/retention";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/controls";
import { Field, Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/modal";
import { toast } from "sonner";

export default function EntitySettingsPage() {
  const { currentEntity, refresh } = useAppState();
  const gateway = useGatewayMode();
  const [form, setForm] = React.useState(currentEntity);
  const [saving, setSaving] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const [confirmReset, setConfirmReset] = React.useState(false);
  const [destroyArchive, setDestroyArchive] = React.useState(false);
  const [resetting, setResetting] = React.useState(false);

  /*
   * Posted here rather than through `resetWorkspace()` because the reset route
   * now needs a body: without the acknowledgement it keeps every transmitted
   * document still inside its retention window, and the tick box below is the
   * only place a person can say they mean to destroy those too.
   */
  const resetEverything = async () => {
    setResetting(true);
    try {
      const res = await fetch("/api/account/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ acknowledgeRecordDestruction: destroyArchive }),
      });
      if (!res.ok) throw new Error();
      window.location.href = "/onboarding";
    } catch {
      setResetting(false);
      toast.error("Reset failed", { description: "Reload the page to see what the workspace holds now." });
    }
  };

  const exportData = async () => {
    setExporting(true);
    try {
      const res = await fetch("/api/account/export");
      if (!res.ok) throw new Error();
      const data = await res.json();
      downloadText(
        `arks-export-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(data, null, 2),
        "application/json",
      );
      toast.success("Data exported", { description: "All records + UBL/TDD documents." });
    } catch {
      toast.error("Export failed");
    }
    setExporting(false);
  };

  React.useEffect(() => setForm(currentEntity), [currentEntity]);

  if (!form) return null;
  const set = (patch: Partial<typeof form>) => setForm({ ...form, ...patch });
  const trnCheck = form.trn ? validateTRN(form.trn) : null;

  const save = async () => {
    setSaving(true);
    await saveEntity({
      ...form,
      peppolParticipantId: derivePeppolId(form.vatRegistered ? form.trn : form.tin),
    });
    await refresh();
    setSaving(false);
    toast.success("Entity saved");
  };

  return (
    <div className="max-w-3xl space-y-5">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Building2 className="size-4" /> Business details
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Legal name (English)" required className="sm:col-span-2">
            <Input value={form.legalNameEn} onChange={(e) => set({ legalNameEn: e.target.value })} />
          </Field>
          <Field label="Legal name (Arabic)">
            <Input dir="rtl" value={form.legalNameAr ?? ""} onChange={(e) => set({ legalNameAr: e.target.value })} />
          </Field>
          <Field label="Trade licence no.">
            <Input value={form.tradeLicenseNo ?? ""} onChange={(e) => set({ tradeLicenseNo: e.target.value })} />
          </Field>
          <Field label="Emirate">
            <Select value={form.address?.emirate ?? "DU"} onChange={(e) => set({ address: { ...form.address, emirate: e.target.value, country: "AE" } })}>
              {EMIRATES.map((em) => (
                <option key={em.code} value={em.code}>
                  {em.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Default currency">
            <Select value={form.defaultCurrency} onChange={(e) => set({ defaultCurrency: e.target.value })}>
              {["AED", "USD", "EUR", "GBP", "SAR"].map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <BadgeCheck className="size-4" /> Tax identity
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="TRN" help={trnCheck && !trnCheck.ok ? trnCheck.message : "15-digit VAT registration number."}>
            <Input value={form.trn ?? ""} onChange={(e) => set({ trn: e.target.value })} inputMode="numeric" />
          </Field>
          <Field label="Peppol participant ID">
            <div className="flex h-10 items-center rounded-lg border border-border bg-muted px-3 font-mono text-sm">
              {derivePeppolId(form.vatRegistered ? form.trn : form.tin) ?? "—"}
            </div>
          </Field>
          {/*
            * Two separate facts, shown separately because they can disagree and
            * the disagreement is the dangerous state: the first is what this
            * entity is activated for, the second is what the deployment's
            * gateway can actually do. A single "Live" badge over a simulated
            * gateway is the badge that made this product dishonest.
            */}
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
            <span className="text-sm text-muted-foreground">Status:</span>
            <Badge tone={form.einvoicingStatus === "LIVE" ? "success" : "gold"} dot>
              {form.einvoicingStatus === "LIVE" ? "Live" : "Sandbox"}
            </Badge>
            <span className="ms-2 text-sm text-muted-foreground">Transmission:</span>
            <Badge tone={!gateway.known ? "neutral" : gateway.simulated ? "warning" : "success"} dot>
              {!gateway.known ? "Checking…" : gateway.simulated ? "Simulated" : `Live via ${gateway.driver}`}
            </Badge>
          </div>
          {gateway.known && gateway.simulated && (
            <div className="flex items-start gap-2.5 rounded-lg border border-warning/25 bg-warning/[0.06] p-3 text-sm sm:col-span-2">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
              <span className="text-muted-foreground">
                <span className="font-medium text-foreground">
                  {form.einvoicingStatus === "LIVE" ? "Sends are refused." : "Sandbox only."}
                </span>{" "}
                {form.einvoicingStatus === "LIVE" ? LIVE_ENTITY_ON_SIMULATOR : SIMULATED_ACTIVATION_BLOCK}
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Hash className="size-4" /> Invoice numbering
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <Field label="Prefix" help="e.g. INV- → INV-2026-00001">
            <Input value={form.numberingPrefix} onChange={(e) => set({ numberingPrefix: e.target.value })} />
          </Field>
          <Field label="Next sequence">
            <Input
              type="number"
              value={form.numberingSeq + 1}
              onChange={(e) => set({ numberingSeq: Math.max(0, Number(e.target.value) - 1) })}
            />
          </Field>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button icon={<Save />} loading={saving} onClick={save}>
          Save changes
        </Button>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Download className="size-4" /> Your data &amp; records
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
          <div>
            <p className="text-sm font-medium">Export everything</p>
            <p className="text-sm text-muted-foreground">
              Download all your invoices, customers, products and the underlying UBL + Tax Data
              Documents. Your statutory records are always yours to keep.
            </p>
          </div>
          <Button variant="outline" icon={<Download />} onClick={exportData} loading={exporting}>
            Export data
          </Button>
        </CardContent>
      </Card>

      <Card className="border-destructive/30">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base text-destructive">
            <AlertTriangle className="size-4" /> Danger zone
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
          <div>
            <p className="text-sm font-medium">Reset this workspace</p>
            <p className="text-sm text-muted-foreground">
              Deletes every entity, customer, product and invoice in this workspace — on the server,
              for everyone who uses it — and restarts onboarding. The documents already transmitted
              are kept for their {RECORD_RETENTION.years}-year retention unless you say otherwise.
            </p>
          </div>
          <Button variant="destructive" icon={<Trash2 />} onClick={() => setConfirmReset(true)}>
            Reset workspace
          </Button>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmReset}
        onClose={() => setConfirmReset(false)}
        onConfirm={resetEverything}
        loading={resetting}
        title="Reset the entire workspace?"
        description={
          <div className="space-y-3">
            <p>
              Every entity, customer, product and invoice in this workspace will be deleted. This
              cannot be undone.
            </p>
            <p>
              The documents behind sent invoices — the PINT AE UBL and the Tax Data Document — are
              kept unless you tick the box below: {RECORD_RETENTION.basis} requires them for{" "}
              {RECORD_RETENTION.years} years and nothing here can rebuild them. They stay available
              from Export data afterwards.
            </p>
            <div className="flex items-start gap-2.5 rounded-lg border border-destructive/25 bg-destructive/[0.06] p-3">
              <Checkbox id="destroy-archive" checked={destroyArchive} onCheckedChange={setDestroyArchive} />
              <label htmlFor="destroy-archive" className="text-sm text-muted-foreground">
                Delete those too. I am destroying statutory records inside the{" "}
                {RECORD_RETENTION.years}-year retention window.
              </label>
            </div>
          </div>
        }
        confirmLabel="Delete everything"
        tone="destructive"
      />
    </div>
  );
}
