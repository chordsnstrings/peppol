"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  Wrench,
  AlertTriangle,
  Clock,
  Info,
  ShieldCheck,
  ArrowRight,
  Send,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useAppState } from "@/lib/app-state";
import { useInvoices } from "@/hooks/use-entity-data";
import { deriveFixits } from "@/lib/fixit";
import { sendInvoice } from "@/lib/db/repo";
import { getById } from "@/lib/db/database";
import type { FixitItem, Invoice } from "@/lib/domain/types";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Segmented } from "@/components/ui/controls";
import { toast } from "sonner";

const KIND_META: Record<string, { label: string; icon: React.ReactNode }> = {
  VALIDATION: { label: "Validation", icon: <AlertTriangle /> },
  CLOCK: { label: "Compliance clock", icon: <Clock /> },
  DELIVERY: { label: "Delivery", icon: <Send /> },
  REPORTING: { label: "Reporting", icon: <Info /> },
  SYSTEM: { label: "In transit", icon: <Clock /> },
};

export default function FixitPage() {
  const router = useRouter();
  const { currentEntity } = useAppState();
  const { invoices } = useInvoices();
  const [filter, setFilter] = React.useState<"all" | "ERROR" | "WARNING">("all");

  const items = React.useMemo(() => deriveFixits(invoices), [invoices]);
  const shown = items.filter((i) => filter === "all" || i.severity === filter);
  const errors = items.filter((i) => i.severity === "ERROR").length;
  const warnings = items.filter((i) => i.severity === "WARNING").length;

  const resolve = async (item: FixitItem) => {
    if (!item.ref) return;
    if (item.kind === "VALIDATION") {
      router.push(`/invoices/new?from=${item.ref}`);
      return;
    }
    if (item.kind === "CLOCK" && currentEntity) {
      const inv = (await getById("invoices", item.ref)) as Invoice | undefined;
      if (inv && (inv.lifecycleStatus === "DRAFT" || inv.lifecycleStatus === "READY")) {
        try {
          await sendInvoice(inv, currentEntity);
          toast.success("Sent", { description: `${inv.number} is on its way.` });
        } catch {
          router.push(`/invoices/${item.ref}`);
        }
      } else {
        router.push(`/invoices/${item.ref}`);
      }
      return;
    }
    router.push(`/invoices/${item.ref}`);
  };

  return (
    <div>
      <PageHeader
        title="Fix-it queue"
        description="Everything blocking compliance, in one place — each with a clear next step."
        icon={<Wrench />}
      />

      {items.length === 0 ? (
        <EmptyState
          icon={<ShieldCheck />}
          title="Nothing needs fixing"
          description="You're fully compliant. New issues will land here with a plain-language explanation and a one-click fix."
          action={<Button onClick={() => router.push("/invoices")}>View invoices</Button>}
        />
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <Segmented
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: `All (${items.length})` },
                { value: "ERROR", label: `To fix (${errors})` },
                { value: "WARNING", label: `To review (${warnings})` },
              ]}
            />
          </div>

          <div className="space-y-3">
            <AnimatePresence initial={false}>
              {shown.map((item, i) => (
                <motion.div
                  key={item.id}
                  layout
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ delay: i * 0.03 }}
                >
                  <Card
                    className={cn(
                      "flex items-start gap-4 p-4 hover-lift sm:p-5",
                      item.severity === "ERROR"
                        ? "border-s-2 border-s-destructive"
                        : "border-s-2 border-s-warning",
                    )}
                  >
                    <div
                      className={cn(
                        "flex size-11 shrink-0 items-center justify-center rounded-xl [&_svg]:size-5",
                        item.severity === "ERROR"
                          ? "bg-destructive/10 text-destructive"
                          : "bg-warning/10 text-[hsl(var(--warning))]",
                      )}
                    >
                      {KIND_META[item.kind]?.icon ?? <Info />}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium">{item.title}</p>
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
                          {KIND_META[item.kind]?.label ?? item.kind}
                        </span>
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">{item.body}</p>
                    </div>
                    <Button
                      variant={item.severity === "ERROR" ? "primary" : "outline"}
                      size="sm"
                      className="shrink-0"
                      onClick={() => resolve(item)}
                    >
                      {item.kind === "VALIDATION" ? "Fix" : item.kind === "CLOCK" ? "Send now" : "Review"}
                      <ArrowRight className="size-4 rtl:rotate-180" />
                    </Button>
                  </Card>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </>
      )}
    </div>
  );
}
