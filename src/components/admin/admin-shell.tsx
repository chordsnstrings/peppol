"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ShieldAlert, LogOut } from "lucide-react";
import { cn } from "@/lib/utils";
import { ADMIN_NAV } from "./admin-nav";
import type { PlatformRole } from "@/lib/server/platform-admin";

export interface AdminIdentity {
  email: string;
  name: string;
  role: PlatformRole;
  viaAllowlist: boolean;
}

const ROLE_LABEL: Record<PlatformRole, string> = {
  super: "Super admin",
  support: "Support",
  read_only: "Read only",
};

export function AdminShell({ admin, children }: { admin: AdminIdentity; children: React.ReactNode }) {
  const pathname = usePathname();
  const nav = ADMIN_NAV.filter((i) => !i.min || admin.role === "super");

  return (
    <div className="min-h-dvh bg-background text-foreground">
      {/* Unmistakable staff strip */}
      <div className="flex items-center justify-center gap-2 bg-destructive/90 px-4 py-1.5 text-center text-xs font-medium text-white">
        <ShieldAlert className="size-3.5" />
        Staff console — you can see every workspace. Every action is audited.
      </div>

      <div className="flex">
        {/* Sidebar */}
        <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex">
          <div className="flex items-center gap-2 px-5 py-4">
            <div className="flex size-8 items-center justify-center rounded-lg bg-destructive/15 text-destructive">
              <ShieldAlert className="size-4" />
            </div>
            <div className="font-display text-sm font-bold leading-none">
              ARKS <span className="text-destructive">STAFF</span>
              <div className="mt-1 font-mono text-[10px] font-normal uppercase tracking-wider text-sidebar-muted">
                Operator console
              </div>
            </div>
          </div>

          <nav className="flex-1 space-y-0.5 px-3 py-2">
            {nav.map((item) => {
              const active = item.href === "/admin" ? pathname === "/admin" : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                    active
                      ? "bg-sidebar-accent font-medium text-sidebar-foreground"
                      : "text-sidebar-muted hover:bg-sidebar-accent/60 hover:text-sidebar-foreground",
                  )}
                >
                  <item.icon className="size-4 shrink-0" />
                  {item.label}
                </Link>
              );
            })}
          </nav>

          <div className="border-t border-sidebar-border p-3">
            <div className="rounded-lg bg-sidebar-accent/50 px-3 py-2.5">
              <p className="truncate text-xs font-medium">{admin.email}</p>
              <p className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-sidebar-muted">
                {ROLE_LABEL[admin.role]}
                {admin.viaAllowlist ? " · root" : ""}
              </p>
            </div>
            <Link
              href="/dashboard"
              className="mt-2 flex items-center gap-2 rounded-lg px-3 py-2 text-xs text-sidebar-muted transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground"
            >
              <LogOut className="size-3.5" /> Exit to app
            </Link>
          </div>
        </aside>

        {/* Mobile top nav */}
        <div className="w-full md:hidden">
          <div className="flex items-center gap-2 overflow-x-auto border-b border-border bg-sidebar px-3 py-2 text-sidebar-foreground">
            {nav.map((item) => {
              const active = item.href === "/admin" ? pathname === "/admin" : pathname.startsWith(item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "whitespace-nowrap rounded-md px-2.5 py-1.5 text-xs",
                    active ? "bg-sidebar-accent font-medium" : "text-sidebar-muted",
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
        </div>

        {/* Main */}
        <main className="min-w-0 flex-1 px-4 py-6 md:px-8 md:py-8">
          <div className="mx-auto w-full max-w-[1200px]">{children}</div>
        </main>
      </div>
    </div>
  );
}
