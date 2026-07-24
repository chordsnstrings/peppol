"use client";

import * as React from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { motion } from "framer-motion";
import {
  Send,
  Download,
  Copy,
  Printer,
  MoreHorizontal,
  Trash2,
  FileCode2,
  FileText,
  CheckCircle2,
  Clock,
  Ban,
  ShieldCheck,
  ArrowLeftRight,
  Landmark,
  Archive,
  RefreshCw,
  CreditCard,
  Bell,
  Link2,
  MessageCircle,
} from "lucide-react";
import { createPaymentLink, markPaid, sendReminder } from "@/lib/payments-client";
import { sendInvoiceWhatsApp } from "@/lib/whatsapp-client";
import { outstandingMinor } from "@/lib/domain/ar";
import { PaymentBadge } from "@/components/invoice/status";
import { cn, formatDate, timeAgo } from "@/lib/utils";
import { formatMoney } from "@/lib/domain/money";
import { DOC_TYPE_LABEL } from "@/lib/domain/tax";
import { EXCHANGE_META, REPORTING_META } from "@/lib/domain/status";
import { generateUBL, downloadText } from "@/lib/domain/ubl";
import { useAppState } from "@/lib/app-state";
import { useRecord, useCollection } from "@/lib/db/hooks";
import { cancelInvoice, deleteInvoice, sendInvoice } from "@/lib/db/repo";
import type { Invoice, InvoiceEvent } from "@/lib/domain/types";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, StatusBadge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/feedback";
import { EmptyState } from "@/components/ui/empty-state";
import { InvoiceStatus } from "@/components/invoice/status";
import { InvoicePreview } from "@/components/invoice/invoice-preview";
import { ConfirmDialog, Modal } from "@/components/ui/modal";
import { Dropdown, DropdownItem, DropdownSeparator, DropdownTrigger } from "@/components/ui/dropdown";
import { toast } from "sonner";

