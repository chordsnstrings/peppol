"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion } from "framer-motion";
import {
  Plus,
  Upload,
  Search,
  FileText,
  Send,
  Download,
  MoreHorizontal,
  Trash2,
  Copy,
  Eye,
} from "lucide-react";
import { cn, formatDate } from "@/lib/utils";
import { formatMoney } from "@/lib/domain/money";
import { DOC_TYPE_LABEL } from "@/lib/domain/tax";
import { useAppState } from "@/lib/app-state";
import { useInvoices } from "@/hooks/use-entity-data";
import { deleteInvoice, sendInvoice } from "@/lib/db/repo";
import type { Invoice, LifecycleStatus } from "@/lib/domain/types";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/controls";
import { EmptyState } from "@/components/ui/empty-state";
import { Pagination, usePagination } from "@/components/ui/pagination";
import { Skeleton } from "@/components/ui/feedback";
import { InvoiceStatus } from "@/components/invoice/status";
import { Dropdown, DropdownItem, DropdownSeparator, DropdownTrigger } from "@/components/ui/dropdown";
import { ConfirmDialog } from "@/components/ui/modal";
import { toast } from "sonner";

type Filter = "all" | "draft" | "transit" | "completed" | "attention";

const FILTERS: { key: Filter; label: string; match: (s: LifecycleStatus) => boolean }[] = [
  { key: "all", label: "All", match: () => true },
  { key: "draft", label: "Drafts", match: (s) => s === "DRAFT" || s === "READY" },
  {
    key: "transit",
    label: "In transit",
    match: (s) => ["QUEUED", "SENDING", "SENT", "DELIVERED"].includes(s),
  },
  { key: "completed", label: "Completed", match: (s) => s === "COMPLETED" },
  { key: "attention", label: "Needs attention", match: (s) => s === "FAILED" },
];

