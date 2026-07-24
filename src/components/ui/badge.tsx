import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import type { StatusTone } from "@/lib/domain/status";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full border font-medium transition-colors whitespace-nowrap",
  {
    variants: {
      tone: {
        neutral: "border-border bg-muted text-muted-foreground",
        info: "border-info/20 bg-info/10 text-info",
        success: "border-success/20 bg-success/10 text-success",
        warning: "border-warning/25 bg-warning/10 text-[hsl(var(--warning))]",
        error: "border-destructive/20 bg-destructive/10 text-destructive",
        gold: "border-gold/30 bg-gold/10 text-[hsl(var(--gold))]",
        outline: "border-border bg-transparent text-foreground",
      },
      size: {
        sm: "px-2 py-0.5 text-[11px]",
        md: "px-2.5 py-0.5 text-xs",
      },
    },
    defaultVariants: { tone: "neutral", size: "md" },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  dot?: boolean;
  pulse?: boolean;
}

export function Badge({ className, tone, size, dot, pulse, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone, size }), className)} {...props}>
      {dot && (
        <span
          className={cn(
            "size-1.5 rounded-full bg-current",
            pulse && "animate-pulse-ring",
          )}
        />
      )}
      {children}
    </span>
  );
}

export function StatusBadge({
  label,
  tone,
  size,
  pulse,
  className,
}: {
  label: string;
  tone: StatusTone;
  size?: "sm" | "md";
  pulse?: boolean;
  className?: string;
}) {
  return (
    <Badge tone={tone} size={size} dot pulse={pulse} className={className}>
      {label}
    </Badge>
  );
}

export { badgeVariants };
