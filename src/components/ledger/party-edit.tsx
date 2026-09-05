"use client";

import * as React from "react";
import { fmtMinor, parseAmount, toInput } from "@/lib/ledger/format";

/**
 * Changing a counterparty that was, until now, write-once.
 *
 * `updateCounterparty` and `restoreCounterparty` have been complete since the
 * module was written and routed since the route was written, and nothing in a
 * browser called either. So a TRN typed wrong was permanent — and it is the one
 * field that goes on every tax invoice the customer will ever be sent, where a
 * wrong one is discovered by them, months later, when their input tax is
 * disallowed. Two of the module's own refusals name operations that had no
 * control at all: the one that tells you to use "place on hold" instead of an
 * ordinary edit, and the one that says a party is already active.
 *
 * The form sends only what somebody changed. That is not tidiness: the limit
 * distinguishes "no limit set" from a limit of nil, and a form that posted
 * every field on every save would have to decide between them each time it was
 * opened, whether or not anyone touched it.
 */

/** What `updateCounterparty` takes. Every key is optional; absent means untouched. */
export interface PartyChange {
  name?: string;
  nameAr?: string | null;
  kind?: string;
  trn?: string | null;
  email?: string | null;
  phone?: string | null;
  paymentTerms?: number;
  /** Null clears the limit back to "not set". "0" is a real limit of nothing. */
  creditLimitMinor?: string | null;
  currency?: string;
}

/** The party as the customers list carries it. */
export interface EditableParty {
  code: string;
  name: string;
  nameAr: string | null;
  kind: string;
  trn: string | null;
  email: string | null;
  phone: string | null;
  currency: string;
  paymentTerms: number;
  creditLimitMinor: string | null;
  limitSet: boolean;
  outstandingMinor: string;
}

const KINDS = [
  { value: "CUSTOMER", label: "Customer" },
  { value: "SUPPLIER", label: "Supplier" },
  { value: "BOTH", label: "Both" },
];

/** A party that can be sold to. Mirrors `sells` in counterparties.ts. */
const sells = (kind: string) => kind === "CUSTOMER" || kind === "BOTH";

