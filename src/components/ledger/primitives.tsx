"use client";

import * as React from "react";
import { fmtMinor } from "@/lib/ledger/format";

/**
 * A figure in a ledger. Negative is signalled twice — parentheses AND colour —
 * so the parenthesis carries the meaning on its own for a reader who cannot
 * separate the Falu red from the ink.
 */
export function Figure({
  minor,
  currency = "AED",
  zero = "dash",
  colour = true,
}: {
  minor: string | number | bigint | null | undefined;
  currency?: string;
  zero?: "dash" | "zero" | "blank";
  colour?: boolean;
}) {
  const v = minor == null || minor === "" ? 0n : BigInt(minor as string | number | bigint);
  const cls = !colour || v === 0n ? (v === 0n ? "sw-zero" : "") : v < 0n ? "sw-num-neg" : "";
  return <span className={cls}>{fmtMinor(v, currency, { zero })}</span>;
}

export function Panel({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`sw-panel ${className}`}>{children}</div>;
}

export function PageHead({ title, sub, actions }: { title: string; sub?: string; actions?: React.ReactNode }) {
  return (
    <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="sw-title">{title}</h1>
        {sub && <p className="sw-sub mt-1 max-w-[62ch]">{sub}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="sw-error" role="alert">
      {children}
    </div>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="sw-note">{children}</div>;
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div className="sw-sub px-1 py-6" role="status" aria-live="polite">
      {label}
    </div>
  );
}

const PERIOD_TONE: Record<string, string> = {
  open: "sw-chip-ok",
  soft_closed: "sw-chip-warn",
  hard_closed: "sw-chip-warn",
  locked: "sw-chip-bad",
  posted: "sw-chip-ok",
  draft: "",
  reversed: "sw-chip-warn",
  active: "sw-chip-ok",
  archived: "",
};

export function StatusChip({ status }: { status: string }) {
  return <span className={`sw-chip ${PERIOD_TONE[status] ?? ""}`}>{status.replace(/_/g, " ")}</span>;
}
