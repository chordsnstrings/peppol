"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { Inbox, CheckCircle2, FileDown, RefreshCw, ShieldCheck, XCircle } from "lucide-react";
import { formatMoney } from "@/lib/domain/money";
import { timeAgo } from "@/lib/utils";
import { useAppState } from "@/lib/app-state";
import { useInbound } from "@/hooks/use-entity-data";
import { touch } from "@/lib/db/database";
import { useGatewayMode } from "@/lib/gateway/mode";
import { LIVE_GATEWAY_SETUP, SIMULATED_LABEL, SIMULATED_SEND_WARNING } from "@/lib/gateway/disclosure";
/* Type only, so nothing from the server module reaches the browser bundle: the
   inbox reads `InboundDoc`, and the receiver stores everything a receiving
   corner needs beyond it on the same row. */
import type { InboundRecord } from "@/lib/server/inbound";
import type { ReceiptDecision } from "@/lib/gateway/port";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Modal } from "@/components/ui/modal";
import { Textarea } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { Avatar } from "@/components/ui/avatar";
import { toast } from "sonner";

interface DecisionResponse {
  doc?: InboundRecord;
  error?: string;
}

interface PollResponse {
  received?: number;
  duplicates?: number;
  skipped?: string[];
  simulated?: boolean;
  error?: string;
}

/**
 * How the decision on a document stands, in the chip beside it.
 *
 * A decision that was never transmitted is never coloured as a completed one.
 * "Rejected" in red reads as an answer the supplier has, and until the receipt
 * has actually left this deployment they have nothing — so an untransmitted
 * decision is amber and says so in the chip rather than only in the small print
 * underneath, which is the half nobody reads.
 */
function decisionChip(doc: InboundRecord) {
  const decision = doc.decision;
  if (!decision) return null;
  const rejected = decision.outcome === "REJECTED";
  const label = rejected ? "Rejected" : "Accepted";
  return (
    <Badge tone={!decision.transmitted ? "warning" : rejected ? "error" : "success"} size="sm">
      {decision.transmitted ? label : `${label} · not sent`}
    </Badge>
  );
}

