"use client";

import * as React from "react";
import { cn, formatDate } from "@/lib/utils";
import { formatMoney } from "@/lib/domain/money";
import { EMIRATES } from "@/lib/domain/peppol";
import { aedTaxTotals, documentTaxStatements, DOC_TYPE_LABEL, getProfile } from "@/lib/domain/tax";
import { LogoMark } from "@/components/shell/logo";
import type { Address, CategoryBreakdown, Invoice } from "@/lib/domain/types";

/**
 * Only the AE code is spelled out. Every address this product records is a UAE
 * one — the entity, customer and onboarding forms all write the country
 * themselves — and a table of two hundred country names for a field that is
 * currently always the same would be furniture. An unrecognised code prints as
 * itself rather than being dropped.
 */
const COUNTRY_NAME: Record<string, string> = { AE: "United Arab Emirates" };

/**
 * An address as a reader expects to see it.
 *
 * Article 59(1)(b) and (c) of the Executive Regulation require the address of
 * both the supplier and the recipient on a tax invoice. This product collected
 * the supplier's at onboarding and then printed none of it, and printed only
 * the buyer's emirate — so every document it rendered was short two particulars
 * the law names.
 */
function addressLines(address?: Address): string[] {
  if (!address) return [];
  const emirate = EMIRATES.find((e) => e.code === address.emirate)?.name ?? address.emirate;
  const locality = [address.city, emirate].filter(Boolean).join(", ");
  return [
    address.street,
    address.additional,
    address.poBox ? `P.O. Box ${address.poBox}` : undefined,
    locality || undefined,
    address.country ? (COUNTRY_NAME[address.country] ?? address.country) : undefined,
  ].filter((l): l is string => Boolean(l && l.trim()));
}

/**
 * What a breakdown row is called.
 *
 * A row reading "VAT 0%" says a rate and hides a treatment: zero-rated, exempt
 * and reverse-charged all foot to nothing and mean entirely different things to
 * the buyer. Where the rate is nil the treatment is what the reader needs.
 */
function categoryLabel(c: CategoryBreakdown): string {
  if (c.ratePercent > 0) return `VAT ${c.ratePercent}%`;
  return `${getProfile(c.profileCode).label} (VAT 0%)`;
}

export function InvoicePreview({ invoice, className }: { invoice: Invoice; className?: string }) {
  const { seller, buyer, lines, totals, currency } = invoice;
  const sellerAddress = addressLines(seller.address);
  const buyerAddress = addressLines(buyer.address);
  // The same derivation the UBL uses, so the printed document and the exchanged
  // one state the same AED figure at the same rate.
  const aed = aedTaxTotals(invoice);
  const statements = documentTaxStatements(totals);
  return (
    <div
      className={cn(
        "mx-auto w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-white text-[#101828] shadow-soft dark:bg-[#0d1420] dark:text-[#e7edf5]",
        className,
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-4 border-b border-black/[0.06] p-6 dark:border-white/[0.06]">
        <div className="flex items-start gap-3">
          <LogoMark size={40} />
          <div>
            <p className="text-sm font-bold">{seller.nameEn || "Your company"}</p>
            {seller.nameAr && (
              <p dir="rtl" className="text-sm font-bold" lang="ar">
                {seller.nameAr}
              </p>
            )}
            {sellerAddress.map((l, i) => (
              <p key={`${i}-${l}`} className="text-xs opacity-60">
                {l}
              </p>
            ))}
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
          {buyer.nameAr && (
            <p dir="rtl" className="font-semibold" lang="ar">
              {buyer.nameAr}
            </p>
          )}
          {buyerAddress.map((l, i) => (
            <p key={`${i}-${l}`} className="text-xs opacity-60">
              {l}
            </p>
          ))}
          {buyer.trn && <p className="text-xs opacity-60">TRN {buyer.trn}</p>}
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
                // The treatment sits under the description on any line that is
                // not plain standard-rated. A mixed document otherwise shows
                // several lines at 0% with nothing to say which of them is the
                // reverse-charged one the statement below refers to.
                const treatment =
                  profile.code === "STANDARD_5" && !l.exemptionReason
                    ? undefined
                    : [profile.label, l.exemptionReason?.trim()].filter(Boolean).join(" — ");
                return (
                  <tr key={l.id}>
                    <td className="py-2.5 pe-2">
                      <p className="font-medium">{l.description || "—"}</p>
                      {treatment && <p className="text-[11px] opacity-50">{treatment}</p>}
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
              // Not the category code: a reverse charge and an import both
              // carry AE at nought, and the two subtotals are deliberately
              // separate.
              key={c.profileCode + c.ratePercent}
              label={categoryLabel(c)}
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
          {/*
            Article 69 of Federal Decree-Law 8/2017 requires the tax on a
            foreign-currency document to be converted to AED, and Article
            59(1)(k) requires the converted figure and the rate to be ON the
            document. What was here printed the rate and no figure — the
            multiplication instead of the answer.
          */}
          {aed && (
            <>
              <Row label="VAT in AED" value={formatMoney(aed.vatMinorAED, "AED")} muted />
              <Row label="Total due in AED" value={formatMoney(aed.payableMinorAED, "AED")} muted />
              <p className="pt-1 text-end text-[11px] opacity-50">
                Converted at {aed.source === "CBUAE" ? "the CBUAE rate" : "a manually entered rate"}{" "}
                of {aed.rateToAED} on {formatDate(aed.rateDate)}
              </p>
            </>
          )}
          {/*
            Said rather than left blank. A foreign-currency document that
            charges tax and cannot state it in AED is missing a particular the
            law names, and the person looking at this preview is the only one
            who can supply the rate.
          */}
          {!aed && currency !== "AED" && totals.vatMinor !== 0 && (
            <p className="pt-1 text-end text-[11px] opacity-70">
              The VAT still has to be stated in AED — no usable rate has been captured for{" "}
              {formatDate(invoice.supplyDate)}.
            </p>
          )}
        </div>
      </div>

      {/*
        Article 59(1)(l) requires a reverse-charge document to say the recipient
        must account for the tax and to cite the provision that puts it on them;
        Article 43 requires a margin-scheme document to say the scheme was
        applied. Neither is optional and neither was here.
      */}
      {statements.length > 0 && (
        <div className="space-y-1 border-t border-black/[0.06] px-6 py-4 text-xs opacity-70 dark:border-white/[0.06]">
          {statements.map((s) => (
            <p key={s}>{s}</p>
          ))}
        </div>
      )}

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
