"use client";

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/lib/utils";
import { useOnClickOutside } from "@/hooks/use-ui";

interface DropdownContextValue {
  open: boolean;
  setOpen: (v: boolean) => void;
}
const DropdownContext = React.createContext<DropdownContextValue | null>(null);

export function Dropdown({
  children,
  align = "end",
  className,
}: {
  children: React.ReactNode;
  align?: "start" | "end";
  className?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  useOnClickOutside(ref, () => setOpen(false), open);

  const [trigger, ...content] = React.Children.toArray(children);

  return (
    <DropdownContext.Provider value={{ open, setOpen }}>
      <div ref={ref} className={cn("relative inline-flex", className)}>
        {trigger}
        <AnimatePresence>
          {open && (
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: -6 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: -6 }}
              transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
              className={cn(
                "absolute top-full z-50 mt-2 min-w-[200px] origin-top overflow-hidden rounded-xl border border-border bg-popover p-1.5 text-popover-foreground shadow-float",
                align === "end" ? "end-0" : "start-0",
              )}
              role="menu"
            >
              {content}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </DropdownContext.Provider>
  );
}

export function DropdownTrigger({ children }: { children: React.ReactElement }) {
  const ctx = React.useContext(DropdownContext)!;
  return React.cloneElement(children as React.ReactElement<Record<string, unknown>>, {
    onClick: (e: React.MouseEvent) => {
      e.stopPropagation();
      ctx.setOpen(!ctx.open);
      (children.props as { onClick?: (e: React.MouseEvent) => void }).onClick?.(e);
    },
    "aria-expanded": ctx.open,
    "aria-haspopup": "menu",
  });
}

export function DropdownItem({
  children,
  onSelect,
  icon,
  tone = "default",
  className,
  disabled,
}: {
  children: React.ReactNode;
  onSelect?: () => void;
  icon?: React.ReactNode;
  tone?: "default" | "destructive";
  className?: string;
  disabled?: boolean;
}) {
  const ctx = React.useContext(DropdownContext)!;
  return (
    <button
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        ctx.setOpen(false);
        onSelect?.();
      }}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors [&_svg]:size-4 [&_svg]:text-muted-foreground",
        "hover:bg-accent focus-ring disabled:pointer-events-none disabled:opacity-50",
        tone === "destructive" &&
          "text-destructive hover:bg-destructive/10 [&_svg]:text-destructive",
        className,
      )}
    >
      {icon}
      <span className="flex-1 text-start">{children}</span>
    </button>
  );
}

export function DropdownLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2.5 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </div>
  );
}

export function DropdownSeparator() {
  return <div className="my-1 h-px bg-border" />;
}
