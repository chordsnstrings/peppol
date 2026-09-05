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
  BookOpen,
  Lock,
  ShieldAlert,
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
import { touch } from "@/lib/db/database";
import { cancelInvoice, deleteInvoice, sendInvoice } from "@/lib/db/repo";
import { useLedgerQuery } from "@/components/ledger/use-ledger";
import { fmtMinor } from "@/lib/ledger/format";
import { useGatewayMode } from "@/lib/gateway/mode";
import {
  SIMULATED_LABEL,
  SIMULATED_SEND_NOTE,
  SIMULATED_SEND_WARNING,
} from "@/lib/gateway/disclosure";
import {
  AR_CONTROL,
  BOOK_CURRENCY,
  dayAfter,
  journalHref,
  ledgerProblem,
  postInvoiceToLedger,
  useSalesLedger,
  whyNotPostable,
} from "@/components/ledger/ar-posting";
import { ReceiptModal } from "@/components/ledger/ar-receipt-modal";
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

/* ------------------------------------------------------------ credit gate */

/**
 * What the finalisation gate answers with.
 *
 * Only the fields this screen actually renders are named. A client type that
 * declares more than it shows invites the next person to trust a field nothing
 * has ever displayed. Every amount is a string of minor units in the book's own
 * currency — the one a credit limit is held in, which is not necessarily the
 * currency this invoice was raised in.
 */
interface CreditGate {
  decision: "allow" | "review" | "refuse" | "unknown";
  allowed: boolean;
  overrode: boolean;
  headline: string;
  reasons: { code: string; blocking: boolean; message: string }[];
  currency: string;
  additionalMinor: string;
  exposureMinor: string | null;
  wouldBeMinor: string | null;
  creditLimitMinor: string | null;
  limitSet: boolean;
  limitEffectiveFrom: string | null;
  headroomMinor: string | null;
  overByMinor: string | null;
  caveat: string | null;
}

const GATE_TONE = { allow: "success", review: "warning", refuse: "error", unknown: "neutral" } as const;
const GATE_WORD = {
  allow: "Within limit",
  review: "Somebody should look",
  refuse: "Stop",
  unknown: "Not checked",
} as const;

/** Money in the book's currency, in the same shape the ledger screens write it. */
const gateMoney = (v: string | null, currency: string) =>
  v === null ? "—" : `${currency} ${fmtMinor(v, currency, { zero: "zero" })}`;

/**
 * Finalise the draft through the credit gate: DRAFT → READY, or a refusal.
 *
 * The refusal is the interesting answer, so it comes back rather than being
 * thrown. The 409 carries the whole gate — the limit, what the customer already
 * carries, what this document would take them to, and every ground separately —
 * and a caller that collapsed that into an error string would throw away
 * precisely the figures the person in front of the customer needs.
 */
