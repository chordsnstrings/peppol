"use client";

import * as React from "react";
import { Search, Plus, Check, UserPlus, Building2, ChevronDown } from "lucide-react";
import { cn, id as makeId } from "@/lib/utils";
import { useAppState } from "@/lib/app-state";
import { useCustomers } from "@/hooks/use-entity-data";
import { saveCustomer } from "@/lib/db/repo";
import { derivePeppolId, EMIRATES, validateTRN } from "@/lib/domain/peppol";
import type { Customer, Party } from "@/lib/domain/types";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";

export function CustomerPicker({
  buyer,
  onSelect,
}: {
  buyer: Party;
  onSelect: (party: Party, customerId?: string) => void;
}) {
  const { customers } = useCustomers();
  const [open, setOpen] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [q, setQ] = React.useState("");

  const filtered = customers.filter(
    (c) =>
      !q.trim() ||
      c.displayName.toLowerCase().includes(q.toLowerCase()) ||
      (c.trn ?? "").includes(q),
  );

  const pick = (c: Customer) => {
    onSelect(
      {
        nameEn: c.displayName,
        nameAr: c.legalNameAr,
        trn: c.trn,
        tin: c.tin,
        peppolId: c.peppolId,
        address: c.address,
        email: c.emails?.[0],
        phone: c.phone,
      },
      c.id,
    );
    setOpen(false);
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={cn(
          "flex w-full items-center gap-3 rounded-xl border p-3 text-start transition-colors",
          buyer.nameEn ? "border-border bg-card hover:bg-accent/50" : "border-dashed border-border hover:border-muted-foreground/40",
        )}
      >
        {buyer.nameEn ? (
          <>
            <Avatar name={buyer.nameEn} size={40} rounded="lg" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">{buyer.nameEn}</p>
              <p className="truncate text-xs text-muted-foreground">
                {buyer.trn ? `TRN ${buyer.trn}` : "No TRN"}
                {buyer.peppolId ? ` · ${buyer.peppolId}` : ""}
              </p>
            </div>
            <ChevronDown className="size-4 text-muted-foreground" />
          </>
        ) : (
          <>
            <div className="flex size-10 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <UserPlus className="size-5" />
            </div>
            <span className="flex-1 text-sm font-medium text-muted-foreground">
              Select or create a customer
            </span>
            <ChevronDown className="size-4 text-muted-foreground" />
          </>
        )}
      </button>

      <Modal
        open={open}
        onClose={() => {
          setOpen(false);
          setCreating(false);
        }}
        title={creating ? "New customer" : "Select customer"}
        size="md"
      >
        {creating ? (
          <CreateCustomerForm
            onCancel={() => setCreating(false)}
            onCreated={(c) => {
              pick(c);
              setCreating(false);
            }}
          />
        ) : (
          <div className="p-4 sm:p-5">
            <Input
              leading={<Search />}
              placeholder="Search customers…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              autoFocus
            />
            <div className="mt-3 max-h-[40vh] space-y-1 overflow-y-auto">
              {filtered.map((c) => (
                <button
                  key={c.id}
                  onClick={() => pick(c)}
                  className="flex w-full items-center gap-3 rounded-lg p-2.5 text-start transition-colors hover:bg-accent"
                >
                  <Avatar name={c.displayName} size={36} rounded="lg" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{c.displayName}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {c.trn ? `TRN ${c.trn}` : "No TRN"}
                    </p>
                  </div>
                  {c.participantStatus === "LOOKUP_OK" && (
                    <Badge tone="success" size="sm" dot>
                      On network
                    </Badge>
                  )}
                  {buyer.trn && buyer.trn === c.trn && <Check className="size-4 text-gold" />}
                </button>
              ))}
              {filtered.length === 0 && (
                <div className="py-8 text-center text-sm text-muted-foreground">
                  {customers.length === 0 ? "No customers yet." : "No matches."}
                </div>
              )}
            </div>
            <div className="mt-3 border-t border-border pt-3">
              <Button variant="outline" className="w-full" icon={<Plus />} onClick={() => setCreating(true)}>
                Create new customer
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </>
  );
}

function CreateCustomerForm({
  onCreated,
  onCancel,
}: {
  onCreated: (c: Customer) => void;
  onCancel: () => void;
}) {
  const { currentEntity } = useAppState();
  const [name, setName] = React.useState("");
  const [trn, setTrn] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [emirate, setEmirate] = React.useState("DU");
  const [saving, setSaving] = React.useState(false);
  const trnCheck = validateTRN(trn);

  const submit = async () => {
    if (!currentEntity || !name.trim()) return;
    setSaving(true);
    const now = new Date().toISOString();
    const customer: Customer = {
      id: makeId("cus"),
      orgId: currentEntity.orgId,
      entityId: currentEntity.id,
      displayName: name.trim(),
      trn: trnCheck.ok ? trnCheck.cleaned : trn.replace(/\s/g, "") || undefined,
      peppolId: trnCheck.ok ? derivePeppolId(trnCheck.cleaned) : undefined,
      participantStatus: trnCheck.ok ? "LOOKUP_OK" : "UNKNOWN",
      address: { emirate, country: "AE" },
      emails: email ? [email] : undefined,
      defaultCurrency: "AED",
      createdAt: now,
      updatedAt: now,
    };
    await saveCustomer(customer);
    setSaving(false);
    onCreated(customer);
  };

  return (
    <div className="space-y-4 p-4 sm:p-5">
      <Field label="Customer name" required>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme LLC" autoFocus />
      </Field>
      <Field
        label="TRN"
        hint="optional"
        help={trn && !trnCheck.ok ? trnCheck.message : "We'll derive their Peppol ID automatically."}
      >
        <Input
          inputMode="numeric"
          value={trn}
          onChange={(e) => setTrn(e.target.value)}
          placeholder="15-digit TRN"
          trailing={trnCheck.ok ? <Check className="text-success" /> : undefined}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Email" hint="optional">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="ap@acme.ae" />
        </Field>
        <Field label="Emirate">
          <Select value={emirate} onChange={(e) => setEmirate(e.target.value)}>
            {EMIRATES.map((em) => (
              <option key={em.code} value={em.code}>
                {em.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={onCancel}>
          Back
        </Button>
        <Button onClick={submit} loading={saving} disabled={!name.trim()} icon={<Building2 />}>
          Create & select
        </Button>
      </div>
    </div>
  );
}
