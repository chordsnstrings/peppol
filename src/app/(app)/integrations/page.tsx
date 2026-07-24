"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { motion } from "framer-motion";
import {
  Plug,
  Check,
  Zap,
  Info,
  Link2,
  Unlink,
  ShieldCheck,
  RefreshCw,
  Sparkles,
  MessageCircle,
} from "lucide-react";
import { cn, id as makeId, timeAgo } from "@/lib/utils";
import { useAppState } from "@/lib/app-state";
import { useCollection } from "@/lib/db/hooks";
import { put, remove } from "@/lib/db/database";
import { syncConnection } from "@/lib/integrations/sync-client";
import { connectWhatsApp, disconnectWhatsApp } from "@/lib/whatsapp-client";
import type { Connection, WhatsAppConfig } from "@/lib/domain/types";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/controls";
import { Modal } from "@/components/ui/modal";
import { toast } from "sonner";

const PROVIDERS = [
  { id: "ZOHO_BOOKS", slug: "zoho", name: "Zoho Books", color: "#e42527", blurb: "OAuth sync of invoices, customers & items.", oauth: true },
  { id: "QBO", slug: "qbo", name: "QuickBooks Online", color: "#2ca01c", blurb: "Two-way status sync with QBO.", oauth: true },
  { id: "XERO", slug: "xero", name: "Xero", color: "#13b5ea", blurb: "Multi-tenant invoice import.", oauth: true },
  { id: "ODOO", slug: "odoo", name: "Odoo", color: "#714b67", blurb: "JSON-RPC connector, API-key auth.", oauth: true },
  { id: "SHOPIFY", slug: "shopify", name: "Shopify", color: "#5a863e", blurb: "Turn store orders into compliant invoices.", oauth: true },
  { id: "WOOCOMMERCE", slug: "woo", name: "WooCommerce", color: "#7f54b3", blurb: "Sync WooCommerce orders as invoices.", oauth: true },
  { id: "TALLY_FILE", slug: "tally", name: "Tally", color: "#c99b2f", blurb: "Guided Sales Register export presets.", oauth: false },
] as const;

type Provider = (typeof PROVIDERS)[number];

export default function IntegrationsPage() {
  return (
    <React.Suspense fallback={null}>
      <IntegrationsInner />
    </React.Suspense>
  );
}