export function PartyEditForm({
  party,
  busy,
  onSave,
}: {
  party: EditableParty;
  busy: boolean;
  onSave: (change: PartyChange) => void;
}) {
  const [f, setF] = React.useState({
    name: party.name,
    nameAr: party.nameAr ?? "",
    kind: party.kind,
    trn: party.trn ?? "",
    email: party.email ?? "",
    phone: party.phone ?? "",
    terms: String(party.paymentTerms),
    currency: party.currency,
    // The two states are kept apart here exactly as they are on the add form:
    // an empty box would send nought, and nought is a different answer.
    limitMode: party.limitSet ? "set" : "none",
    limit: party.limitSet && party.creditLimitMinor !== null
      ? toInput(party.creditLimitMinor, party.currency)
      : "",
  });
  const set = (k: keyof typeof f, v: string) => setF((x) => ({ ...x, [k]: v }));

  const name = f.name.trim();
  const trn = f.trn.trim();
  const terms = Number(f.terms);
  const currency = f.currency.trim().toUpperCase();
  /* An empty box is not nought here. `parseAmount("")` answers 0n — which is
   * right for an amount cell somebody has cleared, and wrong for this one,
   * where nought is the deliberate cash-only limit. So an empty box under
   * "Set a limit" is a blocker rather than a nil limit nobody chose. */
  const limitTyped = f.limit.trim();
  const limitMinor = f.limitMode === "set" && limitTyped !== "" ? parseAmount(limitTyped, currency || party.currency) : null;
  const outstanding = BigInt(party.outstandingMinor);
  const narrowing = sells(party.kind) && !sells(f.kind);

  const change: PartyChange = {};
  if (name !== party.name) change.name = name;
  if ((f.nameAr.trim() || null) !== party.nameAr) change.nameAr = f.nameAr.trim() || null;
  if (f.kind !== party.kind) change.kind = f.kind;
  if ((trn || null) !== party.trn) change.trn = trn || null;
  if ((f.email.trim() || null) !== party.email) change.email = f.email.trim() || null;
  if ((f.phone.trim() || null) !== party.phone) change.phone = f.phone.trim() || null;
  if (Number.isInteger(terms) && terms !== party.paymentTerms) change.paymentTerms = terms;
  if (currency && currency !== party.currency) change.currency = currency;
  if (f.limitMode === "none" && party.limitSet) change.creditLimitMinor = null;
  if (f.limitMode === "set" && limitMinor !== null && limitMinor.toString() !== party.creditLimitMinor) {
    change.creditLimitMinor = limitMinor.toString();
  }

  const owed = fmtMinor(outstanding < 0n ? -outstanding : outstanding, party.currency, { zero: "zero" });
  const blocker =
    !name ? "A counterparty cannot have an empty name — it is what appears on their statement." :
    !Number.isInteger(terms) || terms < 0 || terms > 365 ? "Payment terms are a whole number of days, 0 to 365." :
    trn.length > 0 && !/^\d{15}$/.test(trn) ? "A UAE TRN is fifteen digits." :
    !/^[A-Z]{3}$/.test(currency) ? "A currency is the three-letter ISO code, e.g. AED." :
    f.limitMode === "set" && limitMinor === null ? "Give the limit as an amount, e.g. 5000." :
    limitMinor !== null && limitMinor < 0n ? "A credit limit cannot be negative." :
    /* The server refuses this too, and in these words. It is checked here as
     * well because the answer is already on screen: narrowing a customer to a
     * supplier-only record would take their open invoices off every
     * receivables report while the debt is still owed. */
    narrowing && outstanding !== 0n
      ? `${party.name} still carries ${owed} on the sales ledger, so it cannot become a ` +
        `${f.kind.toLowerCase()}-only record. Settle or write it off first, or use Both if they are now a ` +
        `supplier as well.`
    : Object.keys(change).length === 0 ? "There is nothing to change." :
    null;

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Name">
          <input className="sw-input" value={f.name} onChange={(e) => set("name", e.target.value)} />
        </Field>
        <Field label="العربية">
          <input className="sw-input" dir="rtl" value={f.nameAr} onChange={(e) => set("nameAr", e.target.value)} />
        </Field>
        <Field label="Kind">
          <select className="sw-select" value={f.kind} onChange={(e) => set("kind", e.target.value)}>
            {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
          </select>
        </Field>
        <Field label="TRN">
          <input
            className="sw-input"
            inputMode="numeric"
            value={f.trn}
            onChange={(e) => set("trn", e.target.value)}
            placeholder="15 digits"
            data-testid={`trn-${party.code}`}
          />
          <span className="sw-sub mt-1 block">
            It is printed on every tax invoice they are sent, and a wrong one costs them the input tax.
          </span>
        </Field>
        <Field label="Email">
          <input className="sw-input" type="email" value={f.email} onChange={(e) => set("email", e.target.value)} />
        </Field>
        <Field label="Phone">
          <input className="sw-input" value={f.phone} onChange={(e) => set("phone", e.target.value)} />
        </Field>
        <Field label="Payment terms (days)">
          <input className="sw-input" inputMode="numeric" value={f.terms} onChange={(e) => set("terms", e.target.value)} />
        </Field>
        <Field label="Currency">
          <input className="sw-input" value={f.currency} onChange={(e) => set("currency", e.target.value)} />
        </Field>
        <Field label="Credit limit">
          <select
            className="sw-select"
            value={f.limitMode}
            onChange={(e) => set("limitMode", e.target.value)}
            data-testid={`limit-mode-${party.code}`}
          >
            <option value="none">No limit set — not assessed yet</option>
            <option value="set">Set a limit</option>
          </select>
        </Field>
        <Field label="Limit amount">
          <input
            className="sw-input sw-cell-num"
            inputMode="decimal"
            value={f.limit}
            disabled={f.limitMode === "none"}
            placeholder="5000"
            onChange={(e) => set("limit", e.target.value)}
          />
          <span className="sw-sub mt-1 block">
            {f.limitMode === "none"
              ? "Nothing is checked before a sale while no limit exists."
              : "0 is a customer who gets no credit at all — a different answer from leaving it unset."}
          </span>
        </Field>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="sw-btn sw-btn-primary"
          aria-disabled={blocker !== null || busy || undefined}
          disabled={blocker !== null || busy}
          data-testid={`save-party-${party.code}`}
          onClick={() => onSave(change)}
        >
          {busy ? "Saving…" : "Save"}
        </button>
        {blocker && <span className="sw-sub" role="status" data-testid={`party-blocker-${party.code}`}>{blocker}</span>}
        {!blocker && (
          <span className="sw-sub">
            {Object.keys(change).length} field{Object.keys(change).length === 1 ? "" : "s"} will change. A hold is
            not one of them — it carries a reason and leaves a trail, so it is placed and released on its own.
          </span>
        )}
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="sw-label">{label}</span>
      <span className="mt-1 block">{children}</span>
    </label>
  );
}
