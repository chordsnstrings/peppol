"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Building2, Check, BadgeCheck } from "lucide-react";
import { useAppState } from "@/lib/app-state";
import { createEntity } from "@/lib/db/repo";
import { metaSet } from "@/lib/db/database";
import { derivePeppolId, EMIRATES, validateTRN } from "@/lib/domain/peppol";
import { PageHeader } from "@/components/shell/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Segmented } from "@/components/ui/controls";
import { toast } from "sonner";

export default function NewEntityPage() {
  const router = useRouter();
  const { org, setCurrentEntityId, refresh } = useAppState();
  const [legalNameEn, setName] = React.useState("");
  const [vatRegistered, setVat] = React.useState(true);
  const [trn, setTrn] = React.useState("");
  const [tin, setTin] = React.useState("");
  const [emirate, setEmirate] = React.useState("DU");
  const [saving, setSaving] = React.useState(false);

  const trnCheck = validateTRN(trn);
  const taxId = vatRegistered ? trn : tin;
  const peppolId = derivePeppolId(taxId);
  const canSave = legalNameEn.trim().length > 1 && (vatRegistered ? trnCheck.ok : tin.length >= 10);

  const save = async () => {
    if (!org) return;
    setSaving(true);
    const entity = await createEntity(org.id, {
      legalNameEn,
      trn: vatRegistered ? trnCheck.cleaned : undefined,
      tin: !vatRegistered ? tin : undefined,
      vatRegistered,
      emirate,
      defaultCurrency: "AED",
    });
    await setCurrentEntityId(entity.id);
    await metaSet("currentEntityId", entity.id);
    await refresh();
    toast.success("Entity created", { description: `${legalNameEn} is ready in sandbox.` });
    router.push("/dashboard");
  };

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader
        breadcrumb={[{ label: "Settings", href: "/settings" }, { label: "New entity" }]}
        title="Add an entity"
        description="A legal taxpayer under your organization."
        icon={<Building2 />}
      />
      <Card>
        <CardContent className="space-y-4 p-5 sm:p-6">
          <Field label="Legal name (English)" required>
            <Input value={legalNameEn} onChange={(e) => setName(e.target.value)} placeholder="Second Entity LLC" autoFocus />
          </Field>
          <Field label="VAT registered?">
            <Segmented
              value={vatRegistered ? "yes" : "no"}
              onChange={(v) => setVat(v === "yes")}
              options={[
                { value: "yes", label: "Yes (TRN)" },
                { value: "no", label: "No (TIN)" },
              ]}
            />
          </Field>
          {vatRegistered ? (
            <Field label="TRN" required help={trn && !trnCheck.ok ? trnCheck.message : "15-digit VAT number."}>
              <Input
                inputMode="numeric"
                value={trn}
                onChange={(e) => setTrn(e.target.value)}
                placeholder="15-digit TRN"
                trailing={trnCheck.ok ? <Check className="text-success" /> : undefined}
              />
            </Field>
          ) : (
            <Field label="TIN" required>
              <Input inputMode="numeric" value={tin} onChange={(e) => setTin(e.target.value)} placeholder="10-digit TIN" />
            </Field>
          )}
          <Field label="Emirate">
            <Select value={emirate} onChange={(e) => setEmirate(e.target.value)}>
              {EMIRATES.map((em) => (
                <option key={em.code} value={em.code}>
                  {em.name}
                </option>
              ))}
            </Select>
          </Field>

          {peppolId && (
            <div className="flex items-center gap-3 rounded-xl border border-gold/25 bg-gold/[0.06] p-3">
              <BadgeCheck className="size-5 text-[hsl(var(--gold))]" />
              <div>
                <p className="text-xs text-muted-foreground">Peppol ID</p>
                <p className="font-mono text-sm font-semibold">{peppolId}</p>
              </div>
            </div>
          )}

          <div className="flex justify-between pt-1">
            <Button variant="ghost" icon={<ArrowLeft className="rtl:rotate-180" />} onClick={() => router.back()}>
              Cancel
            </Button>
            <Button onClick={save} loading={saving} disabled={!canSave}>
              Create entity
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