function IntegrationsInner() {
  const { currentEntity } = useAppState();
  const router = useRouter();
  const params = useSearchParams();
  const { data: connections } = useCollection<Connection>("connections", {
    index: currentEntity ? { name: "entityId", value: currentEntity.id } : undefined,
    deps: [currentEntity?.id],
  });
  const { data: waConfigs } = useCollection<WhatsAppConfig>("whatsapp", {
    index: currentEntity ? { name: "entityId", value: currentEntity.id } : undefined,
    deps: [currentEntity?.id],
  });
  const wa = waConfigs.find((c) => c.entityId === currentEntity?.id);
  const [connecting, setConnecting] = React.useState<Provider | null>(null);
  const [syncingId, setSyncingId] = React.useState<string | null>(null);
  const [waOpen, setWaOpen] = React.useState(false);
  const [waNumber, setWaNumber] = React.useState("");
  const [waPhoneId, setWaPhoneId] = React.useState("");
  const [waBusy, setWaBusy] = React.useState(false);
  const processed = React.useRef<Set<string>>(new Set());

  const byProvider = new Map(connections.map((c) => [c.provider, c]));

  // Handle the OAuth callback return: create the connection + first sync.
  React.useEffect(() => {
    if (!currentEntity) return;
    const error = params.get("error");
    if (error) {
      toast.error("Connection cancelled", { description: "The provider didn't authorize access." });
      router.replace("/integrations");
      return;
    }
    const connected = params.get("connected");
    const slug = params.get("provider");
    const mode = (params.get("mode") as "live" | "mock") ?? "mock";
    if (!connected || !slug || processed.current.has(connected)) return;
    processed.current.add(connected);

    const provider = PROVIDERS.find((p) => p.slug === slug);
    if (!provider) return;

    (async () => {
      const now = new Date().toISOString();
      const existing = connections.find((c) => c.id === connected);
      const conn: Connection = {
        id: connected,
        orgId: currentEntity.orgId,
        entityId: currentEntity.id,
        provider: provider.id,
        status: "CONNECTED",
        mode,
        autoSend: existing?.autoSend ?? false,
        syncedCount: existing?.syncedCount ?? 0,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await put("connections", conn);
      router.replace("/integrations");
      toast.success(`${provider.name} connected`, {
        description: mode === "mock" ? "Sandbox mode — pulling a sample." : "Syncing your invoices…",
      });
      try {
        setSyncingId(conn.id);
        const outcome = await syncConnection(currentEntity, conn, slug);
        toast.success(`Imported ${outcome.imported} invoice${outcome.imported === 1 ? "" : "s"}`, {
          description: `${outcome.updated} updated · ${outcome.skipped} unchanged${outcome.mode === "mock" ? " · sandbox sample" : ""}`,
        });
      } catch (e) {
        toast.error("Sync failed", { description: e instanceof Error ? e.message : undefined });
      } finally {
        setSyncingId(null);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, currentEntity]);

  const connect = (provider: Provider) => {
    const connectionId = makeId("con");
    window.location.href = `/api/integrations/${provider.slug}/authorize?connectionId=${connectionId}`;
  };

  const runSync = async (conn: Connection) => {
    if (!currentEntity) return;
    const slug = PROVIDERS.find((p) => p.id === conn.provider)?.slug ?? "zoho";
    setSyncingId(conn.id);
    try {
      const outcome = await syncConnection(currentEntity, conn, slug);
      toast.success(
        outcome.imported + outcome.updated === 0
          ? "Already up to date"
          : `Synced ${outcome.imported} new · ${outcome.updated} updated`,
        { description: outcome.mode === "mock" ? "Sandbox sample" : undefined },
      );
    } catch (e) {
      toast.error("Sync failed", { description: e instanceof Error ? e.message : undefined });
    } finally {
      setSyncingId(null);
    }
  };

  const disconnect = async (conn: Connection) => {
    const slug = PROVIDERS.find((p) => p.id === conn.provider)?.slug ?? "zoho";
    await fetch(`/api/integrations/${slug}/disconnect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ connectionId: conn.id }),
    }).catch(() => {});
    await remove("connections", conn.id);
    toast.success("Disconnected");
  };

  const toggleAutoSend = async (conn: Connection, v: boolean) => {
    await put("connections", { ...conn, autoSend: v, updatedAt: new Date().toISOString() });
  };

  const saveWhatsApp = async () => {
    if (!currentEntity) return;
    const number = waNumber.trim();
    if (!number) {
      toast.error("Enter your WhatsApp number");
      return;
    }
    setWaBusy(true);
    try {
      await connectWhatsApp({ entityId: currentEntity.id, displayNumber: number, phoneNumberId: waPhoneId.trim() || undefined });
      toast.success("WhatsApp connected", { description: "You can now send invoices over WhatsApp." });
      setWaOpen(false);
      setWaNumber("");
      setWaPhoneId("");
    } catch (e) {
      toast.error("Couldn't connect", { description: e instanceof Error ? e.message : undefined });
    } finally {
      setWaBusy(false);
    }
  };

  const removeWhatsApp = async () => {
    if (!currentEntity) return;
    try {
      await disconnectWhatsApp(currentEntity.id);
      toast.success("WhatsApp disconnected");
    } catch (e) {
      toast.error("Couldn't disconnect", { description: e instanceof Error ? e.message : undefined });
    }
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
          Each workspace connects its own accounts, isolated from every other tenant. Live sync uses
          OAuth; without provider credentials a sandbox sample runs so you can see the flow end-to-end.
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {PROVIDERS.map((p, i) => {
          const conn = byProvider.get(p.id);
          const busy = conn ? syncingId === conn.id : false;
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
                    <Badge tone={conn.mode === "live" ? "success" : "gold"} dot>
                      {conn.mode === "live" ? "Live" : "Sandbox"}
                    </Badge>
                  ) : (
                    <Badge tone="neutral">{p.oauth ? "OAuth" : "File"}</Badge>
                  )}
                </div>
                <h3 className="mt-4 font-display font-semibold">{p.name}</h3>
                <p className="mt-1 flex-1 text-sm text-muted-foreground">{p.blurb}</p>

                {conn ? (
                  <div className="mt-4 space-y-3">
                    <div className="flex items-center justify-between rounded-lg bg-muted/50 px-2.5 py-2 text-xs">
                      <span className="text-muted-foreground">Imported</span>
                      <span className="font-semibold tnum">{conn.syncedCount ?? 0}</span>
                    </div>
                    <div className="flex items-center justify-between rounded-lg bg-muted/50 p-2.5">
                      <span className="text-xs text-muted-foreground">Auto-send valid invoices</span>
                      <Switch checked={conn.autoSend} onCheckedChange={(v) => toggleAutoSend(conn, v)} />
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        className="flex-1"
                        icon={<RefreshCw className={cn(busy && "animate-spin")} />}
                        loading={busy}
                        onClick={() => runSync(conn)}
                      >
                        Sync now
                      </Button>
                      <Button size="sm" variant="ghost" icon={<Unlink />} onClick={() => disconnect(conn)} aria-label="Disconnect" />
                    </div>
                    <p className="text-center text-[11px] text-muted-foreground">
                      {conn.lastSyncAt ? `Synced ${timeAgo(conn.lastSyncAt)}` : "Not synced yet"}
                    </p>
                  </div>
                ) : (
                  <Button
                    className="mt-4 w-full"
                    variant="outline"
                    icon={p.oauth ? <Link2 /> : <Zap />}
                    onClick={() =>
                      p.oauth
                        ? setConnecting(p)
                        : toast("Tally export guide", { description: "Use the Sales Register preset in the importer." })
                    }
                  >
                    {p.oauth ? "Connect" : "View export guide"}
                  </Button>
                )}
              </Card>
            </motion.div>
          );
        })}
      </div>

      {/* Messaging — each tenant sends invoices from its own WhatsApp number */}
      <div className="mt-8">
        <h2 className="font-display text-lg font-semibold">Messaging</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Send invoices and payment links straight to your customers on WhatsApp, from your own number.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
            <Card className="flex h-full flex-col p-5 hover-lift">
              <div className="flex items-start justify-between">
                <div className="flex size-12 items-center justify-center rounded-xl bg-[#25D366] text-white">
                  <MessageCircle className="size-6" />
                </div>
                {wa?.connected ? (
                  <Badge tone={wa.provider === "meta" ? "success" : "gold"} dot>
                    {wa.provider === "meta" ? "Live" : "Sandbox"}
                  </Badge>
                ) : (
                  <Badge tone="neutral">Cloud API</Badge>
                )}
              </div>
              <h3 className="mt-4 font-display font-semibold">WhatsApp</h3>
              <p className="mt-1 flex-1 text-sm text-muted-foreground">
                Deliver invoices with a pay-now link. Buyers reply and pay in the chat.
              </p>

              {wa?.connected ? (
                <div className="mt-4 space-y-3">
                  <div className="flex items-center justify-between rounded-lg bg-muted/50 px-2.5 py-2 text-xs">
                    <span className="text-muted-foreground">Number</span>
                    <span className="font-semibold tnum">{wa.displayNumber}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" className="flex-1" icon={<Link2 />} onClick={() => setWaOpen(true)}>
                      Change number
                    </Button>
                    <Button size="sm" variant="ghost" icon={<Unlink />} onClick={removeWhatsApp} aria-label="Disconnect WhatsApp" />
                  </div>
                </div>
              ) : (
                <Button
                  className="mt-4 w-full"
                  variant="outline"
                  icon={<Link2 />}
                  onClick={() => currentEntity ? setWaOpen(true) : toast.error("Set up your business first")}
                >
                  Connect WhatsApp
                </Button>
              )}
            </Card>
          </motion.div>
        </div>
      </div>

      <Modal open={waOpen} onClose={() => setWaOpen(false)} title="Connect WhatsApp" size="md">
        <div className="p-5 sm:p-6">
          <div className="flex items-center gap-3 rounded-xl bg-muted/50 p-4">
            <div className="flex size-11 items-center justify-center rounded-xl bg-[#25D366] text-white">
              <MessageCircle className="size-6" />
            </div>
            <div>
              <p className="font-medium">Your WhatsApp Business number</p>
              <p className="text-xs text-muted-foreground">Messages send through the ARKS platform</p>
            </div>
          </div>
          <div className="mt-4 space-y-3">
            <div>
              <label className="text-sm font-medium">WhatsApp number</label>
              <input
                value={waNumber}
                onChange={(e) => setWaNumber(e.target.value)}
                placeholder="+971 50 123 4567"
                inputMode="tel"
                className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none ring-primary/30 focus:ring-2"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">The number customers will see as the sender.</p>
            </div>
            <div>
              <label className="text-sm font-medium">
                Phone number ID <span className="font-normal text-muted-foreground">(optional)</span>
              </label>
              <input
                value={waPhoneId}
                onChange={(e) => setWaPhoneId(e.target.value)}
                placeholder="From Meta Business — leave blank for sandbox"
                className="mt-1.5 w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none ring-primary/30 focus:ring-2"
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Only needed for live sending via the Meta Cloud API.
              </p>
            </div>
          </div>
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-gold/25 bg-gold/[0.05] p-3 text-xs text-[hsl(var(--gold))]">
            <Sparkles className="size-4 shrink-0" />
            No Meta credentials configured → messages run in sandbox so you can see the flow.
          </div>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setWaOpen(false)}>
              Cancel
            </Button>
            <Button icon={<Link2 />} loading={waBusy} onClick={saveWhatsApp}>
              Connect
            </Button>
          </div>
        </div>
      </Modal>

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
            {["Import invoices from your books", "Match customers by TRN, then name", "Map provider tax rates to your profiles", "Isolated to this workspace only"].map((f) => (
              <li key={f} className="flex items-center gap-2.5">
                <Check className="size-4 text-success" /> {f}
              </li>
            ))}
          </ul>
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-border p-3 text-xs text-muted-foreground">
            <ShieldCheck className="size-4 shrink-0" />
            Tokens are encrypted at rest and scoped to your organization. Disconnect anytime.
          </div>
          <div className="mt-3 flex items-center gap-2 rounded-lg border border-gold/25 bg-gold/[0.05] p-3 text-xs text-[hsl(var(--gold))]">
            <Sparkles className="size-4 shrink-0" />
            No provider credentials configured yet → you'll get a sandbox sample so you can see the sync.
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
