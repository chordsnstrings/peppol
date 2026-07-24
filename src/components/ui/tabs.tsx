"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

export function Tabs({
  tabs,
  value,
  onChange,
  layoutId = "tabs",
  className,
  size = "md",
}: {
  tabs: { value: string; label: React.ReactNode; icon?: React.ReactNode; badge?: React.ReactNode }[];
  value: string;
  onChange: (v: string) => void;
  layoutId?: string;
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <div
      className={cn(
        "no-scrollbar flex items-center gap-1 overflow-x-auto border-b border-border",
        className,
      )}
      role="tablist"
    >
      {tabs.map((t) => {
        const active = t.value === value;
        return (
          <button
            key={t.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.value)}
            className={cn(
              "relative inline-flex shrink-0 items-center gap-2 whitespace-nowrap font-medium transition-colors focus-ring [&_svg]:size-4",
              size === "sm" ? "px-3 py-2 text-sm" : "px-3.5 py-2.5 text-sm",
              active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t.icon}
            {t.label}
            {t.badge}
            {active && (
              <motion.span
                layoutId={layoutId}
                transition={{ type: "spring", stiffness: 400, damping: 32 }}
                className="absolute inset-x-0 -bottom-px h-0.5 rounded-full bg-gold"
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