export default function InboxPage() {
  const { currentEntity } = useAppState();
  const { inbound, loading } = useInbound();
  const gateway = useGatewayMode();

  const docs = inbound as InboundRecord[];

  const [checking, setChecking] = React.useState(false);
  /** The document a rejection is being written for, and the words so far. */
  const [rejecting, setRejecting] = React.useState<InboundRecord | null>(null);
  const [reason, setReason] = React.useState("");
  /** Which row has a decision in flight, so only its own controls go quiet. */
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const participantId = currentEntity?.peppolParticipantId;

  /**
   * Ask the gateway what is waiting for us.
   *
   * On a live driver that pushes over its webhook this politely answers
   * "nothing", which is true. On the simulator it delivers a sample, and the
   * result is reported as the simulation it is — a document this deployment
   * wrote for itself is not "1 new invoice".
   */
  const check = async () => {
    if (!currentEntity) return;
    setChecking(true);
    try {
      const res = await fetch("/api/inbound/poll", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ entityId: currentEntity.id }),
      });
      const body = (await res.json().catch(() => ({}))) as PollResponse;
      if (!res.ok) {
        toast.error("Couldn't check for documents", { description: body.error });
        return;
      }
      touch("inbound");
      touch("notifications");
      const received = body.received ?? 0;
      if (received > 0) {
        const noun = received === 1 ? "document" : "documents";
        if (body.simulated) toast.warning(`${received} simulated ${noun} delivered`);
        else toast.success(`${received} new ${noun}`);
      } else if ((body.duplicates ?? 0) > 0) {
        toast.info("Nothing new — what the gateway offered is already in your inbox");
      } else {
        toast.info("Nothing waiting");
      }
      for (const skipped of body.skipped ?? []) toast.error("A document could not be placed", { description: skipped });
    } finally {
      setChecking(false);
    }
  };

  /**
   * Accept or reject, through the server route that also transmits it.
   *
   * What the toast says is what the SERVER did, never what was asked for: the
   * decision is recorded either way, and whether the supplier heard it depends
   * on the gateway. The note the server wrote is repeated verbatim rather than
   * paraphrased here, so there is one sentence about a rejection nobody sent
   * and not two that can drift apart.
   */
  const decide = async (doc: InboundRecord, outcome: ReceiptDecision, why?: string) => {
    setBusyId(doc.id);
    try {
      const res = await fetch(`/api/inbound/${doc.id}/decision`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: outcome, ...(why ? { reason: why } : {}) }),
      });
      const body = (await res.json().catch(() => ({}))) as DecisionResponse;
      if (!res.ok || !body.doc) {
        toast.error(outcome === "REJECTED" ? "Not rejected" : "Not accepted", {
          description: body.error ?? "The decision was not recorded.",
        });
        return false;
      }
      touch("inbound");
      const decision = body.doc.decision;
      const verb = outcome === "REJECTED" ? "Rejected" : "Accepted";
      if (decision?.transmitted) toast.success(`${verb} — the supplier has been told`);
      else toast.warning(`${verb}, but not sent`, { description: decision?.note });
      return true;
    } finally {
      setBusyId(null);
    }
  };

  const exportDoc = async (doc: InboundRecord) => {
    setBusyId(doc.id);
    try {
      const res = await fetch(`/api/inbound/${doc.id}/export`, { method: "POST", credentials: "same-origin" });
      const body = (await res.json().catch(() => ({}))) as DecisionResponse;
      if (!res.ok) {
        toast.error("Not marked", { description: body.error });
        return;
      }
      touch("inbound");
      // The button sets a marker and that is all it does. Saying "exported to
      // accounting" would describe a hand-off to an accounting system that this
      // does not perform.
      toast.success("Marked as taken into the books", {
        description: "Nothing was sent to an accounting system — this records that you dealt with it.",
      });
    } finally {
      setBusyId(null);
    }
  };

  const submitRejection = async () => {
    if (!rejecting) return;
    const ok = await decide(rejecting, "REJECTED", reason.trim());
    if (ok) {
      setRejecting(null);
      setReason("");
    }
  };

  return (
    <div>
      <PageHeader
        title="Inbox"
        description="Inbound e-invoices your suppliers send you across the network."
        icon={<Inbox />}
        actions={
          <Button
            variant="outline"
            icon={<RefreshCw />}
            loading={checking}
            disabled={!participantId}
            onClick={check}
          >
            Check for documents
          </Button>
        }
      />

      {!loading && docs.length === 0 ? (
        <>
          {/* The old empty state promised that a supplier's invoice "arrives
              here", which on a simulated deployment is not true and cannot be
              made true from this screen. So the promise is only made where it
              holds, and where it does not the reason and the fix are given
              instead. `simulated` without `known` on purpose: until the server
              has answered, the version that promises nothing is the safe one to
              be wrong with. */}
          {gateway.simulated ? (
            <EmptyState
              icon={<Inbox />}
              title="Nothing can arrive here yet"
              description={`This deployment's gateway driver is a simulator, so no supplier can deliver a document to ${participantId ?? "this entity"}. ${LIVE_GATEWAY_SETUP} Until then, "Check for documents" delivers a sample so you can see what receiving one looks like.`}
            />
          ) : (
            <EmptyState
              icon={<Inbox />}
              title="No inbound invoices yet"
              description="When a supplier sends you an e-invoice through Peppol, it arrives here — validated, with a human-readable view and one-click export to your accounting."
            />
          )}
          <div className="mx-auto mt-4 flex max-w-xl items-center gap-2 rounded-xl border border-border bg-card p-3 text-sm text-muted-foreground">
            <ShieldCheck className="size-4 shrink-0 text-success" />
            Your Peppol receiving address is{" "}
            <span className="font-mono text-xs text-foreground">{participantId ?? "—"}</span>
          </div>
        </>
      ) : (
        <div className="space-y-3">
          {docs.map((doc, i) => (
            <motion.div key={doc.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }}>
              <Card className="p-4 hover-lift">
                <div className="flex items-center gap-4">
                  <Avatar name={doc.senderName} size={44} rounded="lg" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate font-medium">{doc.senderName}</p>
                      <Badge tone={doc.status === "VALID" ? "success" : "warning"} size="sm" dot>
                        {doc.status === "VALID" ? "Valid" : "Has issues"}
                      </Badge>
                      {/* A document the simulator produced is labelled wherever
                          it appears, exactly as a simulated send is. */}
                      {doc.simulated && (
                        <Badge tone="warning" size="sm">
                          {SIMULATED_LABEL}
                        </Badge>
                      )}
                      {decisionChip(doc)}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      {doc.invoice?.number ? `${doc.invoice.number} · ` : ""}
                      {doc.senderParticipantId} · {timeAgo(doc.receivedAt)}
                    </p>
                  </div>
                  <p className="hidden font-semibold tnum sm:block">
                    {formatMoney(doc.totalMinor, doc.currency)}
                  </p>
                  <div className="flex items-center gap-1.5">
                    {!doc.decision && (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          icon={<CheckCircle2 />}
                          disabled={busyId === doc.id}
                          onClick={() => decide(doc, "ACCEPTED")}
                        >
                          <span className="hidden sm:inline">Accept</span>
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<XCircle />}
                          disabled={busyId === doc.id}
                          onClick={() => {
                            setRejecting(doc);
                            setReason("");
                          }}
                        >
                          <span className="hidden sm:inline">Reject</span>
                        </Button>
                      </>
                    )}
                    {doc.decision?.outcome !== "REJECTED" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<FileDown />}
                        disabled={busyId === doc.id || doc.buyerAction === "EXPORTED"}
                        onClick={() => exportDoc(doc)}
                      >
                        <span className="hidden sm:inline">
                          {doc.buyerAction === "EXPORTED" ? "In the books" : "Take into books"}
                        </span>
                      </Button>
                    )}
                  </div>
                </div>

                {(doc.note || doc.issues?.length || doc.decision) && (
                  <div className="mt-3 space-y-1.5 border-t border-border pt-3 text-xs text-muted-foreground">
                    {doc.note && <p>{doc.note}</p>}
                    {doc.issues?.map((issue) => (
                      <p key={issue}>{issue}</p>
                    ))}
                    {doc.decision && (
                      <p>
                        {doc.decision.outcome === "REJECTED" ? "Rejected" : "Accepted"} on{" "}
                        {doc.decision.decidedAt.slice(0, 10)}
                        {doc.decision.reason ? ` — “${doc.decision.reason}”` : ""}
                        {/* The server's own sentence about what did not happen,
                            repeated rather than restated. */}
                        {doc.decision.note ? ` ${doc.decision.note}` : ""}
                      </p>
                    )}
                  </div>
                )}
              </Card>
            </motion.div>
          ))}
        </div>
      )}

      <Modal
        open={Boolean(rejecting)}
        onClose={() => setRejecting(null)}
        title="Reject this document?"
        size="sm"
      >
        <div className="space-y-3 p-5">
          {/* Said while the person can still decide not to: on a simulated
              gateway the rejection is recorded here and the supplier never
              hears it, which is the whole difference between refusing a
              document and filing a note about it. */}
          <p className="text-sm text-muted-foreground">
            {gateway.simulated ? (
              <>
                Your rejection will be recorded here, but it will not reach{" "}
                {rejecting?.senderName ?? "the supplier"}. {SIMULATED_SEND_WARNING}
              </>
            ) : (
              <>
                {rejecting?.senderName ?? "The supplier"} is sent your reason, so they can issue a corrected
                document instead of chasing the payment.
              </>
            )}
          </p>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            placeholder="Why is this document being refused? (e.g. the goods were never delivered)"
            aria-label="Reason for rejecting this document"
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setRejecting(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={!reason.trim()}
              loading={busyId === rejecting?.id}
              onClick={submitRejection}
            >
              Reject
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