async function finaliseThroughGate(
  invoiceId: string,
  overrideReason?: string,
): Promise<{ ok: boolean; error: string | null; gate: CreditGate | null; alreadyFinalised: boolean }> {
  const res = await fetch("/api/ledger/credit-control/invoice", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ invoiceId, ...(overrideReason ? { overrideReason } : {}) }),
  });
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    gate?: CreditGate | null;
    alreadyFinalised?: boolean;
  };
  if (res.ok) {
    /* The document and its timeline both moved on the server, and every screen
     * reading either of them is subscribed to those two stores. */
    touch("invoices");
    touch("invoiceEvents");
    return { ok: true, error: null, gate: body.gate ?? null, alreadyFinalised: Boolean(body.alreadyFinalised) };
  }
  return {
    ok: false,
    error: body.error ?? "The credit check could not be run, so nothing was finalised.",
    gate: body.gate ?? null,
    alreadyFinalised: false,
  };
}

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
  const [postingToLedger, setPostingToLedger] = React.useState(false);
  const [ledgerError, setLedgerError] = React.useState<string | null>(null);
  const [receiptOpen, setReceiptOpen] = React.useState(false);
  const [receiptSuggestion, setReceiptSuggestion] = React.useState<bigint | null>(null);
  const [finalising, setFinalising] = React.useState(false);
  /* The gate's last answer, kept so a refusal stays on screen with its figures
   * instead of vanishing into a toast the moment it is read. */
  const [gate, setGate] = React.useState<CreditGate | null>(null);
  const [gateError, setGateError] = React.useState<string | null>(null);
  const [overrideReason, setOverrideReason] = React.useState("");
  const gateway = useGatewayMode();

  /* Why this document does not belong in the sales ledger, where it does not.
   * The sentence is shown instead of the action, so somebody looking for the
   * button finds out why there isn't one. */
  const notPostable = invoice ? whyNotPostable(invoice) : null;

  /* Whether this invoice is on the books, read from the receivables control
   * account itself rather than from a flag on the document. The entry an
   * invoice makes is dated on the invoice, so the read only has to cover that
   * day — see `dayAfter` for why the window closes a day late. Nothing is read
   * at all for a document that could never be in there. */
  const issuedOn = invoice?.issueDate?.slice(0, 10);
  const ledger = useSalesLedger(
    invoice && !notPostable ? invoice.entityId : undefined,
    issuedOn ? { from: issuedOn, to: dayAfter(issuedOn) } : undefined,
  );

  /* Where the customer stands, asked while the draft is still open.
   *
   * The gate below is what actually stops a sale, and this read stops nothing —
   * it exists so the answer arrives before somebody has told the customer the
   * goods are on their way, rather than at the moment they press Send. Only for
   * a draft that would create a receivable: a finalised document is past the
   * decision, and an inbound one puts the business in debt rather than the
   * customer. */
  const gateAdvice = useLedgerQuery<{ gate: CreditGate; finalised: boolean }>(
    invoice && invoice.direction === "OUTBOUND" && invoice.lifecycleStatus === "DRAFT"
      ? `/api/ledger/credit-control/invoice?invoiceId=${encodeURIComponent(invoice.id)}`
      : null,
  );

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
  const isProforma = invoice.docType === "PROFORMA";
  const posted = ledger.index?.postings.get(invoice.id) ?? null;
  /* Not yet finalised: the document can still change, and nobody has committed
   * to it. `isDraft` above means something wider — everything before the send
   * pipeline takes it — and the two are not interchangeable here. */
  const unfinalised = invoice.lifecycleStatus === "DRAFT";
  /* The last word on credit: what finalising actually answered, falling back to
   * what the advisory read said while the draft is still open. */
  const standing = gate ?? gateAdvice.data?.gate ?? null;

  /**
   * Finalise the draft, through the credit gate.
   *
   * This is the moment the business commits — the last point at which not
   * selling costs a conversation rather than a credit note — so it is where the
   * limit is checked. A refusal leaves the draft exactly as it was, comes back
   * with the figures, and can be overridden by somebody who holds the credit
   * grant on a reason that goes onto the document's own timeline.
   *
   * Answers true only when the document is now finalised, so a caller can use
   * it as the gate on whatever it was about to do next.
   */
  const doFinalise = async (reason?: string): Promise<boolean> => {
    setFinalising(true);
    setGateError(null);
    const r = await finaliseThroughGate(invoice.id, reason);
    /* Only where an answer came back with one. A failure that carried no gate —
     * the network, or a refusal about something other than credit — must not
     * wipe the refusal already on screen, or the grounds and the override box
     * vanish at the moment they are being read. */
    if (r.gate) setGate(r.gate);
    setFinalising(false);
    if (!r.ok) {
      setGateError(r.error);
      return false;
    }
    setOverrideReason("");
    if (r.alreadyFinalised) {
      toast("Already finalised", { description: `${invoice.number || "This document"} was ready to send already.` });
    } else if (r.gate?.overrode) {
      toast.warning("Finalised over a credit refusal", {
        description: "The refusal, the figures behind it and your reason are on the invoice's timeline.",
      });
    } else {
      toast.success("Finalised", {
        description: r.gate && r.gate.decision !== "unknown" ? r.gate.headline : "The document is locked and ready to send.",
      });
    }
    return true;
  };

  const doSend = async () => {
    if (!currentEntity) return;
    setBusy(true);
    try {
      /* Finalising first, so the credit gate binds on the path people actually
       * take. Sending is what puts the document in the customer's hands, and a
       * check that ran only when somebody chose to press Finalise would be a
       * check the busy day skips. A refusal stops here with the dialog still
       * open on the grounds. */
      if (unfinalised && !(await doFinalise())) {
        setBusy(false);
        return;
      }
      await sendInvoice(invoice, currentEntity);
      /* On a simulated gateway the acceptance came from this deployment, not
       * from the buyer's Access Point or the FTA, so it is reported as the
       * rehearsal it was. `simulated` stays true until the server says
       * otherwise, so an unanswered health check errs toward the warning. */
      if (gateway.simulated) {
        toast.warning("Simulated — nothing was transmitted", { description: SIMULATED_SEND_NOTE });
      } else {
        toast.success("Sent, delivered & reported");
      }
    } catch (e) {
      /* A refusal carrying no validation issues came from the pipeline rather
       * than from the document: a credit refusal and a live entity on a
       * simulated gateway are both that shape, and each arrives as a sentence
       * written to be read. Printing "blocking issues" over one sends somebody
       * hunting through a valid invoice for a fault that is not in it. */
      const issues = (e as { issues?: unknown }).issues;
      const reason = !issues && e instanceof Error ? e.message : "";
      toast.error("Can't send", { description: reason || "This invoice has blocking issues." });
    }
    setBusy(false);
    setConfirmSend(false);
  };

  /**
   * Put this invoice into the general ledger.
   *
   * Idempotent on the invoice id, so the route answers `alreadyPosted` when the
   * entry was already there — and this says so rather than claiming a posting
   * it did not make. Every refusal the route makes carries a sentence written
   * to be read, so it is shown as it stands.
   */
  const postToLedger = async () => {
    setPostingToLedger(true);
    setLedgerError(null);
    try {
      const entry = await postInvoiceToLedger(invoice.id);
      ledger.reload();
      if (entry.alreadyPosted) {
        toast("Already on the books", {
          description: `${invoice.number} was posted as ${entry.reference}. Nothing was posted again.`,
        });
      } else {
        toast.success(`Posted as ${entry.reference}`, {
          description: "Receivables, revenue and VAT output now carry this invoice.",
        });
      }
    } catch (e) {
      const message = ledgerProblem(e);
      setLedgerError(message);
      toast.error("Not posted", { description: message });
    }
    setPostingToLedger(false);
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
    /* What is outstanding now, before the document records the payment — it is
     * the amount that reached the bank, and a moment later the document will
     * say nothing is due. Only in the book's own currency: a receipt is posted
     * in dirhams, and this figure is in whatever the invoice was raised in. */
    const banked = invoice.currency === BOOK_CURRENCY ? outstandingMinor(invoice) : 0;
    try {
      await markPaid(invoice.id, "Bank transfer");
      toast.success("Marked as paid", {
        description: "Recorded on the document. The books do not know yet — post the receipt.",
      });
      setReceiptSuggestion(Number.isInteger(banked) && banked > 0 ? BigInt(banked) : null);
      setReceiptOpen(true);
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
                {unfinalised && (
                  <Button
                    variant="outline"
                    icon={<Lock />}
                    loading={finalising}
                    onClick={() => void doFinalise()}
                  >
                    Finalise
                  </Button>
                )}
                {isProforma ? (
                  <Button icon={<FileText />} onClick={() => router.push(`/invoices/new?convertFrom=${invoice.id}`)}>
                    Convert to tax invoice
                  </Button>
                ) : (
                  <Button icon={<Send />} onClick={() => setConfirmSend(true)}>
                    Send
                  </Button>
                )}
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
                {!notPostable && !posted && (
                  <DropdownItem icon={<BookOpen />} onSelect={postToLedger}>
                    Post to the ledger
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
              {/* The two status maps have no gateway knowledge and should not
                  gain any, so the qualifier is added here: on a simulated
                  deployment "Delivered" and "Reported" are outcomes this
                  deployment wrote for itself. A leg that has not moved carries
                  no badge — there is nothing simulated about "not sent". */}
              <StatusLeg
                icon={<ArrowLeftRight />}
                label="Exchange (to buyer)"
                meta={EXCHANGE_META[invoice.exchangeStatus]}
                qualifier={
                  gateway.known && gateway.simulated && invoice.exchangeStatus !== "NOT_SENT"
                    ? SIMULATED_LABEL
                    : undefined
                }
              />
              <StatusLeg
                icon={<Landmark />}
                label="Reporting (to FTA)"
                meta={REPORTING_META[invoice.reportingStatusC2]}
                qualifier={
                  gateway.known && gateway.simulated && invoice.reportingStatusC2 !== "NOT_REPORTED"
                    ? SIMULATED_LABEL
                    : undefined
                }
              />
              {gateway.known && gateway.simulated && invoice.exchangeStatus !== "NOT_SENT" && (
                <p className="text-xs text-muted-foreground">{SIMULATED_SEND_NOTE}</p>
              )}
            </CardContent>
          </Card>

          {/* Credit — whether this customer should be sold to at all, which is
              a question that has to be answered before the document goes out
              rather than after it is on the books. The card is shown only while
              the answer can still change something: a finalised document is
              past the decision, and the gate said what it said. */}
          {invoice.direction === "OUTBOUND" && (unfinalised || gate) && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-2 text-base">
                  <ShieldAlert className="size-4" /> Credit
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {gateAdvice.loading && !standing && <p className="text-muted-foreground">Checking where they stand…</p>}
                {gateAdvice.error && !standing && (
                  <p className="text-muted-foreground">
                    Where {invoice.buyer.nameEn || "the customer"} stands could not be read: {gateAdvice.error} The
                    check runs again when the document is finalised, and it is that one that decides.
                  </p>
                )}
                <CreditPanel
                  gate={standing}
                  error={gateError}
                  override={
                    standing && !standing.allowed
                      ? {
                          reason: overrideReason,
                          setReason: setOverrideReason,
                          busy: finalising,
                          onConfirm: () => void doFinalise(overrideReason.trim()),
                        }
                      : undefined
                  }
                />
                {unfinalised && standing?.allowed === true && (
                  <p className="text-xs text-muted-foreground">
                    Nothing is decided by this. The check runs again when the document is finalised, against what
                    the customer owes at that moment.
                  </p>
                )}
              </CardContent>
            </Card>
          )}

          {/* Sales ledger — what this document did to the books, which is a
              different question from what the network did with it. */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <BookOpen className="size-4" /> Sales ledger
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {notPostable ? (
                <p className="text-muted-foreground">{notPostable}</p>
              ) : (
                <>
                  {ledger.loading && <p className="text-muted-foreground">Checking the books…</p>}
                  {ledger.error && (
                    <p className="text-muted-foreground">
                      The books could not be read: {ledger.error} Posting is still safe to try — the
                      ledger keeps one entry per invoice.
                    </p>
                  )}
                  {posted ? (
                    <>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-muted-foreground">Journal</span>
                        <Link
                          href={journalHref(posted.entryId)}
                          className="font-medium tnum underline-offset-4 hover:underline"
                        >
                          {posted.reference}
                        </Link>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {posted.reversed
                          ? "Posted and since reversed. Both entries stand and they net to nothing, so the books carry no receivable for this invoice — a correction is a new document, not a second posting."
                          : "Receivables, revenue and VAT output carry this invoice."}
                      </p>
                    </>
                  ) : ledger.index && !ledger.index.complete ? (
                    <p className="text-muted-foreground">
                      Not among the {ledger.index.read} movements on {AR_CONTROL} read for this issue
                      date, and the older ones were not read — so from here it is unknown whether this
                      invoice is on the books. Posting it says which: the entry is keyed on the invoice,
                      so a second attempt finds the first entry rather than doubling the revenue.
                    </p>
                  ) : ledger.index ? (
                    <p className="text-muted-foreground">
                      Not on the books. Nothing in the ageing, the VAT return or the trial balance
                      carries this invoice yet.
                    </p>
                  ) : null}

                  {!posted && (
                    <Button
                      size="sm"
                      className="w-full"
                      icon={<BookOpen />}
                      loading={postingToLedger}
                      onClick={postToLedger}
                    >
                      Post to the ledger
                    </Button>
                  )}
                  {posted && !posted.reversed && (
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full"
                      icon={<Landmark />}
                      onClick={() => {
                        setReceiptSuggestion(null);
                        setReceiptOpen(true);
                      }}
                    >
                      Record a receipt
                    </Button>
                  )}
                  {ledgerError && <p className="text-xs text-destructive">{ledgerError}</p>}
                </>
              )}
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
          {/* Said while the person can still decide not to send: on a simulated
              gateway nothing is delivered and nothing is reported, and the
              acceptance that follows is one this deployment writes itself. */}
          {gateway.simulated ? (
            <p className="text-sm text-muted-foreground">
              {invoice.number} will be built and run through the send pipeline, but it will not reach{" "}
              {invoice.buyer.nameEn || "the buyer"} and it will not be reported to the FTA.{" "}
              {SIMULATED_SEND_WARNING}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {invoice.number} will be delivered to {invoice.buyer.nameEn || "the buyer"} and reported to
              the FTA.
            </p>
          )}
          {unfinalised && (
            <p className="mt-2 text-sm text-muted-foreground">
              It is finalised first, which is where the credit limit is checked. A refusal stops here and leaves
              the draft exactly as it is.
            </p>
          )}
          {/* The refusal stays in the dialog the person is standing in, with
              the figures and the override, rather than sending them off to
              another screen to find out what happened. */}
          {(gateError || (gate && !gate.allowed)) && (
            <div className="mt-4 rounded-lg border border-border p-3">
              <CreditPanel
                gate={gate}
                error={gateError}
                override={
                  gate && !gate.allowed
                    ? {
                        reason: overrideReason,
                        setReason: setOverrideReason,
                        busy: finalising,
                        onConfirm: () => void doFinalise(overrideReason.trim()),
                      }
                    : undefined
                }
              />
            </div>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmSend(false)}>
              Cancel
            </Button>
            <Button icon={<Send />} loading={busy || finalising} onClick={doSend}>
              {unfinalised ? "Finalise & send" : "Confirm & send"}
            </Button>
          </div>
        </div>
      </Modal>

      {receiptOpen && (
        <ReceiptModal
          invoice={invoice}
          suggestMinor={receiptSuggestion}
          warning={
            ledger.index && ledger.index.complete && !posted
              ? "This invoice is not on the books, so a receipt against it would credit receivables with no invoice to clear and stand in the ageing as an unapplied credit. Post the invoice first."
              : undefined
          }
          onClose={() => setReceiptOpen(false)}
          onPosted={(entry) => {
            setReceiptOpen(false);
            ledger.reload();
            if (entry.alreadyPosted) {
              toast("That receipt is already on the books", {
                description: `A receipt for this invoice on that date and for that amount was posted as ${entry.reference}. Nothing was posted again.`,
              });
            } else {
              toast.success(`Receipt posted as ${entry.reference}`, {
                description: "The bank is debited and the invoice is cleared in the ageing.",
              });
            }
          }}
        />
      )}

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

/**
 * What the credit gate said, with the figures in it.
 *
 * A refusal that says only "refused" sends the salesperson to accounts and
 * accounts back to the salesperson, and the second time that happens somebody
 * raises the invoice somewhere this product cannot see. So the three numbers
 * the argument is actually about are here — what the customer may owe, what
 * they carry now, and where this document would take them — and each ground is
 * listed separately, because "eight hundred over the limit" and "nobody has
 * ever assessed this account" need opposite responses and a single collapsed
 * verdict cannot tell them apart.
 *
 * Every figure is in the book's own currency, which is the currency a credit
 * limit is held in and not necessarily the one this invoice was raised in. The
 * currency code is printed beside each so the two are never confused.
 */
function CreditPanel({
  gate,
  error,
  override,
}: {
  gate: CreditGate | null;
  /** A sentence from the gate or the route, where one came back. */
  error: string | null;
  /** The override controls, offered only where a refusal can be overridden. */
  override?: {
    reason: string;
    setReason: (v: string) => void;
    onConfirm: () => void;
    busy: boolean;
  };
}) {
  if (!gate && !error) return null;
  const cur = gate?.currency ?? BOOK_CURRENCY;
  /* Figures are shown only where the check actually ran. An unresolved customer
   * or an entity whose books are not open produces no exposure and no limit,
   * and a row of dashes reads like "nil" rather than "not asked". */
  const measured = gate !== null && gate.decision !== "unknown";

  return (
    <div className="space-y-3">
      {gate && (
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={GATE_TONE[gate.decision]} size="sm">
            {GATE_WORD[gate.decision]}
          </Badge>
          {gate.overrode && (
            <Badge tone="warning" size="sm">
              Overridden, on the record
            </Badge>
          )}
        </div>
      )}

      {measured && gate && (
        <dl className="space-y-1.5 text-sm">
          <FigureRow
            label="Credit limit"
            value={gate.limitSet ? gateMoney(gate.creditLimitMinor, cur) : "Never assessed"}
            hint={gate.limitSet && gate.limitEffectiveFrom ? `in force from ${gate.limitEffectiveFrom}` : undefined}
          />
          <FigureRow label="Owed now" value={gateMoney(gate.exposureMinor, cur)} hint="ledger, plus orders taken and not yet billed" />
          <FigureRow label="This document" value={gateMoney(gate.additionalMinor, cur)} />
          <FigureRow label="Would be owed" value={gateMoney(gate.wouldBeMinor, cur)} />
          {gate.overByMinor && gate.overByMinor !== "0" ? (
            <FigureRow label="Over the limit by" value={gateMoney(gate.overByMinor, cur)} tone="bad" />
          ) : (
            <FigureRow label="Left after this" value={gateMoney(gate.headroomMinor, cur)} />
          )}
        </dl>
      )}

      {gate && gate.reasons.length === 0 && <p className="text-xs text-muted-foreground">{gate.headline}</p>}

      {gate && gate.reasons.length > 0 && (
        <ul className="space-y-2">
          {gate.reasons.map((r) => (
            <li key={r.code} className="text-xs text-muted-foreground">
              <Badge tone={r.blocking ? "error" : "warning"} size="sm" className="me-1.5 align-middle">
                {r.blocking ? "stops it" : "worth knowing"}
              </Badge>
              {r.message}
            </li>
          ))}
        </ul>
      )}

      {gate?.caveat && <p className="text-xs text-muted-foreground">{gate.caveat}</p>}
      {/* Shown unless it is the headline again. A refusal answers with the
          gate's own sentence, which the grounds above already carry; anything
          else — a permission the person does not hold, a request that never
          arrived — is news and has to be said. */}
      {error && error !== gate?.headline && <p className="text-xs text-destructive">{error}</p>}

      {override && (
        <div className="space-y-2 rounded-lg border border-destructive/25 bg-destructive/[0.06] p-3">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-destructive">
            <ShieldAlert className="size-3.5" /> Finalise anyway
          </p>
          <p className="text-xs text-muted-foreground">
            An override is allowed and is never silent: the reason, the limit, what the customer already carries
            and the grounds above all go onto this invoice&rsquo;s timeline. It needs the grant that places and
            releases credit holds, which is deliberately not the grant that raises an invoice — so whoever raised
            this one cannot clear their own refusal.
          </p>
          <textarea
            className="w-full rounded-lg border border-input bg-background p-2 text-sm"
            rows={2}
            value={override.reason}
            onChange={(e) => override.setReason(e.target.value)}
            placeholder="Cash on delivery agreed with the customer"
            aria-label="Why this credit refusal is being overridden"
          />
          <Button
            size="sm"
            variant="destructive"
            icon={<ShieldAlert />}
            loading={override.busy}
            disabled={!override.reason.trim()}
            onClick={override.onConfirm}
          >
            Override &amp; finalise
          </Button>
        </div>
      )}
    </div>
  );
}

function FigureRow({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "bad";
}) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">
        {label}
        {hint && <span className="block text-[11px] opacity-80">{hint}</span>}
      </dt>
      <dd className={cn("font-medium tnum", tone === "bad" && "text-destructive")}>{value}</dd>
    </div>
  );
}

function StatusLeg({
  icon,
  label,
  meta,
  qualifier,
}: {
  icon: React.ReactNode;
  label: string;
  meta: { label: string; tone: string; description: string };
  /** Said beside the status where the status is not the whole truth. */
  qualifier?: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-medium">{label}</p>
          <span className="flex items-center gap-1.5">
            {qualifier && (
              <Badge tone="warning" size="sm">
                {qualifier}
              </Badge>
            )}
            <StatusBadge label={meta.label} tone={meta.tone as never} size="sm" />
          </span>
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
