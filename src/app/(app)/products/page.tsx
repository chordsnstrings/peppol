"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { Plus, Search, Package, MoreHorizontal, Trash2, Pencil } from "lucide-react";
import { id as makeId } from "@/lib/utils";
import { formatMoney, parseMoneyToMinor, minorToMajor } from "@/lib/domain/money";
import { TAX_PROFILE_LIST, UNIT_CODES, getProfile } from "@/lib/domain/tax";
import { useAppState } from "@/lib/app-state";
import { useProducts } from "@/hooks/use-entity-data";
import { saveProduct } from "@/lib/db/repo";
import { remove } from "@/lib/db/database";
import type { Product, TaxProfileCode } from "@/lib/domain/types";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input, Field } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Pagination, usePagination } from "@/components/ui/pagination";
import { Modal, ConfirmDialog } from "@/components/ui/modal";
import { Dropdown, DropdownItem, DropdownTrigger } from "@/components/ui/dropdown";
import { toast } from "sonner";

export default function ProductsPage() {
  const { products, loading } = useProducts();
  const [q, setQ] = React.useState("");
  const [editing, setEditing] = React.useState<Product | null>(null);
  const [creating, setCreating] = React.useState(false);
  const [deleting, setDeleting] = React.useState<Product | null>(null);

  const filtered = products.filter(
    (p) => !q.trim() || p.nameEn.toLowerCase().includes(q.toLowerCase()) || (p.sku ?? "").includes(q),
  );
  const pg = usePagination(filtered, 10);
  React.useEffect(() => pg.setPage(1), [q]); // eslint-disable-line

  return (
    <div>
      <PageHeader
        title="Products & services"
        description="Optional — reusable items with a default price and tax treatment."
        icon={<Package />}
        actions={
          <Button icon={<Plus />} onClick={() => setCreating(true)}>
            New product
          </Button>
        }
      />

      {!loading && products.length === 0 ? (
        <EmptyState
          icon={<Package />}
          title="No products yet"
          description="Products are optional — you can type free-text lines on any invoice. Save one to reuse it."
          action={
            <Button icon={<Plus />} onClick={() => setCreating(true)}>
              Add product
            </Button>
          }
        />
      ) : (
        <>
          <div className="mb-4 w-full sm:w-72">
            <Input
              leading={<Search />}
              placeholder="Search products…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>

          <Card className="hidden overflow-hidden sm:block">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-3 ps-4 text-start font-medium">Product</th>
                  <th className="py-3 text-start font-medium">SKU</th>
                  <th className="py-3 text-start font-medium">Tax</th>
                  <th className="py-3 text-end font-medium">Price</th>
                  <th className="w-12 py-3 pe-4" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {pg.pageItems.map((p) => (
                  <tr key={p.id} className="group transition-colors hover:bg-accent/50">
                    <td className="py-3 ps-4">
                      <div className="flex items-center gap-2.5">
                        <div className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                          <Package className="size-4" />
                        </div>
                        <span className="font-medium">{p.nameEn}</span>
                      </div>
                    </td>
                    <td className="py-3 text-sm text-muted-foreground">{p.sku || "—"}</td>
                    <td className="py-3">
                      <Badge tone="neutral" size="sm">
                        {getProfile(p.taxProfileCode).ratePercent}% VAT
                      </Badge>
                    </td>
                    <td className="py-3 text-end font-semibold tnum">
                      {formatMoney(p.unitPriceMinor, p.currency)}
                    </td>
                    <td className="py-3 pe-4">
                      <RowMenu onEdit={() => setEditing(p)} onDelete={() => setDeleting(p)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <div className="space-y-2.5 sm:hidden">
            {pg.pageItems.map((p) => (
              <Card key={p.id} className="flex items-center gap-3 p-3.5">
                <div className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                  <Package className="size-5" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{p.nameEn}</p>
                  <p className="text-xs text-muted-foreground">
                    {getProfile(p.taxProfileCode).ratePercent}% VAT
                  </p>
                </div>
                <p className="font-semibold tnum">{formatMoney(p.unitPriceMinor, p.currency)}</p>
                <RowMenu onEdit={() => setEditing(p)} onDelete={() => setDeleting(p)} />
              </Card>
            ))}
          </div>

          <div className="mt-5">
            <Pagination
              page={pg.page}
              pageCount={pg.pageCount}
              onPage={pg.setPage}
              rangeStart={pg.rangeStart}
              rangeEnd={pg.rangeEnd}
              total={pg.total}
              itemLabel="products"
            />
          </div>
        </>
      )}

      <ProductModal
        open={creating || Boolean(editing)}
        product={editing}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
      />
      <ConfirmDialog
        open={Boolean(deleting)}
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting) await remove("products", deleting.id);
          toast.success("Product deleted");
          setDeleting(null);
        }}
        title="Delete product?"
        description={`${deleting?.nameEn} will be removed.`}
        confirmLabel="Delete"
        tone="destructive"
      />
    </div>
  );
}

function RowMenu({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) {
  return (
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
        <DropdownItem icon={<Pencil />} onSelect={onEdit}>
          Edit
        </DropdownItem>
        <DropdownItem icon={<Trash2 />} tone="destructive" onSelect={onDelete}>
          Delete
        </DropdownItem>
      </div>
    </Dropdown>
  );
}

function ProductModal({
  open,
  product,
  onClose,
}: {
  open: boolean;
  product: Product | null;
  onClose: () => void;
}) {
  const { currentEntity } = useAppState();
  const [name, setName] = React.useState("");
  const [sku, setSku] = React.useState("");
  const [price, setPrice] = React.useState("");
  const [unit, setUnit] = React.useState("C62");
  const [tax, setTax] = React.useState<TaxProfileCode>("STANDARD_5");
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setName(product?.nameEn ?? "");
      setSku(product?.sku ?? "");
      setPrice(product ? String(minorToMajor(product.unitPriceMinor)) : "");
      setUnit(product?.unitCode ?? "C62");
      setTax(product?.taxProfileCode ?? "STANDARD_5");
    }
  }, [open, product]);

  const submit = async () => {
    if (!currentEntity || !name.trim()) return;
    setSaving(true);
    const now = new Date().toISOString();
    const rec: Product = {
      id: product?.id ?? makeId("prd"),
      orgId: currentEntity.orgId,
      entityId: currentEntity.id,
      nameEn: name.trim(),
      sku: sku || undefined,
      unitCode: unit,
      unitPriceMinor: parseMoneyToMinor(price),
      currency: product?.currency ?? currentEntity.defaultCurrency,
      taxProfileCode: tax,
      createdAt: product?.createdAt ?? now,
      updatedAt: now,
    };
    await saveProduct(rec);
    setSaving(false);
    toast.success(product ? "Product updated" : "Product added");
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title={product ? "Edit product" : "New product"} size="md">
      <div className="space-y-4 p-5 sm:p-6">
        <Field label="Name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Consulting — hourly" autoFocus />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="SKU" hint="optional">
            <Input value={sku} onChange={(e) => setSku(e.target.value)} />
          </Field>
          <Field label="Unit price" required>
            <Input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.00" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Unit">
            <Select value={unit} onChange={(e) => setUnit(e.target.value)}>
              {UNIT_CODES.map((u) => (
                <option key={u.code} value={u.code}>
                  {u.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Tax treatment">
            <Select value={tax} onChange={(e) => setTax(e.target.value as TaxProfileCode)}>
              {TAX_PROFILE_LIST.map((p) => (
                <option key={p.code} value={p.code}>
                  {p.label}
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
            {product ? "Save changes" : "Add product"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
