"use client";

import * as React from "react";
import { Bell, Mail, Smartphone, Moon } from "lucide-react";
import { metaGet, metaSet } from "@/lib/db/database";
import { useAppState } from "@/lib/app-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch, Segmented } from "@/components/ui/controls";
import { toast } from "sonner";

const CATEGORIES = [
  { key: "send", label: "Send outcomes", desc: "Delivery and reporting results (batch-collapsed)." },
  { key: "fixit", label: "Fix-it escalations", desc: "When something needs your attention." },
  { key: "connection", label: "Connection health", desc: "Integration disconnects and errors." },
  { key: "inbound", label: "Inbound received", desc: "New invoices arriving from suppliers." },
  { key: "billing", label: "Billing", desc: "Allowance thresholds and invoices." },
  { key: "clock", label: "Compliance clock", desc: "Approaching the 14-day window." },
];

type Pref = "immediate" | "digest" | "off";
type Prefs = Record<string, { email: boolean; inApp: boolean; freq: Pref }>;

const DEFAULT: Prefs = Object.fromEntries(
  CATEGORIES.map((c) => [c.key, { email: true, inApp: true, freq: "immediate" as Pref }]),
);

export default function NotificationsSettingsPage() {
  const { locale, setLocale } = useAppState();
  const [prefs, setPrefs] = React.useState<Prefs>(DEFAULT);

  React.useEffect(() => {
    metaGet<Prefs>("notifPrefs").then((p) => p && setPrefs({ ...DEFAULT, ...p }));
  }, []);

  const update = async (key: string, patch: Partial<Prefs[string]>) => {
    const next = { ...prefs, [key]: { ...prefs[key], ...patch } };
    setPrefs(next);
    await metaSet("notifPrefs", next);
  };

  return (
    <div className="max-w-3xl space-y-5">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Bell className="size-4" /> Notification preferences
          </CardTitle>
        </CardHeader>
        <CardContent className="divide-y divide-border">
          {CATEGORIES.map((c) => (
            <div key={c.key} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{c.label}</p>
                <p className="text-xs text-muted-foreground">{c.desc}</p>
              </div>
              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Smartphone className="size-3.5" />
                  <Switch checked={prefs[c.key]?.inApp} onCheckedChange={(v) => update(c.key, { inApp: v })} />
                </label>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Mail className="size-3.5" />
                  <Switch checked={prefs[c.key]?.email} onCheckedChange={(v) => update(c.key, { email: v })} />
                </label>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Language & region</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Interface language</p>
            <p className="text-xs text-muted-foreground">Switches the app between English and Arabic (RTL).</p>
          </div>
          <Segmented
            value={locale}
            onChange={(v) => {
              setLocale(v);
              toast.success(v === "ar" ? "تم التبديل إلى العربية" : "Switched to English");
            }}
            options={[
              { value: "en", label: "English" },
              { value: "ar", label: "العربية" },
            ]}
          />
        </CardContent>
      </Card>
    </div>
  );
}
