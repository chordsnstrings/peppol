"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AlertTriangle, Check, ChevronDown, PartyPopper, Rocket } from "lucide-react";
import { cn } from "@/lib/utils";
import { saveEntity } from "@/lib/db/repo";
import { notify } from "@/lib/db/repo";
import { useGatewayMode } from "@/lib/gateway/mode";
import { LIVE_ENTITY_ON_SIMULATOR, SIMULATED_ACTIVATION_BLOCK } from "@/lib/gateway/disclosure";
import type { Entity } from "@/lib/domain/types";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Switch } from "@/components/ui/controls";
import { toast } from "sonner";

export function ActivationCard({ entity, sentCount }: { entity: Entity; sentCount: number }) {
  const [open, setOpen] = React.useState(true);
  const gateway = useGatewayMode();

  const checklist = {
    detailsComplete: Boolean(entity.legalNameEn && (entity.trn || entity.tin)),
    sandboxTestSent: sentCount > 0 || entity.activationChecklist.sandboxTestSent,
    emaratConfirmed: entity.activationChecklist.emaratConfirmed,
    agreementAccepted: entity.activationChecklist.agreementAccepted,
  };

  /*
   * The last item is the only one on this list that is a fact rather than an
   * attestation: the other four are things the user tells us, and this one is
   * read off the deployment. Going live used to be four self-ticked boxes on a
   * deployment whose gateway invents its own acceptances, which is how a
   * business could be told the FTA had a filing that was never sent. So the
   * prerequisite sits in the checklist where it is visible, and it cannot be
   * ticked from here — only a deployer setting the environment can tick it.
   */
  const items = [
    { key: "detailsComplete", label: "Complete entity details", done: checklist.detailsComplete },
    { key: "sandboxTestSent", label: "Send a sandbox test invoice", done: checklist.sandboxTestSent },
    { key: "emaratConfirmed", label: "Confirm ASP designation in EmaraTax", done: checklist.emaratConfirmed },
    { key: "agreementAccepted", label: "Accept the service agreement", done: checklist.agreementAccepted },
    { key: "gatewayReal", label: "Gateway able to reach the Peppol network", done: !gateway.simulated },
  ] as const;

  const doneCount = items.filter((i) => i.done).length;
  const pct = (doneCount / items.length) * 100;
  const allDone = doneCount === items.length;

  if (entity.einvoicingStatus === "LIVE") {
    /*
     * An entity marked live on a deployment that cannot transmit. The send
     * pipeline refuses these outright, so without this the user meets an
     * unexplained failure at the moment they send an invoice. Waiting for
     * `known` avoids accusing a live deployment of being a simulator during the
     * first paint, before the gateway has answered.
     */
    if (!(gateway.known && gateway.simulated)) return null;
    return (
      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="mt-6">
        <Card className="flex items-start gap-3 border-warning/30 bg-warning/[0.06] p-5">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" />
          <div className="min-w-0">
            <h3 className="font-display font-semibold">This entity is live, but nothing can transmit</h3>
            <p className="mt-1 text-sm text-muted-foreground">{LIVE_ENTITY_ON_SIMULATOR}</p>
          </div>
        </Card>
      </motion.div>
    );
  }

  const toggle = async (key: "emaratConfirmed" | "agreementAccepted", v: boolean) => {
    await saveEntity({
      ...entity,
      activationChecklist: { ...entity.activationChecklist, [key]: v, sandboxTestSent: checklist.sandboxTestSent },
    });
  };

  const goLive = async () => {
    // The button is disabled in this state; this is the second lock on the same
    // door, because a disabled button is a courtesy and the server-side refusal
    // in the send pipeline is the actual control.
    if (gateway.simulated) {
      toast.error("Can't go live yet", { description: SIMULATED_ACTIVATION_BLOCK });
      return;
    }
    await saveEntity({ ...entity, einvoicingStatus: "LIVE" });
    await notify(entity.orgId, {
      type: "entity.live",
      title: `${entity.legalNameEn} is now live`,
      body: `Invoices sent from this entity now transmit across the Peppol network through the ${gateway.driver ?? "configured"} gateway.`,
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
                    {item.key === "gatewayReal" && !item.done && (
                      <span className="text-xs text-muted-foreground">Set by the server</span>
                    )}
                  </div>
                ))}

                {gateway.simulated && (
                  <div className="flex items-start gap-2.5 rounded-xl border border-warning/30 bg-warning/[0.06] p-3 text-sm">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" />
                    <span className="text-muted-foreground">
                      <span className="font-medium text-foreground">Going live is unavailable here.</span>{" "}
                      {SIMULATED_ACTIVATION_BLOCK}
                    </span>
                  </div>
                )}

                <div className="flex items-center justify-between gap-3 rounded-xl bg-background/60 p-3">
                  <div className="flex items-center gap-2 text-sm">
                    <PartyPopper className={cn("size-5", allDone ? "text-gold" : "text-muted-foreground")} />
                    <span className={allDone ? "font-medium" : "text-muted-foreground"}>
                      {gateway.simulated
                        ? "This deployment can't transmit yet."
                        : allDone
                          ? "Everything's ready — flip the switch."
                          : "Finish the steps to go live."}
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
