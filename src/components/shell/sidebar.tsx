"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { PanelLeftClose, PanelLeft, Plus, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { Logo, LogoMark } from "./logo";
import { MAIN_NAV } from "./nav-config";
import { useBadgeCounts } from "@/hooks/use-entity-data";
import { Tooltip } from "@/components/ui/tooltip";
import { useLocalState } from "@/hooks/use-ui";

export function Sidebar() {
  const pathname = usePathname();
  const counts = useBadgeCounts();
  const [collapsed, setCollapsed] = useLocalState("arks.sidebar.collapsed", false);

  const isActive = (href: string) =>
    href === "/dashboard" ? pathname === href : pathname.startsWith(href);

  return (
    <motion.aside
      animate={{ width: collapsed ? 76 : 264 }}
      transition={{ type: "spring", stiffness: 300, damping: 34 }}
      className="sticky top-0 z-30 hidden h-dvh shrink-0 flex-col border-e border-sidebar-border bg-sidebar text-sidebar-foreground md:flex"
    >
      {/* Brand */}
      <div className={cn("flex h-16 items-center px-4", collapsed && "justify-center px-0")}>
        <Link href="/dashboard" className="flex items-center focus-ring rounded-lg">
          {collapsed ? <LogoMark size={34} /> : <Logo tone="light" />}
        </Link>
      </div>

      {/* Primary CTA */}
      <div className={cn("px-3 pb-2", collapsed && "px-3")}>
        <Link
          href="/invoices/new"
          className={cn(
            "group flex items-center gap-2.5 rounded-xl bg-gold px-3 py-2.5 text-sm font-semibold text-[#0B1A2E] shadow-soft transition-all hover:shadow-glow",
            collapsed && "justify-center px-0",
          )}
        >
          <Plus className="size-[18px] transition-transform group-hover:rotate-90" strokeWidth={2.5} />
          {!collapsed && <span>New invoice</span>}
        </Link>
      </div>

      {/* Nav */}
      <nav className="no-scrollbar flex-1 space-y-0.5 overflow-y-auto px-3 py-2">
        {MAIN_NAV.map((item) => {
          const active = isActive(item.href);
          const badge =
            item.badge === "fixit" ? counts.fixit : item.badge === "inbox" ? counts.inbox : 0;
          const link = (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "group relative flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
                collapsed && "justify-center px-0",
                active
                  ? "text-white"
                  : "text-sidebar-foreground hover:bg-white/5 hover:text-white",
              )}
            >
              {active && (
                <motion.span
                  layoutId="sidebar-active"
                  transition={{ type: "spring", stiffness: 400, damping: 32 }}
                  className="absolute inset-0 rounded-xl bg-white/[0.08] ring-1 ring-inset ring-white/10"
                />
              )}
              {active && !collapsed && (
                <motion.span
                  layoutId="sidebar-rail"
                  className="absolute inset-y-2 -start-3 w-1 rounded-full bg-gold"
                />
              )}
              <item.icon
                className={cn(
                  "relative z-10 size-[18px] shrink-0 transition-colors",
                  active ? "text-gold" : "text-sidebar-muted group-hover:text-white",
                )}
              />
              {!collapsed && <span className="relative z-10 flex-1 truncate">{item.label}</span>}
              {!collapsed && badge > 0 && (
                <span className="relative z-10 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-gold px-1.5 text-[11px] font-bold text-[#0B1A2E] tnum">
                  {badge}
                </span>
              )}
              {collapsed && badge > 0 && (
                <span className="absolute -end-0.5 -top-0.5 z-10 size-2.5 rounded-full bg-gold ring-2 ring-sidebar" />
              )}
            </Link>
          );
          return collapsed ? (
            <Tooltip key={item.href} content={item.label} side="right">
              {link}
            </Tooltip>
          ) : (
            link
          );
        })}
      </nav>

      {/* Footer: upgrade + collapse */}
      <div className="space-y-2 border-t border-sidebar-border p-3">
        {!collapsed && (
          <div className="rounded-xl bg-gradient-to-br from-white/[0.07] to-transparent p-3 ring-1 ring-inset ring-white/5">
            <div className="flex items-center gap-2 text-xs font-semibold text-white">
              <Sparkles className="size-4 text-gold" />
              Sandbox mode
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-sidebar-muted">
              First 100 exchanges are free every year, per entity.
            </p>
          </div>
        )}
        <button
          onClick={() => setCollapsed(!collapsed)}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-sidebar-muted transition-colors hover:bg-white/5 hover:text-white",
            collapsed && "justify-center px-0",
          )}
        >
          {collapsed ? <PanelLeft className="size-[18px]" /> : <PanelLeftClose className="size-[18px]" />}
          {!collapsed && <span>Collapse</span>}
        </button>
      </div>
    </motion.aside>
  );
}
