"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

/** Smooth animated area sparkline. */
export function AreaSpark({
  values,
  height = 56,
  className,
  stroke = "hsl(var(--gold))",
  fill = "hsl(var(--gold) / 0.14)",
}: {
  values: number[];
  height?: number;
  className?: string;
  stroke?: string;
  fill?: string;
}) {
  const w = 100;
  const max = Math.max(1, ...values);
  const pts = values.length > 1 ? values : [0, ...values];
  const step = w / (pts.length - 1 || 1);
  const coords = pts.map((v, i) => [i * step, height - (v / max) * (height - 6) - 3]);
  const line = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c[0].toFixed(2)},${c[1].toFixed(2)}`).join(" ");
  const area = `${line} L${w},${height} L0,${height} Z`;

  return (
    <svg
      viewBox={`0 0 ${w} ${height}`}
      preserveAspectRatio="none"
      className={cn("w-full", className)}
      style={{ height }}
    >
      <motion.path
        d={area}
        fill={fill}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.6 }}
      />
      <motion.path
        d={line}
        fill="none"
        stroke={stroke}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={{ duration: 1, ease: "easeInOut" }}
      />
    </svg>
  );
}

/** Vertical bar chart with labels and animated grow-in. */
export function BarChart({
  data,
  height = 160,
  className,
  valueFormat = (n) => String(n),
}: {
  data: { label: string; value: number; tone?: string }[];
  height?: number;
  className?: string;
  valueFormat?: (n: number) => string;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className={cn("flex items-end gap-1.5", className)} style={{ height }}>
      {data.map((d, i) => {
        const h = (d.value / max) * 100;
        return (
          <div key={i} className="group flex flex-1 flex-col items-center justify-end gap-1.5">
            <div className="relative flex w-full flex-1 items-end">
              <motion.div
                initial={{ height: 0 }}
                whileInView={{ height: `${Math.max(h, d.value > 0 ? 4 : 0)}%` }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.03, type: "spring", stiffness: 120, damping: 18 }}
                className={cn(
                  "w-full rounded-t-md transition-colors",
                  d.tone ?? "bg-gold/80 group-hover:bg-gold",
                )}
              >
                <span className="pointer-events-none absolute inset-x-0 -top-6 text-center text-[10px] font-semibold opacity-0 transition-opacity group-hover:opacity-100 tnum">
                  {valueFormat(d.value)}
                </span>
              </motion.div>
            </div>
            <span className="truncate text-[10px] text-muted-foreground">{d.label}</span>
          </div>
        );
      })}
    </div>
  );
}
