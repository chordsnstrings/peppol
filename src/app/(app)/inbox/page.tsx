"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { Inbox, CheckCircle2, FileDown, Reply, ShieldCheck, Info } from "lucide-react";
import { formatMoney } from "@/lib/domain/money";
import { timeAgo } from "@/lib/utils";
import { useAppState } from "@/lib/app-state";
import { useInbound } from "@/hooks/use-entity-data";
import { put } from "@/lib/db/database";
import type { InboundDoc } from "@/lib/domain/types";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Avatar } from "@/components/ui/avatar";
import { toast } from "sonner";

export default function InboxPage() {
  const { currentEntity } = useAppState();
  const { inbound, loading } = useInbound();

  const acknowledge = async (doc: InboundDoc) => {
    await put("inbound", { ...doc, buyerAction: "ACKNOWLEDGED" });
    toast.success("Acknowledged");
  };
  const exportDoc = async (doc: InboundDoc) => {
    await put("inbound", { ...doc, buyerAction: "EXPORTED" });
    toast.success("Exported to accounting");
  };

  return (
    <div>
      <PageHeader
        title="Inbox"
        description="Inbound e-invoices your suppliers send you across the network."
        icon={<Inbox />}
      />

      {!loading && inbound.length === 0 ? (
        <>
          <EmptyState
            icon={<Inbox />}
            title="No inbound invoices yet"
            description="When a supplier sends you an e-invoice through Peppol, it arrives here — validated, with a human-readable view and one-click export to your accounting."
          />
          <div className="mx-auto mt-4 flex max-w-xl items-center gap-2 rounded-xl border border-border bg-card p-3 text-sm text-muted-foreground">
            <ShieldCheck className="size-4 shrink-0 text-success" />
            Your Peppol receiving address is{" "}
            <span className="font-mono text-xs text-foreground">
              {currentEntity?.peppolParticipantId ?? "—"}
            </span>
          </div>
        </>
      ) : (
        <div className="space-y-3">
          {inbound.map((doc, i) => (
            <motion.div key={doc.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.03 }}>
              <Card className="flex items-center gap-4 p-4 hover-lift">
                <Avatar name={doc.senderName} size={44} rounded="lg" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate font-medium">{doc.senderName}</p>
                    <Badge tone={doc.status === "VALID" ? "success" : "warning"} size="sm" dot>
                      {doc.status === "VALID" ? "Valid" : "Has issues"}
                    </Badge>
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    {doc.senderParticipantId} · {timeAgo(doc.receivedAt)}
                  </p>
                </div>
                <p className="hidden font-semibold tnum sm:block">
                  {formatMoney(doc.totalMinor, doc.currency)}
                </p>
                <div className="flex items-center gap-1.5">
                  {doc.buyerAction === "NONE" ? (
                    <Button size="sm" variant="outline" icon={<CheckCircle2 />} onClick={() => acknowledge(doc)}>
                      <span className="hidden sm:inline">Acknowledge</span>
                    </Button>
                  ) : (
                    <Badge tone="neutral" size="sm">
                      {doc.buyerAction.toLowerCase()}
                    </Badge>
                  )}
                  <Button size="sm" variant="ghost" icon={<FileDown />} onClick={() => exportDoc(doc)}>
                    <span className="hidden sm:inline">Export</span>
                  </Button>
                </div>
              </Card>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}
