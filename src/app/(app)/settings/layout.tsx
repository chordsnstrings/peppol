"use client";

import { usePathname, useRouter } from "next/navigation";
import { Settings } from "lucide-react";
import { PageHeader } from "@/components/shell/page-header";
import { Tabs } from "@/components/ui/tabs";
import { SETTINGS_NAV } from "@/components/shell/nav-config";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();

  // Sub-flows (e.g. add entity) render standalone.
  if (pathname.includes("/entities")) return <>{children}</>;

  const active =
    SETTINGS_NAV.slice()
      .sort((a, b) => b.href.length - a.href.length)
      .find((t) => pathname === t.href || pathname.startsWith(t.href + "/"))?.href ?? "/settings";

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Manage your entity, team, billing and platform preferences."
        icon={<Settings />}
      />
      <div className="mb-6">
        <Tabs
          tabs={SETTINGS_NAV.map((t) => ({ value: t.href, label: t.label }))}
          value={active}
          onChange={(href) => router.push(href)}
        />
      </div>
      {children}
    </div>
  );
}
