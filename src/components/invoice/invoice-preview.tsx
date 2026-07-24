"use client";

import * as React from "react";
import { cn, formatDate } from "@/lib/utils";
import { formatMoney } from "@/lib/domain/money";
import { DOC_TYPE_LABEL, getProfile } from "@/lib/domain/tax";
import { LogoMark } from "@/components/shell/logo";
import type { Invoice } from "@/lib/domain/types";

export function InvoicePreview({ invoice, className }: { invoice: Invoice; className?: string }) {
  const { seller, buyer, lines, totals, currency } = invoice;
  return (
    <div
      className={cn(
        "mx-auto w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-white text-[#101828] shadow-soft dark:bg-[#0d1420] dark:text-[#e7edf5]",
        className,
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-4 border-b border-black/[0.06] p-6 dark:border-white/[0.06]">
        <div className="flex items-center gap-3">
          <LogoMark size={40} />
          <div>
            <p className="text-sm font-bold">{seller.nameEn || "Your company"}</p>
            {seller.trn && <p className="text-xs opacity-60">TRN {seller.trn}</p>}
            {seller.peppolId && <p className="font-mono text-[11px] opacity-50">{seller.peppolId}</p>}
          </div>
        </div>
        <div className="text-end">
          <p className="text-xs font-semibold uppercase tracking-wide text-[#C9A84C]">
            {DOC_TYPE_LABEL[invoice.docType]}
          </p>
          <p className="mt-0.5 font-mono text-lg font-bold tnum">{invoice.number || "DRAFT"}</p>
        </div>
      </div>

      {/* Parties + meta */}
      <div className="grid grid-cols-2 gap-4 p-6 text-sm">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide opacity-40">Bill to</p>
          <p className="mt-1 font-semibold">{buyer.nameEn || "—"}</p>
          {buyer.trn && <p className="text-xs opacity-60">TRN {buyer.trn}</p>}
          {buyer.address?.emirate && <p className="text-xs opacity-60">{buyer.address.emirate}, UAE</p>}
        </div>
        <div className="space-y-1 text-end">
          <Meta label="Issue date" value={formatDate(invoice.issueDate)} />
          <Meta label="Supply date" value={formatDate(invoice.supplyDate)} />
          {invoice.dueDate && <Meta label="Due date" value={formatDate(invoice.dueDate)} />}
        </div>
      </div>

      {/* Lines */}
      <div className="px-6">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-y border-black/[0.06] text-[11px] uppercase tracking-wide opacity-50 dark:border-white/[0.06]">
              <th className="py-2 text-start font-medium">Description</th>
              <th className="py-2 text-end font-medium">Qty</th>
              <th className="py-2 text-end font-medium">Price</th>
              <th className="py-2 text-end font-medium">VAT</th>
              <th className="py-2 text-end font-medium">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-black/[0.04] dark:divide-white/[0.04]">
            {lines.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-8 text-center text-xs opacity-40">
                  Add line items to see them here.
                </td>
              </tr>
            ) : (
              lines.map((l) => {
                const profile = getProfile(l.taxProfileCode);
                return (
                  <tr key={l.id}>
                    <td className="py-2.5 pe-2">
                      <p className="font-medium">{l.description || "—"}</p>
                    </td>
                    <td className="py-2.5 text-end tnum">{l.qty}</td>
                    <td className="py-2.5 text-end tnum">{formatMoney(l.unitPriceMinor, currency, { withSymbol: false })}</td>
                    <td className="py-2.5 text-end text-xs opacity-60 tnum">{profile.ratePercent}%</td>
                    <td className="py-2.5 text-end font-medium tnum">
                      {formatMoney(l.lineNetMinor, currency, { withSymbol: false })}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Totals */}
      <div className="flex justify-end p-6">
        <div className="w-full max-w-xs space-y-1.5 text-sm">
          <Row label="Subtotal" value={formatMoney(totals.taxExclusiveMinor, currency)} />
          {totals.perCategory.map((c) => (
            <Row
              key={c.categoryCode + c.ratePercent}
              label={`VAT ${c.ratePercent}%`}
              value={formatMoney(c.vatMinor, currency)}
              muted
            />
          ))}
          <div className="my-1 h-px bg-black/[0.08] dark:bg-white/[0.08]" />
          <Row
            label="Total due"
            value={formatMoney(totals.taxInclusiveMinor, currency)}
            strong
          />
          {invoice.fx && (
            <p className="pt-1 text-end text-[11px] opacity-50">
              AED tax total at CBUAE rate {invoice.fx.rateToAED}
            </p>
          )}
        </div>
      </div>

      {invoice.notes && (
        <div className="border-t border-black/[0.06] p-6 text-xs opacity-60 dark:border-white/[0.06]">
          {invoice.notes}
        </div>
      )}
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <p className="text-xs">
      <span className="opacity-40">{label}: </span>
      <span className="font-medium tnum">{value}</span>
    </p>
  );
}

function Row({
  label,
  value,
  strong,
  muted,
}: {
  label: string;
  value: string;
  strong?: boolean;
  muted?: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <span className={cn(strong ? "font-semibold" : muted ? "opacity-50" : "opacity-70")}>
        {label}
      </span>
      <span className={cn("tnum", strong ? "text-base font-bold" : "font-medium")}>{value}</span>
    </div>
  );
}