export default function InvoiceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { currentEntity } = useAppState();
  const { data: invoice, loading } = useRecord<Invoice>("invoices", id);
  const { data: events } = useCollection<InvoiceEvent>("invoiceEvents", {
    index: { name: "invoiceId", value: id },
    sort: (a, b) => a.at.localeCompare(b.at),
    deps: [id],
  });

  const [confirmSend, setConfirmSend] = React.useState(false);
  const [confirmCancel, setConfirmCancel] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  if (loading) return <DetailSkeleton />;
  if (!invoice) {
    return (
      <EmptyState
        icon={<FileText />}
        title="Invoice not found"
        description="It may have been deleted."
        action={<Button onClick={() => router.push("/invoices")}>Back to invoices</Button>}
      />
    );
  }

  const isDraft = invoice.lifecycleStatus === "DRAFT" || invoice.lifecycleStatus === "READY";
  const isCompleted = invoice.lifecycleStatus === "COMPLETED";

  const doSend = async () => {
    if (!currentEntity) return;
    setBusy(true);
    try {
      await sendInvoice(invoice, currentEntity);
      toast.success("Sent, delivered & reported");
    } catch {
      toast.error("Can't send", { description: "This invoice has blocking issues." });
    }
    setBusy(false);
    setConfirmSend(false);
  };

  const exportXML = () => {
    downloadText(`${invoice.number || "invoice"}.xml`, generateUBL(invoice), "application/xml");
    toast.success("UBL XML exported");
  };

  const downloadEvidence = async () => {
    try {
      const res = await fetch(`/api/invoices/${invoice.id}/evidence`);
      if (!res.ok) throw new Error();
      const bundle = await res.json();
      downloadText(`${invoice.number || "invoice"}-evidence.json`, JSON.stringify(bundle, null, 2), "application/json");
      toast.success("Evidence bundle downloaded", { description: "Audit-ready: CIM, UBL, TDD, timeline + hashes." });
    } catch {
      toast.error("Evidence not available yet", { description: "Send the invoice first." });
    }
  };

  const reconcile = async () => {
    setBusy(true);
    try {
      const res = await fetch(`/api/invoices/${invoice.id}/reconcile`, { method: "POST" });
      const body = await res.json();
      if (body.changed) toast.success("Status updated");
      else toast("No change yet", { description: "Still awaiting the gateway." });
    } catch {
      toast.error("Couldn't reconcile");
    }
    setBusy(false);
  };

  const getPaidLink = async () => {
    setBusy(true);
    try {
      const { url, driver } = await createPaymentLink(invoice.id);
      await navigator.clipboard?.writeText(url).catch(() => {});
      toast.success("Payment link ready", {
        description: driver === "mock" ? "Copied — opens a sandbox checkout." : "Copied to clipboard.",
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't create link");
    }
    setBusy(false);
  };

  const doMarkPaid = async () => {
    setBusy(true);
    try {
      await markPaid(invoice.id, "Bank transfer");
      toast.success("Marked as paid");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't mark paid");
    }
    setBusy(false);
  };

  const doRemind = async () => {
    await sendReminder(invoice.id);
    toast.success("Reminder sent", { description: `Chased ${invoice.buyer.nameEn || "the customer"}.` });
  };

  const doWhatsApp = async () => {
    setBusy(true);
    try {
      const { to } = await sendInvoiceWhatsApp(invoice.id);
      toast.success("Sent on WhatsApp", { description: `Delivered to ${to} with a pay link.` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Couldn't send";
      if (msg.includes("not connected")) {
        toast.error("WhatsApp not connected", { description: "Connect your number in Integrations first." });
      } else if (msg.includes("No WhatsApp number")) {
        toast.error("No customer number", { description: "Add a phone number to this customer first." });
      } else {
        toast.error(msg);
      }
    }
    setBusy(false);
  };

  return (
    <div>
      <PageHeader
        breadcrumb={[{ label: "Invoices", href: "/invoices" }, { label: invoice.number || "Draft" }]}
        title={
          <span className="flex items-center gap-3">
            {invoice.number || "Untitled draft"}
            <InvoiceStatus invoice={invoice} />
          </span>
        }
        description={`${DOC_TYPE_LABEL[invoice.docType]} · ${formatMoney(invoice.totals.taxInclusiveMinor, invoice.currency)}`}
        actions={
          <>
            {isDraft && (
              <>
                <Button variant="outline" onClick={() => router.push(`/invoices/new?from=${invoice.id}`)}>
                  Edit
                </Button>
                <Button icon={<Send />} onClick={() => setConfirmSend(true)}>
                  Send
                </Button>
              </>
            )}
            {!isDraft && (
              <Button variant="outline" icon={<Download />} onClick={exportXML}>
                <span className="hidden sm:inline">Export XML</span>
              </Button>
            )}
            <Dropdown align="end">
              <DropdownTrigger>
                <Button variant="outline" size="icon" aria-label="More">
                  <MoreHorizontal />
                </Button>
              </DropdownTrigger>
              <div className="w-48">
                <DropdownItem icon={<FileCode2 />} onSelect={exportXML}>
                  Download UBL XML
                </DropdownItem>
                <DropdownItem icon={<Printer />} onSelect={() => window.print()}>
                  Print / Save PDF
                </DropdownItem>
                {!isDraft && (
                  <DropdownItem icon={<ShieldCheck />} onSelect={downloadEvidence}>
                    Download evidence bundle
                  </DropdownItem>
                )}
                <DropdownItem
                  icon={<Copy />}
                  onSelect={() => router.push(`/invoices/new?duplicate=${invoice.id}`)}
                >
                  Duplicate
                </DropdownItem>
                {(isCompleted || invoice.lifecycleStatus === "DELIVERED" || invoice.lifecycleStatus === "SENT") && (
                  <DropdownItem
                    icon={<ArrowLeftRight />}
                    onSelect={() => router.push(`/invoices/new?creditFor=${invoice.id}`)}
                  >
                    Create credit note
                  </DropdownItem>
                )}
                {invoice.lifecycleStatus === "FAILED" && (
                  <DropdownItem
                    icon={<Copy />}
                    onSelect={() => router.push(`/invoices/new?duplicate=${invoice.id}`)}
                  >
                    Fix &amp; resend as corrected copy
                  </DropdownItem>
                )}
                {(invoice.lifecycleStatus === "SENT" ||
                  invoice.lifecycleStatus === "SENDING" ||
                  invoice.lifecycleStatus === "QUEUED") && (
                  <DropdownItem icon={<RefreshCw />} onSelect={reconcile}>
                    Re-check status
                  </DropdownItem>
                )}
                <DropdownSeparator />
                {isDraft ? (
                  <>
                    <DropdownItem icon={<Ban />} onSelect={() => setConfirmCancel(true)}>
                      Cancel draft
                    </DropdownItem>
                    <DropdownItem icon={<Trash2 />} tone="destructive" onSelect={() => setConfirmDelete(true)}>
                      Delete
                    </DropdownItem>
                  </>
                ) : (
                  <DropdownItem icon={<Trash2 />} tone="destructive" onSelect={() => setConfirmDelete(true)}>
                    Delete record
                  </DropdownItem>
                )}
              </div>
            </Dropdown>
          </>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        {/* Left: preview + timeline */}
        <div className="space-y-5">
          <div className="print-area">
            <InvoicePreview invoice={invoice} />
          </div>

          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Clock className="size-4" /> Timeline
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ol className="relative space-y-4 ps-6">
                <span className="absolute inset-y-2 start-[9px] w-px bg-border" />
                {events.length === 0 && (
                  <li className="text-sm text-muted-foreground">No activity yet.</li>
                )}
                {[...events].reverse().map((ev, i) => (
                  <motion.li
                    key={ev.id}
                    initial={{ opacity: 0, x: -6 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: i * 0.04 }}
                    className="relative"
                  >
                    <span
                      className={cn(
                        "absolute -start-6 top-0.5 flex size-[18px] items-center justify-center rounded-full ring-4 ring-card",
                        ev.tone === "success"
                          ? "bg-success text-white"
                          : ev.tone === "error"
                            ? "bg-destructive text-white"
                            : ev.tone === "warning"
                              ? "bg-warning"
                              : "bg-muted-foreground/40",
                      )}
                    >
                      {ev.tone === "success" && <CheckCircle2 className="size-3 text-white" />}
                    </span>
                    <p className="text-sm font-medium">{ev.detail}</p>
                    <p className="text-xs text-muted-foreground">
                      {ev.actor} · {timeAgo(ev.at)}
                    </p>
                  </motion.li>
                ))}
              </ol>
            </CardContent>
          </Card>
        </div>

        {/* Right: status + details + artifacts */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Delivery status</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <StatusLeg
                icon={<ArrowLeftRight />}
                label="Exchange (to buyer)"
                meta={EXCHANGE_META[invoice.exchangeStatus]}
              />
              <StatusLeg
                icon={<Landmark />}
                label="Reporting (to FTA)"
                meta={REPORTING_META[invoice.reportingStatusC2]}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Details</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2.5 text-sm">
              <DetailRow label="Customer" value={invoice.buyer.nameEn || "—"} />
              <DetailRow label="Buyer TRN" value={invoice.buyer.trn || "—"} mono />
              <DetailRow label="Issue date" value={formatDate(invoice.issueDate)} />
              <DetailRow label="Supply date" value={formatDate(invoice.supplyDate)} />
              {invoice.dueDate && <DetailRow label="Due date" value={formatDate(invoice.dueDate)} />}
              <DetailRow label="Currency" value={invoice.currency} />
              <div className="my-1 h-px bg-border" />
              <DetailRow
                label="Subtotal"
                value={formatMoney(invoice.totals.taxExclusiveMinor, invoice.currency)}
              />
              <DetailRow
                label="VAT"
                value={formatMoney(invoice.totals.vatMinor, invoice.currency)}
              />
              <div className="flex items-center justify-between pt-1">
                <span className="font-semibold">Total</span>
                <span className="font-display text-lg font-bold tnum">
                  {formatMoney(invoice.totals.taxInclusiveMinor, invoice.currency)}
                </span>
              </div>
            </CardContent>
          </Card>

          {/* Get paid */}
          {invoice.direction === "OUTBOUND" && !isDraft && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <CreditCard className="size-4" /> Get paid
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {invoice.paymentStatus === "PAID" ? (
                  <div className="flex items-center gap-2.5 rounded-lg bg-success/[0.08] p-3 text-success">
                    <CheckCircle2 className="size-5" />
                    <div>
                      <p className="text-sm font-semibold">Paid</p>
                      <p className="text-xs opacity-80">
                        {formatMoney(invoice.amountPaidMinor ?? invoice.totals.taxInclusiveMinor, invoice.currency)}
                        {invoice.paidAt ? ` · ${timeAgo(invoice.paidAt)}` : ""}
                      </p>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">Outstanding</span>
                      <span className="font-semibold tnum">
                        {formatMoney(outstandingMinor(invoice), invoice.currency)}
                      </span>
                    </div>
                    <PaymentBadge invoice={invoice} />
                    <Button size="sm" className="w-full" icon={<Link2 />} loading={busy} onClick={getPaidLink}>
                      Create &amp; copy pay link
                    </Button>
                    <div className="grid grid-cols-2 gap-2">
                      <Button size="sm" variant="outline" icon={<Bell />} onClick={doRemind}>
                        Remind
                      </Button>
                      <Button size="sm" variant="outline" icon={<CheckCircle2 />} loading={busy} onClick={doMarkPaid}>
                        Mark paid
                      </Button>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full text-[#128C7E] hover:text-[#128C7E]"
                      icon={<MessageCircle />}
                      loading={busy}
                      onClick={doWhatsApp}
                    >
                      Send on WhatsApp
                    </Button>
                    <p className="text-[11px] text-muted-foreground">
                      Pay by card via Network International / noqodi, or record a bank transfer.
                    </p>
                  </>
                )}
              </CardContent>
            </Card>
          )}

          {/* Artifacts */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <Archive className="size-4" /> Artifacts
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <ArtifactRow
                icon={<FileCode2 />}
                label="Final UBL XML"
                available
                onClick={exportXML}
              />
              <ArtifactRow icon={<FileText />} label="Human-readable PDF" available onClick={() => window.print()} />
              <ArtifactRow
                icon={<ShieldCheck />}
                label="Evidence bundle"
                available={!isDraft}
                hint={!isDraft ? "CIM + UBL + TDD + hashes" : "After sending"}
                onClick={downloadEvidence}
              />
            </CardContent>
          </Card>
        </div>
      </div>

      <Modal open={confirmSend} onClose={() => setConfirmSend(false)} title="Send this invoice?" size="sm">
        <div className="p-5">
          <p className="text-sm text-muted-foreground">
            {invoice.number} will be delivered to {invoice.buyer.nameEn || "the buyer"} and reported to
            the FTA.
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmSend(false)}>
              Cancel
            </Button>
            <Button icon={<Send />} loading={busy} onClick={doSend}>
              Confirm & send
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmCancel}
        onClose={() => setConfirmCancel(false)}
        onConfirm={async () => {
          await cancelInvoice(invoice);
          setConfirmCancel(false);
          toast.success("Draft cancelled");
        }}
        title="Cancel this draft?"
        description="It will be marked cancelled. You can still duplicate it later."
        confirmLabel="Cancel draft"
        tone="destructive"
      />

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={async () => {
          await deleteInvoice(invoice.id);
          toast.success("Deleted");
          router.push("/invoices");
        }}
        title="Delete this invoice?"
        description="This permanently removes the record from this device."
        confirmLabel="Delete"
        tone="destructive"
      />
    </div>
  );
}

function StatusLeg({
  icon,
  label,
  meta,
}: {
  icon: React.ReactNode;
  label: string;
  meta: { label: string; tone: string; description: string };
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium">{label}</p>
          <StatusBadge label={meta.label} tone={meta.tone as never} size="sm" />
        </div>
        <p className="text-xs text-muted-foreground">{meta.description}</p>
      </div>
    </div>
  );
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn("font-medium tnum", mono && "font-mono text-xs")}>{value}</span>
    </div>
  );
}

function ArtifactRow({
  icon,
  label,
  available,
  hint,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  available?: boolean;
  hint?: string;
  onClick?: () => void;
}) {
  return (
    <button
      disabled={!available}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg border border-border p-2.5 text-start transition-colors",
        available ? "hover:bg-accent" : "opacity-50",
      )}
    >
      <span className="flex size-8 items-center justify-center rounded-md bg-muted text-muted-foreground [&_svg]:size-4">
        {icon}
      </span>
      <span className="flex-1">
        <span className="block text-sm font-medium">{label}</span>
        {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
      </span>
      {available && <Download className="size-4 text-muted-foreground" />}
    </button>
  );
}

function DetailSkeleton() {
  return (
    <div>
      <Skeleton className="h-9 w-56" />
      <div className="mt-6 grid gap-5 lg:grid-cols-[1fr_340px]">
        <Skeleton className="h-96 rounded-2xl" />
        <div className="space-y-4">
          <Skeleton className="h-40 rounded-2xl" />
          <Skeleton className="h-60 rounded-2xl" />
        </div>
      </div>
    </div>
  );
}
