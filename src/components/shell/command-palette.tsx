"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Command } from "cmdk";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  Search,
  Plus,
  FileText,
  Users,
  Upload,
  Wrench,
  Moon,
  Sun,
  CornerDownLeft,
} from "lucide-react";
import { useTheme } from "next-themes";
import { useHotkey, useLockBody, useMounted } from "@/hooks/use-ui";
import { MAIN_NAV } from "./nav-config";
import { useCustomers, useInvoices } from "@/hooks/use-entity-data";
import { formatMoney } from "@/lib/domain/money";
import { Kbd } from "@/components/ui/feedback";

export function openCommandPalette() {
  window.dispatchEvent(new CustomEvent("arks:command"));
}

export function CommandPalette() {
  const [open, setOpen] = React.useState(false);
  const router = useRouter();
  const { setTheme, resolvedTheme } = useTheme();
  const mounted = useMounted();
  const { invoices } = useInvoices();
  const { customers } = useCustomers();
  useLockBody(open);

  useHotkey("mod+k", (e) => {
    e.preventDefault();
    setOpen((v) => !v);
  });

  React.useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener("arks:command", onOpen);
    return () => window.removeEventListener("arks:command", onOpen);
  }, []);

  const go = (href: string) => {
    setOpen(false);
    router.push(href);
  };

  if (!mounted) return null;

  return createPortal(
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[60] bg-[hsl(215_50%_4%/0.55)] backdrop-blur-sm"
            onClick={() => setOpen(false)}
          />
          <div className="fixed inset-x-0 top-[12vh] z-[60] mx-auto w-full max-w-xl px-4">
            <motion.div
              initial={{ opacity: 0, y: -16, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.98 }}
              transition={{ type: "spring", stiffness: 340, damping: 30 }}
            >
              <Command
                className="overflow-hidden rounded-2xl border border-border bg-popover shadow-float"
                loop
              >
                <div className="flex items-center gap-2.5 border-b border-border px-4">
                  <Search className="size-[18px] text-muted-foreground" />
                  <Command.Input
                    autoFocus
                    placeholder="Search or jump to…"
                    className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                  />
                  <Kbd>Esc</Kbd>
                </div>
                <Command.List className="max-h-[52vh] overflow-y-auto p-2">
                  <Command.Empty className="py-10 text-center text-sm text-muted-foreground">
                    No results found.
                  </Command.Empty>

                  <Command.Group heading="Actions" className="cmdk-group">
                    <Item onSelect={() => go("/invoices/new")} icon={<Plus />}>
                      Create new invoice
                    </Item>
                    <Item onSelect={() => go("/uploads")} icon={<Upload />}>
                      Upload a spreadsheet
                    </Item>
                    <Item onSelect={() => go("/fixit")} icon={<Wrench />}>
                      Open fix-it queue
                    </Item>
                    <Item
                      onSelect={() => {
                        setTheme(resolvedTheme === "dark" ? "light" : "dark");
                      }}
                      icon={resolvedTheme === "dark" ? <Sun /> : <Moon />}
                    >
                      Switch to {resolvedTheme === "dark" ? "light" : "dark"} theme
                    </Item>
                  </Command.Group>

                  <Command.Group heading="Navigate" className="cmdk-group">
                    {MAIN_NAV.map((n) => (
                      <Item key={n.href} onSelect={() => go(n.href)} icon={<n.icon />}>
                        {n.label}
                      </Item>
                    ))}
                  </Command.Group>

                  {invoices.length > 0 && (
                    <Command.Group heading="Invoices" className="cmdk-group">
                      {invoices.slice(0, 6).map((inv) => (
                        <Item
                          key={inv.id}
                          value={`inv ${inv.number} ${inv.buyer.nameEn}`}
                          onSelect={() => go(`/invoices/${inv.id}`)}
                          icon={<FileText />}
                          right={formatMoney(inv.totals.taxInclusiveMinor, inv.currency)}
                        >
                          {inv.number || "Untitled draft"} · {inv.buyer.nameEn || "No customer"}
                        </Item>
                      ))}
                    </Command.Group>
                  )}

                  {customers.length > 0 && (
                    <Command.Group heading="Customers" className="cmdk-group">
                      {customers.slice(0, 6).map((c) => (
                        <Item
                          key={c.id}
                          value={`cust ${c.displayName} ${c.trn ?? ""}`}
                          onSelect={() => go("/customers")}
                          icon={<Users />}
                        >
                          {c.displayName}
                        </Item>
                      ))}
                    </Command.Group>
                  )}
                </Command.List>
                <div className="flex items-center justify-between border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
                  <span className="flex items-center gap-1">
                    <CornerDownLeft className="size-3" /> to select
                  </span>
                  <span>ARKS e-Invoicing</span>
                </div>
              </Command>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}

function Item({
  children,
  onSelect,
  icon,
  right,
  value,
}: {
  children: React.ReactNode;
  onSelect: () => void;
  icon?: React.ReactNode;
  right?: React.ReactNode;
  value?: string;
}) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 text-sm data-[selected=true]:bg-accent [&_svg]:size-4 [&_svg]:text-muted-foreground"
    >
      {icon}
      <span className="flex-1 truncate">{children}</span>
      {right && <span className="text-xs text-muted-foreground tnum">{right}</span>}
    </Command.Item>
  );
}
