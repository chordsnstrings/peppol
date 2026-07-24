"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { Plug, Check, Zap, Info, Link2, Unlink, ShieldCheck } from "lucide-react";
import { cn, id as makeId, timeAgo } from "@/lib/utils";
import { useAppState } from "@/lib/app-state";
import { useCollection } from "@/lib/db/hooks";
import { put, remove } from "@/lib/db/database";
import type { Connection } from "@/lib/domain/types";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/controls";
import { Modal } from "@/components/ui/modal";
import { toast } from "sonner";

const PROVIDERS = [
  { id: "ZOHO_BOOKS", name: "Zoho Books", color: "#e42527", blurb: "OAuth sync of invoices, customers & items.", oauth: true },
  { id: "QBO", name: "QuickBooks Online", color: "#2ca01c", blurb: "Two-way status sync with QBO.", oauth: true },
  { id: "XERO", name: "Xero", color: "#13b5ea", blurb: "Multi-tenant invoice import.", oauth: true },
  { id: "ODOO", name: "Odoo", color: "#714b67", blurb: "JSON-RPC connector, API-key auth.", oauth: true },
  { id: "TALLY_FILE", name: "Tally", color: "#c99b2f", blurb: "Guided Sales Register export presets.", oauth: false },
] as const;

export default function IntegrationsPage() {
  const { currentEntity } = useAppState();
  const { data: connections } = useCollection<Connection>("connections", {
    index: currentEntity ? { name: "entityId", value: currentEntity.id } : undefined,
    deps: [currentEntity?.id],
  });
  const [connecting, setConnecting] = React.useState<(typeof PROVIDERS)[number] | null>(null);

  const byProvider = new Map(connections.map((c) => [c.provider, c]));

  const connect = async (provider: (typeof PROVIDERS)[number]) => {
    if (!currentEntity) return;
    const now = new Date().toISOString();
    const conn: Connection = {
      id: makeId("con"),
      orgId: currentEntity.orgId,
      entityId: currentEntity.id,
      provider: provider.id,
      status: "CONNECTED",
      autoSend: false,
      lastSyncAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await put("connections", conn);
    setConnecting(null);
    toast.success(`${provider.name} connected`, { description: "Live sync activates when credentials are configured." });
  };

  const disconnect = async (conn: Connection) => {
    await remove("connections", conn.id);
    toast.success("Disconnected");
  };

  const toggleAutoSend = async (conn: Connection, v: boolean) => {
    await put("connections", { ...conn, autoSend: v, updatedAt: new Date().toISOString() });
  };

  return (
    <div>
      <PageHeader
        title="Integrations"
        description="Connect your accounting software so invoices flow in automatically — no double entry."
        icon={<Plug />}
      />

      <div className="mb-4 flex items-center gap-2 rounded-xl border border-info/25 bg-info/[0.05] p-3 text-sm">
        <Info className="size-4 shrink-0 text-info" />
        <span className="text-muted-foreground">
          Connections use OAuth. Live sync runs once provider credentials are configured for your
          environment — your connection choices are saved here.
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {PROVIDERS.map((p, i) => {
          const conn = byProvider.get(p.id);
          return (
            <motion.div key={p.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
              <Card className="flex h-full flex-col p-5 hover-lift">
                <div className="flex items-start justify-between">
                  <div
                    className="flex size-12 items-center justify-center rounded-xl font-display text-lg font-bold text-white"
                    style={{ background: p.color }}
                  >
                    {p.name[0]}
                  </div>
                  {conn ? (
                    <Badge tone="success" dot>
                      Connected
                    </Badge>
                  ) : (
                    <Badge tone="neutral">{p.oauth ? "OAuth" : "File"}</Badge>
                  )}
                </div>
                <h3 className="mt-4 font-display font-semibold">{p.name}</h3>
                <p className="mt-1 flex-1 text-sm text-muted-foreground">{p.blurb}</p>

                {conn ? (
                  <div className="mt-4 space-y-3">
                    <div className="flex items-center justify-between rounded-lg bg-muted/50 p-2.5">
                      <span className="text-xs text-muted-foreground">Auto-send valid invoices</span>
                      <Switch checked={conn.autoSend} onCheckedChange={(v) => toggleAutoSend(conn, v)} />
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-xs text-muted-foreground">
                        Synced {conn.lastSyncAt ? timeAgo(conn.lastSyncAt) : "—"}
                      </span>
                      <Button variant="ghost" size="sm" icon={<Unlink />} onClick={() => disconnect(conn)}>
                        Disconnect
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button
                    className="mt-4 w-full"
                    variant="outline"
                    icon={p.oauth ? <Link2 /> : <Zap />}
                    onClick={() => (p.oauth ? setConnecting(p) : toast("Tally export guide", { description: "Use the Sales Register preset in the importer." }))}
                  >
                    {p.oauth ? "Connect" : "View export guide"}
                  </Button>
                )}
              </Card>
            </motion.div>
          );
        })}
      </div>

      <Modal
        open={Boolean(connecting)}
        onClose={() => setConnecting(null)}
        title={`Connect ${connecting?.name}`}
        size="md"
      >
        <div className="p-5 sm:p-6">
          <div className="flex items-center gap-3 rounded-xl bg-muted/50 p-4">
            <div
              className="flex size-11 items-center justify-center rounded-xl font-display text-lg font-bold text-white"
              style={{ background: connecting?.color }}
            >
              {connecting?.name[0]}
            </div>
            <div>
              <p className="font-medium">{connecting?.name}</p>
              <p className="text-xs text-muted-foreground">Read invoices, customers, items & tax rates</p>
            </div>
          </div>
          <ul className="mt-4 space-y-2 text-sm">
            {["Import invoices from a chosen start date", "Map provider tax rates to your profiles", "Match customers by TRN, then name", "Sync statuses back to the source"].map((f) => (
              <li key={f} className="flex items-center gap-2.5">
                <Check className="size-4 text-success" /> {f}
              </li>
            ))}
          </ul>
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-border p-3 text-xs text-muted-foreground">
            <ShieldCheck className="size-4 shrink-0" />
            Tokens are encrypted at rest. You can disconnect anytime.
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConnecting(null)}>
              Cancel
            </Button>
            <Button icon={<Link2 />} onClick={() => connecting && connect(connecting)}>
              Authorize & connect
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
