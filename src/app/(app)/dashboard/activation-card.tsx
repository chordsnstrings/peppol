"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronDown, PartyPopper, Rocket } from "lucide-react";
import { cn } from "@/lib/utils";
import { saveEntity } from "@/lib/db/repo";
import { notify } from "@/lib/db/repo";
import type { Entity } from "@/lib/domain/types";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/controls";
import { toast } from "sonner";

export function ActivationCard({ entity, sentCount }: { entity: Entity; sentCount: number }) {
  const [open, setOpen] = React.useState(true);

  const checklist = {
    detailsComplete: Boolean(entity.legalNameEn && (entity.trn || entity.tin)),
    sandboxTestSent: sentCount > 0 || entity.activationChecklist.sandboxTestSent,
    emaratConfirmed: entity.activationChecklist.emaratConfirmed,
    agreementAccepted: entity.activationChecklist.agreementAccepted,
  };

  const items = [
    { key: "detailsComplete", label: "Complete entity details", done: checklist.detailsComplete },
    { key: "sandboxTestSent", label: "Send a sandbox test invoice", done: checklist.sandboxTestSent },
    { key: "emaratConfirmed", label: "Confirm ASP designation in EmaraTax", done: checklist.emaratConfirmed },
    { key: "agreementAccepted", label: "Accept the service agreement", done: checklist.agreementAccepted },
  ] as const;

  const doneCount = items.filter((i) => i.done).length;
  const pct = (doneCount / items.length) * 100;
  const allDone = doneCount === items.length;

  if (entity.einvoicingStatus === "LIVE") return null;

  const toggle = async (key: "emaratConfirmed" | "agreementAccepted", v: boolean) => {
    await saveEntity({
      ...entity,
      activationChecklist: { ...entity.activationChecklist, [key]: v, sandboxTestSent: checklist.sandboxTestSent },
    });
  };

  const goLive = async () => {
    await saveEntity({ ...entity, einvoicingStatus: "LIVE" });
    await notify(entity.orgId, {
      type: "entity.live",
      title: `${entity.legalNameEn} is now live`,
      body: "Real invoices will transmit across the Peppol network.",
      tone: "success",
    });
    toast.success("You're live!", { description: "This entity is now activated for production." });
  };

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mt-6">
      <Card className="overflow-hidden border-gold/20 bg-gradient-to-br from-gold/[0.06] to-transparent">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center gap-4 p-5 text-start"
        >
          <div className="relative flex size-11 shrink-0 items-center justify-center rounded-xl bg-gold/15 text-[hsl(var(--gold))]">
            <Rocket className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="font-display font-semibold">Activate this entity</h3>
              <span className="text-xs font-medium text-muted-foreground tnum">
                {doneCount}/{items.length}
              </span>
            </div>
            <div className="mt-2 max-w-xs">
              <Progress value={pct} tone="gold" />
            </div>
          </div>
          <ChevronDown
            className={cn("size-5 text-muted-foreground transition-transform", open && "rotate-180")}
          />
        </button>

        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.25 }}
              className="overflow-hidden"
            >
              <div className="space-y-1 border-t border-gold/15 p-3 sm:p-4">
                {items.map((item) => (
                  <div
                    key={item.key}
                    className="flex items-center gap-3 rounded-xl px-2.5 py-2.5 transition-colors hover:bg-background/50"
                  >
                    <span
                      className={cn(
                        "flex size-6 shrink-0 items-center justify-center rounded-full border transition-colors",
                        item.done
                          ? "border-success bg-success text-white"
                          : "border-border text-transparent",
                      )}
                    >
                      <Check className="size-3.5" strokeWidth={3} />
                    </span>
                    <span
                      className={cn(
                        "flex-1 text-sm",
                        item.done ? "text-muted-foreground line-through" : "font-medium",
                      )}
                    >
                      {item.label}
                    </span>
                    {(item.key === "emaratConfirmed" || item.key === "agreementAccepted") && (
                      <Switch
                        checked={item.done}
                        onCheckedChange={(v) => toggle(item.key, v)}
                      />
                    )}
                    {item.key === "sandboxTestSent" && !item.done && (
                      <span className="text-xs text-muted-foreground">Send any invoice</span>
                    )}
                  </div>
                ))}

                <div className="flex items-center justify-between gap-3 rounded-xl bg-background/60 p-3">
                  <div className="flex items-center gap-2 text-sm">
                    <PartyPopper className={cn("size-5", allDone ? "text-gold" : "text-muted-foreground")} />
                    <span className={allDone ? "font-medium" : "text-muted-foreground"}>
                      {allDone ? "Everything's ready — flip the switch." : "Finish the steps to go live."}
                    </span>
                  </div>
                  <Button variant="gold" size="sm" disabled={!allDone} onClick={goLive}>
                    Go live
                  </Button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </Card>
    </motion.div>
  );
}
