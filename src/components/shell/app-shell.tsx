"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { useAppState } from "@/lib/app-state";
import { Sidebar } from "./sidebar";
import { Topbar } from "./topbar";
import { MobileDrawer, MobileTabBar } from "./mobile-nav";
import { CommandPalette } from "./command-palette";
import { LogoMark } from "./logo";

function Splash() {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-5 bg-background">
      <motion.div
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={{ type: "spring", stiffness: 260, damping: 20 }}
      >
        <LogoMark size={56} />
      </motion.div>
      <div className="h-1 w-32 overflow-hidden rounded-full bg-muted">
        <motion.div
          className="h-full w-1/2 rounded-full bg-gold"
          animate={{ x: ["-100%", "300%"] }}
          transition={{ repeat: Infinity, duration: 1.1, ease: "easeInOut" }}
        />
      </div>
    </div>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { ready, authenticated, onboarded, entities, impersonating } = useAppState();
  const router = useRouter();
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  const stopImpersonating = async () => {
    await fetch("/api/admin/impersonate/stop", { method: "POST", credentials: "same-origin" }).catch(() => {});
    window.location.href = "/admin";
  };

  React.useEffect(() => {
    if (!ready) return;
    if (!authenticated) router.replace("/login");
    else if (entities.length === 0) router.replace("/onboarding");
  }, [ready, authenticated, entities.length, router]);

  // close drawer on route change
  React.useEffect(() => setDrawerOpen(false), [pathname]);

  if (!ready || !onboarded) return <Splash />;

  return (
    <div className="flex min-h-dvh bg-background">
      {impersonating && (
        <div className="fixed inset-x-0 top-0 z-[100] flex items-center justify-center gap-3 bg-destructive px-4 py-1.5 text-center text-xs font-medium text-white">
          <span>
            Viewing <b>{impersonating.orgName}</b> as staff — read only. Actions are audited.
          </span>
          <button onClick={stopImpersonating} className="rounded bg-white/20 px-2 py-0.5 font-semibold hover:bg-white/30">
            Exit
          </button>
        </div>
      )}
      <Sidebar />
      <div className={cn("flex min-w-0 flex-1 flex-col", impersonating && "pt-8")}>
        <Topbar onMenu={() => setDrawerOpen(true)} />
        <main className="flex-1 px-4 pb-24 pt-6 md:px-6 md:pb-10 lg:px-8">
          <div className="mx-auto w-full max-w-[1200px]">{children}</div>
        </main>
      </div>
      <MobileTabBar />
      <MobileDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
      <CommandPalette />
    </div>
  );
}
