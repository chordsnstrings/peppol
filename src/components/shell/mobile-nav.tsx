"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { MAIN_NAV } from "./nav-config";
import { Logo } from "./logo";
import { EntitySwitcher } from "./entity-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import { useBadgeCounts } from "@/hooks/use-entity-data";
import { Sheet } from "@/components/ui/modal";

/** Routes that render their own sticky bottom action bar — hide the tab bar there. */
const FULLSCREEN_ROUTES = ["/invoices/new"];

/** Bottom tab bar (phones). */
export function MobileTabBar() {
  const pathname = usePathname();
  const counts = useBadgeCounts();
  const tabs = MAIN_NAV.filter((n) => n.mobile);
  const isActive = (href: string) =>
    href === "/dashboard" ? pathname === href : pathname.startsWith(href);

  if (FULLSCREEN_ROUTES.some((r) => pathname.startsWith(r))) return null;

  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-border glass-strong px-2 pb-[env(safe-area-inset-bottom)] pt-1 md:hidden">
      <div className="mx-auto flex max-w-md items-center justify-around">
        {tabs.slice(0, 2).map((t) => (
          <TabLink key={t.href} href={t.href} active={isActive(t.href)} label={t.label}>
            <t.icon className="size-[22px]" />
          </TabLink>
        ))}

        <Link
          href="/invoices/new"
          className="relative -mt-5 flex size-14 items-center justify-center rounded-2xl bg-gold text-[#0B1A2E] shadow-glow"
          aria-label="New invoice"
        >
          <Plus className="size-7" strokeWidth={2.5} />
        </Link>

        {tabs.slice(2).map((t) => {
          const badge = t.badge === "fixit" ? counts.fixit : t.badge === "inbox" ? counts.inbox : 0;
          return (
            <TabLink key={t.href} href={t.href} active={isActive(t.href)} label={t.label} badge={badge}>
              <t.icon className="size-[22px]" />
            </TabLink>
          );
        })}
      </div>
    </nav>
  );
}

function TabLink({
  href,
  active,
  label,
  badge = 0,
  children,
}: {
  href: string;
  active: boolean;
  label: string;
  badge?: number;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "relative flex w-16 flex-col items-center gap-0.5 rounded-lg py-1.5 text-[10px] font-medium transition-colors",
        active ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <span className="relative">
        {children}
        {badge > 0 && (
          <span className="absolute -end-2 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-gold px-1 text-[9px] font-bold text-[#0B1A2E]">
            {badge > 9 ? "9+" : badge}
          </span>
        )}
      </span>
      {label}
      {active && (
        <motion.span
          layoutId="mobile-tab"
          className="absolute -top-0.5 h-0.5 w-6 rounded-full bg-gold"
        />
      )}
    </Link>
  );
}

/** Full nav drawer opened from the topbar menu button. */
export function MobileDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pathname = usePathname();
  const counts = useBadgeCounts();
  const isActive = (href: string) =>
    href === "/dashboard" ? pathname === href : pathname.startsWith(href);

  return (
    <Sheet open={open} onClose={onClose} side="left" className="!bg-sidebar !text-sidebar-foreground">
      <div className="flex h-14 items-center justify-between px-4">
        <Logo tone="light" />
        <button
          onClick={onClose}
          className="inline-flex size-9 items-center justify-center rounded-lg text-sidebar-muted hover:bg-white/5 hover:text-white"
          aria-label="Close menu"
        >
          <X className="size-5" />
        </button>
      </div>
      <div className="px-4 py-2">
        <EntitySwitcher />
      </div>
      <nav className="space-y-1 px-3 py-3">
        {MAIN_NAV.map((item) => {
          const active = isActive(item.href);
          const badge =
            item.badge === "fixit" ? counts.fixit : item.badge === "inbox" ? counts.inbox : 0;
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onClose}
              className={cn(
                "flex items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium transition-colors",
                active
                  ? "bg-white/[0.08] text-white ring-1 ring-inset ring-white/10"
                  : "text-sidebar-foreground hover:bg-white/5 hover:text-white",
              )}
            >
              <item.icon className={cn("size-5", active ? "text-gold" : "text-sidebar-muted")} />
              <span className="flex-1">{item.label}</span>
              {badge > 0 && (
                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-gold px-1.5 text-[11px] font-bold text-[#0B1A2E]">
                  {badge}
                </span>
              )}
            </Link>
          );
        })}
      </nav>
      <div className="flex items-center justify-between border-t border-sidebar-border px-5 py-4">
        <span className="text-xs text-sidebar-muted">Theme</span>
        <ThemeToggle />
      </div>
    </Sheet>
  );
}
