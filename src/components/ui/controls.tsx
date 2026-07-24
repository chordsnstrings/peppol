"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/* -------------------- Switch -------------------- */

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  className,
  id,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  className?: string;
  id?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors focus-ring disabled:opacity-50",
        checked ? "bg-gold" : "bg-muted-foreground/25",
        className,
      )}
    >
      <motion.span
        layout
        transition={{ type: "spring", stiffness: 550, damping: 32 }}
        className={cn(
          "inline-block size-5 rounded-full bg-white shadow-sm",
          checked ? "ms-[22px]" : "ms-0.5",
        )}
      />
    </button>
  );
}

/* -------------------- Checkbox -------------------- */

export function Checkbox({
  checked,
  onCheckedChange,
  disabled,
  className,
  id,
  indeterminate,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  className?: string;
  id?: string;
  indeterminate?: boolean;
}) {
  return (
    <button
      id={id}
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : checked}
      disabled={disabled}
      onClick={() => onCheckedChange(!checked)}
      className={cn(
        "flex size-[18px] items-center justify-center rounded-[5px] border transition-colors focus-ring disabled:opacity-50",
        checked || indeterminate
          ? "border-gold bg-gold text-white"
          : "border-input bg-background hover:border-muted-foreground/50",
        className,
      )}
    >
      {indeterminate ? (
        <span className="h-0.5 w-2.5 rounded bg-white" />
      ) : (
        checked && (
          <motion.span
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: "spring", stiffness: 600, damping: 28 }}
          >
            <Check className="size-3.5" strokeWidth={3} />
          </motion.span>
        )
      )}
    </button>
  );
}

/* -------------------- Segmented control -------------------- */

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = "md",
  className,
  layoutId = "segmented",
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: React.ReactNode; icon?: React.ReactNode }[];
  size?: "sm" | "md";
  className?: string;
  layoutId?: string;
}) {
  return (
    <div
      className={cn(
        "inline-flex items-center gap-1 rounded-xl border border-border bg-muted/60 p-1",
        className,
      )}
      role="tablist"
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              "relative inline-flex items-center gap-1.5 rounded-lg font-medium transition-colors focus-ring",
              size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm",
              active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {active && (
              <motion.span
                layoutId={layoutId}
                transition={{ type: "spring", stiffness: 400, damping: 32 }}
                className="absolute inset-0 rounded-lg bg-card shadow-soft"
              />
            )}
            <span className="relative z-10 inline-flex items-center gap-1.5 [&_svg]:size-4">
              {opt.icon}
              {opt.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