export default function InvoicesPage() {
  const { currentEntity } = useAppState();
  const { invoices, loading } = useInvoices((i) => i.direction === "OUTBOUND");
  const router = useRouter();
  const [filter, setFilter] = React.useState<Filter>("all");
  const [q, setQ] = React.useState("");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState<Invoice | null>(null);

  const filtered = React.useMemo(() => {
    const f = FILTERS.find((x) => x.key === filter)!;
    const query = q.trim().toLowerCase();
    return invoices.filter(
      (i) =>
        f.match(i.lifecycleStatus) &&
        (!query ||
          i.number.toLowerCase().includes(query) ||
          i.buyer.nameEn.toLowerCase().includes(query)),
    );
  }, [invoices, filter, q]);

  const pg = usePagination(filtered, 10);

  React.useEffect(() => {
    pg.setPage(1);
    setSelected(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, q]);

  const counts = React.useMemo(() => {
    const c: Record<Filter, number> = { all: 0, draft: 0, transit: 0, completed: 0, attention: 0 };
    for (const i of invoices) {
      for (const f of FILTERS) if (f.match(i.lifecycleStatus)) c[f.key]++;
    }
    return c;
  }, [invoices]);

  const pageIds = pg.pageItems.map((i) => i.id);
  const allSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const sendable = pg.pageItems.filter(
    (i) => selected.has(i.id) && (i.lifecycleStatus === "DRAFT" || i.lifecycleStatus === "READY"),
  );

  const toggleAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) pageIds.forEach((id) => next.delete(id));
      else pageIds.forEach((id) => next.add(id));
      return next;
    });
  };
  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const bulkSend = async () => {
    if (!currentEntity || sendable.length === 0) return;
    setBusy(true);
    let ok = 0;
    for (const inv of sendable) {
      try {
        await sendInvoice(inv, currentEntity);
        ok++;
      } catch {
        /* validation blocked — surfaced in fix-it */
      }
    }
    setBusy(false);
    setSelected(new Set());
    if (ok > 0) toast.success(`${ok} invoice${ok > 1 ? "s" : ""} sent`, { description: "Delivered and reported in sandbox." });
    if (ok < sendable.length)
      toast.warning(`${sendable.length - ok} couldn't be sent`, { description: "They have issues — see the fix-it queue." });
  };

  if (loading) return <ListSkeleton />;

  return (
    <div>
      <PageHeader
        title="Invoices"
        description="Everything you've issued, with live exchange and reporting status."
        actions={
          <>
            <Button variant="outline" icon={<Upload />} onClick={() => router.push("/uploads")}>
              <span className="hidden sm:inline">Import</span>
            </Button>
            <Button icon={<Plus />} onClick={() => router.push("/invoices/new")}>
              New invoice
            </Button>
          </>
        }
      />

      {invoices.length === 0 ? (
        <EmptyState
          icon={<FileText />}
          title="No invoices yet"
          description="Create your first compliant invoice, or import a spreadsheet to bring in many at once."
          action={
            <Button icon={<Plus />} onClick={() => router.push("/invoices/new")}>
              Create invoice
            </Button>
          }
          secondaryAction={
            <Button variant="outline" icon={<Upload />} onClick={() => router.push("/uploads")}>
              Import spreadsheet
            </Button>
          }
        />
      ) : (
        <>
          {/* Toolbar */}
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="no-scrollbar -mx-1 flex items-center gap-1.5 overflow-x-auto px-1">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  onClick={() => setFilter(f.key)}
                  className={cn(
                    "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
                    filter === f.key
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border bg-card text-muted-foreground hover:text-foreground",
                  )}
                >
                  {f.label}
                  <span
                    className={cn(
                      "rounded-full px-1.5 text-xs tnum",
                      filter === f.key ? "bg-white/20" : "bg-muted",
                    )}
                  >
                    {counts[f.key]}
                  </span>
                </button>
              ))}
            </div>
            <div className="w-full sm:w-64">
              <Input
                leading={<Search />}
                placeholder="Search number or customer…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
          </div>

          {/* Bulk bar */}
          <motion.div
            initial={false}
            animate={{ height: selected.size > 0 ? "auto" : 0, opacity: selected.size > 0 ? 1 : 0 }}
            className="overflow-hidden"
          >
            {selected.size > 0 && (
              <div className="mb-3 flex flex-wrap items-center gap-3 rounded-xl border border-gold/25 bg-gold/[0.06] px-4 py-2.5">
                <span className="text-sm font-medium">{selected.size} selected</span>
                <div className="flex-1" />
                <Button
                  size="sm"
                  variant="gold"
                  icon={<Send />}
                  loading={busy}
                  disabled={sendable.length === 0}
                  onClick={bulkSend}
                >
                  Send {sendable.length > 0 ? sendable.length : ""}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                  Clear
                </Button>
              </div>
            )}
          </motion.div>

          {/* Table (desktop) */}
          <Card className="hidden overflow-hidden md:block">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="w-10 py-3 ps-4">
                    <Checkbox checked={allSelected} onCheckedChange={toggleAll} />
                  </th>
                  <th className="py-3 text-start font-medium">Invoice</th>
                  <th className="py-3 text-start font-medium">Customer</th>
                  <th className="py-3 text-start font-medium">Issue date</th>
                  <th className="py-3 text-start font-medium">Status</th>
                  <th className="py-3 text-end font-medium">Amount</th>
                  <th className="w-12 py-3 pe-4" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {pg.pageItems.map((inv, idx) => (
                  <motion.tr
                    key={inv.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: idx * 0.02 }}
                    className={cn(
                      "group cursor-pointer transition-colors hover:bg-accent/50",
                      selected.has(inv.id) && "bg-gold/[0.04]",
                    )}
                    onClick={() => router.push(`/invoices/${inv.id}`)}
                  >
                    <td className="py-3 ps-4" onClick={(e) => e.stopPropagation()}>
                      <Checkbox checked={selected.has(inv.id)} onCheckedChange={() => toggleOne(inv.id)} />
                    </td>
                    <td className="py-3">
                      <div className="flex items-center gap-2.5">
                        <div className="flex size-8 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                          <FileText className="size-4" />
                        </div>
                        <div>
                          <p className="text-sm font-medium">{inv.number || "Untitled draft"}</p>
                          <p className="text-xs text-muted-foreground">{DOC_TYPE_LABEL[inv.docType]}</p>
                        </div>
                      </div>
                    </td>
                    <td className="py-3">
                      <p className="max-w-[180px] truncate text-sm">{inv.buyer.nameEn || "—"}</p>
                    </td>
                    <td className="py-3 text-sm text-muted-foreground tnum">
                      {formatDate(inv.issueDate)}
                    </td>
                    <td className="py-3">
                      <InvoiceStatus invoice={inv} size="sm" />
                    </td>
                    <td className="py-3 text-end text-sm font-semibold tnum">
                      {formatMoney(inv.totals.taxInclusiveMinor, inv.currency)}
                    </td>
                    <td className="py-3 pe-4" onClick={(e) => e.stopPropagation()}>
                      <RowMenu inv={inv} onDelete={() => setConfirmDelete(inv)} />
                    </td>
                  </motion.tr>
                ))}
              </tbody>
            </table>
          </Card>

          {/* Cards (mobile) */}
          <div className="space-y-2.5 md:hidden">
            {pg.pageItems.map((inv) => (
              <Link key={inv.id} href={`/invoices/${inv.id}`}>
                <Card className="flex items-center gap-3 p-3.5 active:scale-[0.99]">
                  <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                    <FileText className="size-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-semibold">{inv.number || "Untitled"}</p>
                      <p className="shrink-0 text-sm font-semibold tnum">
                        {formatMoney(inv.totals.taxInclusiveMinor, inv.currency)}
                      </p>
                    </div>
                    <div className="mt-1 flex items-center justify-between gap-2">
                      <p className="truncate text-xs text-muted-foreground">
                        {inv.buyer.nameEn || "No customer"}
                      </p>
                      <InvoiceStatus invoice={inv} size="sm" />
                    </div>
                  </div>
                </Card>
              </Link>
            ))}
          </div>

          {filtered.length === 0 && (
            <div className="py-12 text-center text-sm text-muted-foreground">
              No invoices match your filters.
            </div>
          )}

          <div className="mt-5">
            <Pagination
              page={pg.page}
              pageCount={pg.pageCount}
              onPage={pg.setPage}
              pageSize={pg.pageSize}
              onPageSize={pg.setPageSize}
              rangeStart={pg.rangeStart}
              rangeEnd={pg.rangeEnd}
              total={pg.total}
              itemLabel="invoices"
            />
          </div>
        </>
      )}

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        onClose={() => setConfirmDelete(null)}
        onConfirm={async () => {
          if (confirmDelete) {
            await deleteInvoice(confirmDelete.id);
            toast.success("Draft deleted");
          }
          setConfirmDelete(null);
        }}
        title="Delete this draft?"
        description={
          <>
            <span className="font-medium text-foreground">{confirmDelete?.number || "This draft"}</span>{" "}
            will be permanently removed. This can't be undone.
          </>
        }
        confirmLabel="Delete draft"
        tone="destructive"
      />
    </div>
  );
}

