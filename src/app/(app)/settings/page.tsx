"use client";

import * as React from "react";
import { Building2, BadgeCheck, Hash, AlertTriangle, Save, Trash2, Download } from "lucide-react";
import { useAppState } from "@/lib/app-state";
import { saveEntity } from "@/lib/db/repo";
import { resetWorkspace } from "@/lib/db/database";
import { downloadText } from "@/lib/domain/ubl";
import { derivePeppolId, EMIRATES, validateTRN } from "@/lib/domain/peppol";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ConfirmDialog } from "@/components/ui/modal";
import { toast } from "sonner";

export default function EntitySettingsPage() {
  const { currentEntity, refresh } = useAppState();
  const [form, setForm] = React.useState(currentEntity);
  const [saving, setSaving] = React.useState(false);
  const [exporting, setExporting] = React.useState(false);
  const [confirmReset, setConfirmReset] = React.useState(false);

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
          <div className="flex items-center gap-2 sm:col-span-2">
            <span className="text-sm text-muted-foreground">Status:</span>
            <Badge tone={form.einvoicingStatus === "LIVE" ? "success" : "gold"} dot>
              {form.einvoicingStatus === "LIVE" ? "Live" : "Sandbox"}
            </Badge>
          </div>
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
              Permanently deletes all local data on this device and restarts onboarding.
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
        onConfirm={async () => {
          await resetWorkspace();
          window.location.href = "/onboarding";
        }}
        title="Reset the entire workspace?"
        description="Every entity, customer, product and invoice on this device will be deleted. This cannot be undone."
        confirmLabel="Delete everything"
        tone="destructive"
      />
    </div>
  );
}
