"use client";

import * as React from "react";
import { ThemeProvider } from "next-themes";
import { Toaster } from "sonner";
import { AppStateProvider } from "@/lib/app-state";

function ServiceWorkerRegister() {
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    if (!("serviceWorker" in navigator)) return;
    if (process.env.NODE_ENV !== "production") return;
    const onLoad = () => {
      navigator.serviceWorker.register("/sw.js").catch(() => {
        /* offline install is best-effort */
      });
    };
    window.addEventListener("load", onLoad);
    return () => window.removeEventListener("load", onLoad);
  }, []);
  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem disableTransitionOnChange>
      <AppStateProvider>
        {children}
        <Toaster
          position="top-right"
          toastOptions={{
            classNames: {
              toast:
                "!rounded-xl !border !border-border !bg-card !text-card-foreground !shadow-float !font-sans",
              description: "!text-muted-foreground",
              actionButton: "!bg-primary !text-primary-foreground !rounded-md",
            },
          }}
        />
        <ServiceWorkerRegister />
      </AppStateProvider>
    </ThemeProvider>
  );
}
