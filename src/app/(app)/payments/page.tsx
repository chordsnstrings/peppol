"use client";

import * as React from "react";
import Link from "next/link";
import { CreditCard, Bell, Link2, CheckCircle2, TrendingUp, Clock, Wallet, Send, Landmark } from "lucide-react";
import { cn, formatDate } from "@/lib/utils";
import { formatMoney } from "@/lib/domain/money";
import { arSummary, outstandingMinor, paymentState } from "@/lib/domain/ar";
import { useInvoices } from "@/hooks/use-entity-data";
import { createPaymentLink, markPaid, runReminders, sendReminder } from "@/lib/payments-client";
import { useEntityId } from "@/components/ledger/use-ledger";
import { BOOK_CURRENCY, isPostable, useSalesLedger } from "@/components/ledger/ar-posting";
import { ReceiptModal } from "@/components/ledger/ar-receipt-modal";
import type { Invoice } from "@/lib/domain/types";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/ui/stat";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Pagination, usePagination } from "@/components/ui/pagination";
import { toast } from "sonner";

export default function PaymentsPage() {
  const entityId = useEntityId();
  const { invoices } = useInvoices((i) => i.direction === "OUTBOUND");
  const ar = React.useMemo(() => arSummary(invoices), [invoices]);
  const [busy, setBusy] = React.useState<string | null>(null);
  /** The invoice a receipt is being posted for, and what was banked against it. */
  const [receipt, setReceipt] = React.useState<{ invoice: Invoice; suggestMinor: bigint | null } | null>(null);
  const pg = usePagination(ar.receivables, 10);
  const cur = invoices[0]?.currency ?? "AED";
  const maxBucket = Math.max(1, ...ar.buckets.map((b) => b.amountMinor));

  /* Which of these invoices the books already carry. Recording a payment on the
   * document and posting the receipt are two different acts, and the second one
   * only makes sense against an invoice that was posted: a receipt against one
   * that was not credits receivables with nothing to clear. The read opens at
   * the oldest invoice on the screen, because a general-ledger read is capped
   * and a window wider than the question buys nothing. */
  const ledgerFrom = React.useMemo(() => {
    let earliest: string | undefined;
    for (const i of invoices) {
      const day = i.issueDate?.slice(0, 10);
      if (day && (!earliest || day < earliest)) earliest = day;
    }
    return earliest;
  }, [invoices]);
  const ledger = useSalesLedger(
    invoices.length > 0 ? entityId : undefined,
    ledgerFrom ? { from: ledgerFrom } : undefined,
  );

  const payLink = async (id: string) => {
    setBusy(id);
    try {
      const { url, driver } = await createPaymentLink(id);
      await navigator.clipboard?.writeText(url).catch(() => {});
      toast.success("Pay link copied", { description: driver === "mock" ? "Opens a sandbox checkout." : undefined });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed");
    }
    setBusy(null);
  };
  const remind = async (id: string) => {
    await sendReminder(id);
    toast.success("Reminder sent");
  };
  const paid = async (inv: Invoice) => {
    setBusy(inv.id);
    /* What is outstanding now, before the document records the payment — it is
     * what reached the bank, and a moment later the document will say nothing
     * is due. Only in the book's own currency: a receipt posts in dirhams, and
     * this figure is in whatever the invoice was raised in. */
    const banked = inv.currency === BOOK_CURRENCY ? outstandingMinor(inv) : 0;
    try {
      await markPaid(inv.id, "Bank transfer");
      toast.success("Marked as paid", {
        description: "Recorded on the document. The books do not know yet — post the receipt.",
      });
      setReceipt({
        invoice: inv,
        suggestMinor: Number.isInteger(banked) && banked > 0 ? BigInt(banked) : null,
      });
    } catch {
      toast.error("Failed");
    }
    setBusy(null);
  };
  const chaseAll = async () => {
    const n = await runReminders();
    toast.success(n > 0 ? `${n} reminders sent` : "Nothing overdue to chase");
  };

  return (
    <div>
      <PageHeader
        title="Get paid"
        description="Turn delivered invoices into cash — pay links, reminders and receivables in one place."
        icon={<CreditCard />}
        actions={
          <Button variant="outline" icon={<Send />} onClick={chaseAll} disabled={ar.overdueMinor === 0}>
            Chase overdue
          </Button>
        }
      />

      {ar.receivables.length === 0 && ar.outstandingMinor === 0 ? (
        <EmptyState
          icon={<Wallet />}
          title="No outstanding invoices"
          description="When you send an invoice, it appears here so you can collect payment, send reminders and track what you're owed."
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            <StatCard label="Outstanding" value={ar.outstandingMinor / 100} format={(n) => formatMoney(Math.round(n * 100), cur)} icon={<Wallet />} tone="gold" />
            <StatCard label="Overdue" value={ar.overdueMinor / 100} format={(n) => formatMoney(Math.round(n * 100), cur)} icon={<Clock />} tone={ar.overdueMinor > 0 ? "warning" : "default"} />
            <StatCard label="Paid this month" value={ar.paidThisMonthMinor / 100} format={(n) => formatMoney(Math.round(n * 100), cur)} icon={<CheckCircle2 />} tone="success" />
            <StatCard label="Avg days to pay" value={ar.dso} icon={<TrendingUp />} hint="DSO" />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-3">
            {/* Aging */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Ageing</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {ar.buckets.map((b) => (
                  <div key={b.key}>
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">{b.label}</span>
                      <span className="font-medium tnum">{formatMoney(b.amountMinor, cur)}</span>
                    </div>
                    <div className="mt-1 h-2 overflow-hidden rounded-full bg-muted">
                      <div
                        className={cn("h-full rounded-full", b.key === "current" ? "bg-info" : b.key === "90+" ? "bg-destructive" : "bg-gold")}
                        style={{ width: `${(b.amountMinor / maxBucket) * 100}%` }}
                      />
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>

            {/* Receivables */}
            <Card className="lg:col-span-2">
              <CardHeader className="pb-3">
                <CardTitle className="text-base">Receivables</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {pg.pageItems.map((inv) => {
                    const st = paymentState(inv);
                    return (
                      <div key={inv.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-border p-3">
                        <Link href={`/invoices/${inv.id}`} className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">
                            {inv.number} · {inv.buyer.nameEn}
                          </p>
                          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                            <span>Due {formatDate(inv.dueDate)}</span>
                            <Badge tone={st === "OVERDUE" ? "error" : st === "PARTIAL" ? "warning" : "neutral"} size="sm">
                              {st === "OVERDUE" ? "Overdue" : st === "PARTIAL" ? "Part-paid" : "Awaiting"}
                            </Badge>
                            {/* Said only where it can be shown: an invoice the
                                control-account read did not reach is left
                                unlabelled rather than called unposted. */}
                            {ledger.index?.complete && isPostable(inv) && !ledger.index.postings.has(inv.id) && (
                              <Badge tone="warning" size="sm">Not in the ledger</Badge>
                            )}
                          </p>
                        </Link>
                        <span className="font-semibold tnum">{formatMoney(outstandingMinor(inv), inv.currency)}</span>
                        <div className="flex items-center gap-1.5">
                          <Button size="icon-sm" variant="outline" loading={busy === inv.id} onClick={() => payLink(inv.id)} aria-label="Pay link">
                            <Link2 />
                          </Button>
                          <Button size="icon-sm" variant="outline" onClick={() => remind(inv.id)} aria-label="Remind">
                            <Bell />
                          </Button>
                          <Button size="icon-sm" variant="outline" onClick={() => paid(inv)} aria-label="Mark paid">
                            <CheckCircle2 />
                          </Button>
                          {/* The ledger half of the same act, offered on its
                              own as well: money often arrives on an invoice
                              somebody else already marked paid. */}
                          <Button
                            size="icon-sm"
                            variant="outline"
                            onClick={() => setReceipt({ invoice: inv, suggestMinor: null })}
                            aria-label="Post receipt to the ledger"
                            title="Post receipt to the ledger"
                          >
                            <Landmark />
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="mt-4">
                  <Pagination
                    page={pg.page}
                    pageCount={pg.pageCount}
                    onPage={pg.setPage}
                    rangeStart={pg.rangeStart}
                    rangeEnd={pg.rangeEnd}
                    total={pg.total}
                    itemLabel="receivables"
                  />
                </div>
              </CardContent>
            </Card>
          </div>
        </>
      )}

      {receipt && (
        <ReceiptModal
          invoice={receipt.invoice}
          suggestMinor={receipt.suggestMinor}
          warning={
            ledger.index?.complete && !ledger.index.postings.has(receipt.invoice.id)
              ? "This invoice is not on the books, so a receipt against it would credit receivables with no invoice to clear and stand in the ageing as an unapplied credit. Post the invoice first, from the invoice itself or from Receivables."
              : undefined
          }
          onClose={() => setReceipt(null)}
          onPosted={(entry) => {
            const number = receipt.invoice.number;
            setReceipt(null);
            ledger.reload();
            if (entry.alreadyPosted) {
              toast("That receipt is already on the books", {
                description: `A receipt for ${number} on that date and for that amount was posted as ${entry.reference}. Nothing was posted again.`,
              });
            } else {
              toast.success(`Receipt posted as ${entry.reference}`, {
                description: `The bank is debited and ${number} is cleared in the ageing.`,
              });
            }
          }}
        />
      )}
    </div>
  );
}