function RowMenu({ inv, onDelete }: { inv: Invoice; onDelete: () => void }) {
  const router = useRouter();
  return (
    <Dropdown align="end">
      <DropdownTrigger>
        <button
          className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-ring group-hover:opacity-100"
          aria-label="Actions"
        >
          <MoreHorizontal className="size-4" />
        </button>
      </DropdownTrigger>
      <div className="w-44">
        <DropdownItem icon={<Eye />} onSelect={() => router.push(`/invoices/${inv.id}`)}>
          View
        </DropdownItem>
        {inv.lifecycleStatus === "DRAFT" && (
          <DropdownItem icon={<FileText />} onSelect={() => router.push(`/invoices/new?from=${inv.id}`)}>
            Edit
          </DropdownItem>
        )}
        <DropdownItem icon={<Copy />} onSelect={() => router.push(`/invoices/new?duplicate=${inv.id}`)}>
          Duplicate
        </DropdownItem>
        <DropdownItem icon={<Download />} onSelect={() => toast("PDF export", { description: "Rendered from the same template as the preview." })}>
          Download PDF
        </DropdownItem>
        {inv.lifecycleStatus === "DRAFT" && (
          <>
            <DropdownSeparator />
            <DropdownItem icon={<Trash2 />} tone="destructive" onSelect={onDelete}>
              Delete
            </DropdownItem>
          </>
        )}
      </div>
    </Dropdown>
  );
}

function ListSkeleton() {
  return (
    <div>
      <Skeleton className="h-9 w-48" />
      <Skeleton className="mt-2 h-5 w-72" />
      <div className="mt-6 flex gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-24 rounded-full" />
        ))}
      </div>
      <Skeleton className="mt-4 h-96 rounded-2xl" />
    </div>
  );
}
