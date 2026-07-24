"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { Plus, Search, Users, MoreHorizontal, Trash2, Pencil, Check, FileText } from "lucide-react";
import { cn, id as makeId, timeAgo } from "@/lib/utils";
import { useAppState } from "@/lib/app-state";
import { useCustomers } from "@/hooks/use-entity-data";
import { saveCustomer } from "@/lib/db/repo";
import { remove } from "@/lib/db/database";
import { derivePeppolId, EMIRATES, validateTRN } from "@/lib/domain/peppol";
import type { Customer } from "@/lib/domain/types";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Field } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Pagination, usePagination } from "@/components/ui/pagination";
import { Modal, ConfirmDialog } from "@/components/ui/modal";
import { Dropdown, DropdownItem, DropdownTrigger } from "@/components/ui/dropdown";
import { toast } from "sonner";

const PARTICIPANT_TONE = {
  LOOKUP_OK: { tone: "success" as const, label: "On network" },
  UNKNOWN: { tone: "neutral" as const, label: "Not checked" },
  NOT_ON_NETWORK: { tone: "warning" as const, label: "Not on network" },
  LOOKUP_FAILED: { tone: "error" as const, label: "Lookup failed" },
};

export default function CustomersPage() {
  const { customers, loading } = useCustomers();
  const [q, setQ] = React.useState("");
  const [editing, setEditing] = React.useState<Customer | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [deleting, setDeleting] = React.useState<Customer | null>(null);

  const filtered = customers.filter(
    (c) =>
      !q.trim() ||
      c.displayName.toLowerCase().includes(q.toLowerCase()) ||
      (c.trn ?? "").includes(q),
  );
  const pg = usePagination(filtered, 12);
  React.useEffect(() => pg.setPage(1), [q]); // eslint-disable-line

  return (
    <div>
      <PageHeader
        title="Customers"
        description="Your buyers. Master data builds itself as you invoice."
        icon={<Users />}
        actions={
          <Button icon={<Plus />} onClick={() => setCreating(true)}>
            New customer
          </Button>
        }
      />

      {!loading && customers.length === 0 ? (
        <EmptyState
          icon={<Users />}
          title="No customers yet"
          description="Add a customer here, or just create an invoice — we'll capture new buyers automatically."
          action={
            <Button icon={<Plus />} onClick={() => setCreating(true)}>
              Add customer
            </Button>
          }
        />
      ) : (
        <>
          <div className="mb-4 w-full sm:w-72">
            <Input
              leading={<Search />}
              placeholder="Search name or TRN…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {pg.pageItems.map((c, i) => {
              const ps = PARTICIPANT_TONE[c.participantStatus];
              return (
                <motion.div
                  key={c.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.03 }}
                >
                  <Card className="group flex items-start gap-3 p-4 hover-lift">
                    <Avatar name={c.displayName} size={44} rounded="lg" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{c.displayName}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {c.trn ? `TRN ${c.trn}` : "No TRN"}
                      </p>
                      <div className="mt-2 flex items-center gap-2">
                        <Badge tone={ps.tone} size="sm" dot>
                          {ps.label}
                        </Badge>
                      </div>
                    </div>
                    <Dropdown align="end">
                      <DropdownTrigger>
                        <button
                          className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent focus-ring"
                          aria-label="Actions"
                        >
                          <MoreHorizontal className="size-4" />
                        </button>
                      </DropdownTrigger>
                      <div className="w-40">
                        <DropdownItem icon={<Pencil />} onSelect={() => setEditing(c)}>
                          Edit
                        </DropdownItem>
                        <DropdownItem icon={<Trash2 />} tone="destructive" onSelect={() => setDeleting(c)}>
                          Delete
                        </DropdownItem>
                      </div>
                    </Dropdown>
                  </Card>
                </motion.div>
              );
            })}
          </div>

          <div className="mt-5">
            <Pagination
              page={pg.page}
              pageCount={pg.pageCount}
              onPage={pg.setPage}
              rangeStart={pg.rangeStart}
              rangeEnd={pg.rangeEnd}
              total={pg.total}
              itemLabel="customers"
            />
          </div>
        </>
      )}

      <CustomerModal
        open={creating || Boolean(editing)}
        customer={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />
      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting) await remove("customers", deleting.id);
          toast.success("Customer deleted");
          setDeleting(null);
        }}
        title="Delete customer?"
        description={`${deleting?.displayName} will be removed. Existing invoices keep their details.`}
        confirmLabel="Delete"
        tone="destructive"
      />
    </div>
  );
}

function CustomerModal({
  open,
  customer,
  onClose,
}: {
  open: boolean;
  customer: Customer | null;
  onClose: () => void;
}) {
  const { currentEntity } = useAppState();
  const [name, setName] = React.useState("");
  const [trn, setTrn] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [emirate, setEmirate] = React.useState("DU");
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setName(customer?.displayName ?? "");
      setTrn(customer?.trn ?? "");
      setEmail(customer?.emails?.[0] ?? "");
      setEmirate(customer?.address?.emirate ?? "DU");
    }
  }, [open, customer]);

  const trnCheck = validateTRN(trn);

  const submit = async () => {
    if (!currentEntity || !name.trim()) return;
    setSaving(true);
    const now = new Date().toISOString();
    const rec: Customer = {
      id: customer?.id ?? makeId("cus"),
      orgId: currentEntity.orgId,
      entityId: currentEntity.id,
      displayName: name.trim(),
      trn: trnCheck.ok ? trnCheck.cleaned : trn.replace(/\s/g, "") || undefined,
      peppolId: trnCheck.ok ? derivePeppolId(trnCheck.cleaned) : undefined,
      participantStatus: trnCheck.ok ? "LOOKUP_OK" : "UNKNOWN",
      address: { emirate, country: "AE" },
      emails: email ? [email] : undefined,
      defaultCurrency: customer?.defaultCurrency ?? "AED",
      createdAt: customer?.createdAt ?? now,
      updatedAt: now,
    };
    await saveCustomer(rec);
    setSaving(false);
    toast.success(customer ? "Customer updated" : "Customer added");
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={customer ? "Edit customer" : "New customer"} size="md">
      <div className="space-y-4 p-5 sm:p-6">
        <Field label="Customer name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme LLC" autoFocus />
        </Field>
        <Field
          label="TRN"
          hint="optional"
          help={trn && !trnCheck.ok ? trnCheck.message : "We derive their Peppol ID automatically."}
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
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
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
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={saving} disabled={!name.trim()}>
            {customer ? "Save changes" : "Add customer"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
