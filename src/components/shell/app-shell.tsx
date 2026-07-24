"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import { motion } from "framer-motion";
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
  const { ready, onboarded } = useAppState();
  const router = useRouter();
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  React.useEffect(() => {
    if (ready && !onboarded) router.replace("/onboarding");
  }, [ready, onboarded, router]);

  // close drawer on route change
  React.useEffect(() => setDrawerOpen(false), [pathname]);

  if (!ready || !onboarded) return <Splash />;

  return (
    <div className="flex min-h-dvh bg-background">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
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
