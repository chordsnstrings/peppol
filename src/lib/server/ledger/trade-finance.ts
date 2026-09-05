import { prisma } from "@/lib/server/prisma";
import { post, LedgerError } from "./post";
import { ledgerBalances } from "./balances";

/**
 * Trade finance: letters of credit, bank guarantees and trust receipts.
 *
 * Two ideas hold this together, and getting either wrong misstates the
 * accounts in a way nobody notices until the bank calls.
 *
 * **A guarantee that has not been called is not a liability.** IAS 37.27
 * forbids recognising it — the obligation depends on a future event outside
 * the entity's control — and IAS 37.86 requires it to be disclosed. So issuing
 * a facility posts nothing against the amount of it. A business that books its
 * guarantees as liabilities understates its net assets by the whole facility;
 * one that says nothing about them leaves a reader with no idea what has been
 * promised. Both are wrong, and only one of them is the sort of wrong an
 * auditor catches.
 *
 * **The margin the bank holds is an asset, and it is not cash.** It cannot be
 * spent while the facility is open, so it sits in 1255 and is kept out of every
 * cash list in the product — exactly as post-dated cheques are, and for exactly
 * the same reason: the money looks like it is there. IAS 7.48 asks for
 * restricted cash to be disclosed, and this is the disclosure.
 *
 * What is posted, therefore:
 *
 *   Issue      Dr  1255  Margin deposits        cash the bank now holds
 *                Cr  1010  Bank
 *              Dr  6350  Bank charges           the commission, when it is paid
 *                Cr  1010  Bank
 *
 *   Drawn      Dr  2000  Trade payables         the supplier has been paid
 *                Cr  2470  Trust receipts         by the bank, which we now owe
 *              — on a guarantee called, the debit is an expense instead,
 *                because there is no payable behind it.
 *
 *   Settled    Dr  2470  Trust receipts
 *                Cr  1010  Bank
 *
 *   Released   Dr  1010  Bank                   the margin comes back
 *                Cr  1255  Margin deposits
 *
 * Nothing in this module posts the face of a facility. The face is a
 * disclosure, and `contingentLiabilities()` is where it is disclosed.
 */

const MARGIN = "1255";
const TRUST_RECEIPT = "2470";
const BANK = "1010";
const AP_CONTROL = "2000";
const CHARGES = "6350";
const GUARANTEE_CALLED = "6900";

export type FacilityKind = "LC_IMPORT" | "LC_EXPORT" | "BANK_GUARANTEE" | "TRUST_RECEIPT";
export type FacilityStatus = "issued" | "drawn" | "expired" | "cancelled";

export const KINDS: Record<FacilityKind, string> = {
  LC_IMPORT: "Import letter of credit",
  LC_EXPORT: "Export letter of credit",
  BANK_GUARANTEE: "Bank guarantee",
  TRUST_RECEIPT: "Trust receipt",
};

/**
 * Whether a facility of this kind, if called, would fall on the entity.
 *
 * An export credit is issued by the buyer's bank in the entity's favour: it is
 * security the entity holds, not a promise the entity has made. Counting it
 * among contingent liabilities would report the entity as exposed to its own
 * customer's creditworthiness twice over — once in receivables and once here.
 */
export const isOwnExposure = (kind: FacilityKind) => kind !== "LC_EXPORT";

const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00.000Z`);

function asDate(v: Date | string, what: string): Date {
  const d = typeof v === "string" ? day(v) : v;
  if (Number.isNaN(d.getTime())) throw new LedgerError(`${what} is not a date I can read.`);
  return d;
}

function minor(v: number | bigint | string, what: string): bigint {
  try {
    return typeof v === "bigint" ? v : BigInt(typeof v === "number" ? Math.round(v) : String(v).trim());
  } catch {
    throw new LedgerError(`${what} is not an amount I can read.`);
  }
}

export interface NewFacility {
  reference: string;
  kind: FacilityKind;
  bank: string;
  beneficiary: string;
  currency?: string;
  amountMinor: number | bigint | string;
  marginMinor?: number | bigint | string;
  commissionMinor?: number | bigint | string;
  issuedOn: Date | string;
  expiresOn: Date | string;
  notes?: string;
}

/**
 * Open a facility.
 *
 * The face amount reaches no account. What reaches the ledger is the cash the
 * bank has taken as margin and the commission it has charged, and only if
 * there is any.
 */
export async function issueFacility(opts: {
  orgId: string; entityId: string; facility: NewFacility; actorId?: string;
}) {
  const f = opts.facility;
  const reference = f.reference.trim();
  if (!reference) throw new LedgerError("A facility needs the bank's reference for it.");
  if (!(f.kind in KINDS)) {
    throw new LedgerError(`"${f.kind}" is not a facility this ledger knows. Use one of ${Object.keys(KINDS).join(", ")}.`);
  }
  if (!f.bank.trim()) throw new LedgerError("Which bank issued it?");
  if (!f.beneficiary.trim()) throw new LedgerError("In whose favour was it issued?");

  const amountMinor = minor(f.amountMinor, "The facility amount");
  if (amountMinor <= 0n) throw new LedgerError("A facility for nothing is not a facility.");
  const marginMinor = f.marginMinor === undefined ? 0n : minor(f.marginMinor, "The margin");
  if (marginMinor < 0n) throw new LedgerError("A margin cannot be negative.");
  if (marginMinor > amountMinor) {
    throw new LedgerError(
      `The margin of ${marginMinor} is more than the ${amountMinor} facility it secures. A bank holding more than ` +
      `the face of a credit is holding a deposit, not a margin.`,
    );
  }
  const commissionMinor = f.commissionMinor === undefined ? 0n : minor(f.commissionMinor, "The commission");
  if (commissionMinor < 0n) throw new LedgerError("A commission cannot be negative.");

  const issuedOn = asDate(f.issuedOn, "The issue date");
  const expiresOn = asDate(f.expiresOn, "The expiry date");
  if (expiresOn < issuedOn) {
    throw new LedgerError("The facility expires before it is issued, which would protect nobody.");
  }

  const currency = (f.currency ?? "AED").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new LedgerError(`"${f.currency}" is not a currency code.`);

  const clash = await prisma.tradeFacility.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, reference },
  });
  if (clash) throw new LedgerError(`There is already a facility ${reference}.`);

  const facility = await prisma.tradeFacility.create({
    data: {
      orgId: opts.orgId, entityId: opts.entityId, reference, kind: f.kind,
      bank: f.bank.trim(), beneficiary: f.beneficiary.trim(), currency,
      amountMinor, marginMinor, commissionMinor, issuedOn, expiresOn,
      notes: f.notes?.trim() || null,
    },
  });

  let entryId: string | null = null;
  if (marginMinor > 0n || commissionMinor > 0n) {
    const entry = await post({
      orgId: opts.orgId, entityId: opts.entityId, entryDate: issuedOn,
      source: "trade_finance", sourceType: "FACILITY_ISSUE", sourceId: facility.id,
      memo: `${KINDS[f.kind]} ${reference} — ${f.bank.trim()}`,
      externalKey: `tradefin:issue:${facility.id}`,
      series: "TF", actorId: opts.actorId,
      lines: [
        ...(marginMinor > 0n
          ? [
              { account: MARGIN, debit: marginMinor, memo: `Margin held against ${reference}` },
              { account: BANK, credit: marginMinor, memo: `Margin paid to ${f.bank.trim()}` },
            ]
          : []),
        ...(commissionMinor > 0n
          ? [
              { account: CHARGES, debit: commissionMinor, memo: `Commission on ${reference}` },
              { account: BANK, credit: commissionMinor, memo: `Commission paid to ${f.bank.trim()}` },
            ]
          : []),
      ],
    });
    entryId = entry.id;
  }

  await prisma.tradeFacilityEvent.create({
    data: {
      orgId: opts.orgId, facilityId: facility.id, kind: "issue",
      happenedOn: issuedOn, amountMinor, entryId,
      memo:
        `${KINDS[f.kind]} for ${f.beneficiary.trim()}. The face of it reaches no account — an obligation that ` +
        `depends on a future event outside the entity's control is disclosed, not recognised (IAS 37.27).`,
    },
  });

  return {
    facility,
    entryId,
    note:
      marginMinor === 0n && commissionMinor === 0n
        ? `${reference} is open. Nothing was posted: the face of a facility is a disclosure, not a liability.`
        : `${reference} is open. Only the margin and the commission were posted — the face of it is a disclosure.`,
  };
}

async function load(orgId: string, entityId: string, reference: string) {
  const f = await prisma.tradeFacility.findFirst({
    where: { orgId, entityId, reference: reference.trim() },
  });
  if (!f) throw new LedgerError(`There is no facility ${reference.trim()}.`);
  return f;
}

/**
 * The bank pays out under the facility.
 *
 * On an import credit the bank has paid the supplier, so the payable is
 * discharged and a trust receipt takes its place — the same debt, owed to a
 * different party, and now bearing interest. On a guarantee that is called
 * there is no payable behind it, so the debit is an expense: the entity has
 * paid for somebody's failure to perform, and calling that a payable would
 * imply it is getting something for the money.
 */
export async function drawFacility(opts: {
  orgId: string; entityId: string; reference: string;
  amountMinor: number | bigint | string;
  drawnOn: Date | string;
  memo?: string;
  actorId?: string;
}) {
  const f = await load(opts.orgId, opts.entityId, opts.reference);
  if (f.status === "cancelled" || f.status === "expired") {
    throw new LedgerError(`${f.reference} is ${f.status}. Nothing can be drawn against it.`);
  }
  const amountMinor = minor(opts.amountMinor, "The amount drawn");
  if (amountMinor <= 0n) throw new LedgerError("A drawing of nothing is not a drawing.");
  const after = f.drawnMinor + amountMinor;
  if (after > f.amountMinor) {
    throw new LedgerError(
      `${f.reference} is for ${f.amountMinor} and ${f.drawnMinor} has already been drawn, so ${amountMinor} cannot ` +
      `be. A bank paying beyond the face of a credit has made a loan, and a loan is a different document.`,
    );
  }
  const drawnOn = asDate(opts.drawnOn, "The date it was drawn");

  /*
   * Nobody can call a credit that has run out.
   *
   * The status check above is not enough on its own, because `status` is
   * stored and nothing moves it: a facility that expired last month is still
   * "issued" until somebody says otherwise, so the guard let a drawing through
   * against a facility `contingentLiabilities()` had already dropped from the
   * IAS 37 note — it filters on `expiresOn >= asOf`, not on the status. The
   * register showed it lapsed, the disclosure had let it go, and the drawing
   * posted anyway.
   *
   * The test is the DAY IT WAS DRAWN, not today. A bank that paid out on the
   * 3rd against a credit expiring on the 5th did nothing wrong because the
   * paperwork reached the ledger on the 20th, and refusing that would only
   * teach people to backdate the entry to a day they can get past. What is
   * refused is a drawing that claims to have happened after the credit was
   * over.
   */
  if (drawnOn > f.expiresOn) {
    throw new LedgerError(
      `${f.reference} expired on ${iso(f.expiresOn)} and this is dated ${iso(drawnOn)}. A bank cannot pay under a ` +
      `credit that has run out, so either the date is wrong or what happened is not a drawing under this facility. ` +
      `A drawing that really did happen before expiry can still be recorded — date it the day it happened.`,
    );
  }

  if (!isOwnExposure(f.kind as FacilityKind)) {
    throw new LedgerError(
      `${f.reference} is an export credit — it is security the entity holds, not a promise it has made. Money ` +
      `arriving under it is a receipt against the invoice, and it belongs on the receivables screen.`,
    );
  }

  const debit = f.kind === "BANK_GUARANTEE" ? GUARANTEE_CALLED : AP_CONTROL;
  const entry = await post({
    orgId: opts.orgId, entityId: opts.entityId, entryDate: drawnOn,
    source: "trade_finance", sourceType: "FACILITY_DRAW", sourceId: f.id,
    memo: opts.memo ?? `${f.reference} drawn — ${f.bank}`,
    externalKey: `tradefin:draw:${f.id}:${after}`,
    series: "TF", actorId: opts.actorId,
    lines: [
      {
        account: debit, debit: amountMinor,
        memo: f.kind === "BANK_GUARANTEE"
          ? `Guarantee ${f.reference} called by ${f.beneficiary}`
          : `${f.beneficiary} paid by ${f.bank} under ${f.reference}`,
      },
      { account: TRUST_RECEIPT, credit: amountMinor, memo: `Owed to ${f.bank} under ${f.reference}` },
    ],
  });

  await prisma.tradeFacility.update({
    where: { id: f.id }, data: { drawnMinor: after, status: "drawn" },
  });
  await prisma.tradeFacilityEvent.create({
    data: {
      orgId: opts.orgId, facilityId: f.id, kind: "draw",
      happenedOn: drawnOn, amountMinor, entryId: entry.id, memo: opts.memo ?? null,
    },
  });

  return {
    reference: f.reference,
    drawnMinor: after,
    availableMinor: f.amountMinor - after,
    entryId: entry.id,
    note:
      f.kind === "BANK_GUARANTEE"
        ? `The guarantee was called. That is an expense, not a payable — the entity has paid for somebody's ` +
          `failure to perform and is getting nothing for the money.`
        : `The supplier has been paid by the bank. The debt has moved from the supplier to the bank and now bears ` +
          `interest; it has not gone away.`,
  };
}

/** Pay the bank what it advanced. */
export async function settleFacility(opts: {
  orgId: string; entityId: string; reference: string;
  amountMinor: number | bigint | string;
  settledOn: Date | string;
  actorId?: string;
}) {
  const f = await load(opts.orgId, opts.entityId, opts.reference);
  const amountMinor = minor(opts.amountMinor, "The amount settled");
  if (amountMinor <= 0n) throw new LedgerError("A settlement of nothing is not a settlement.");
  const settledOn = asDate(opts.settledOn, "The settlement date");

  const events = await prisma.tradeFacilityEvent.findMany({
    where: { orgId: opts.orgId, facilityId: f.id, kind: { in: ["draw", "settle"] } },
  });
  const outstanding = events.reduce(
    (a, e) => a + (e.kind === "draw" ? e.amountMinor : -e.amountMinor), 0n,
  );
  if (amountMinor > outstanding) {
    throw new LedgerError(
      `${f.reference} has ${outstanding} outstanding to the bank and ${amountMinor} is being paid. Paying a bank ` +
      `more than it advanced is a different transaction.`,
    );
  }

  const entry = await post({
    orgId: opts.orgId, entityId: opts.entityId, entryDate: settledOn,
    source: "trade_finance", sourceType: "FACILITY_SETTLE", sourceId: f.id,
    memo: `${f.reference} settled — ${f.bank}`,
    externalKey: `tradefin:settle:${f.id}:${outstanding - amountMinor}`,
    series: "TF", actorId: opts.actorId,
    lines: [
      { account: TRUST_RECEIPT, debit: amountMinor, memo: `Repaid to ${f.bank} under ${f.reference}` },
      { account: BANK, credit: amountMinor },
    ],
  });

  await prisma.tradeFacilityEvent.create({
    data: {
      orgId: opts.orgId, facilityId: f.id, kind: "settle",
      happenedOn: settledOn, amountMinor, entryId: entry.id,
    },
  });

  return {
    reference: f.reference,
    outstandingMinor: outstanding - amountMinor,
    entryId: entry.id,
  };
}

/**
 * The facility comes to an end and the margin comes back.
 *
 * The margin is released whatever the facility did, because the bank holds it
 * against the promise rather than against the drawing: an import credit fully
 * drawn and fully repaid still gets its margin back.
 */
export async function closeFacility(opts: {
  orgId: string; entityId: string; reference: string;
  closedOn: Date | string;
  reason?: "expire" | "cancel";
  actorId?: string;
}) {
  const f = await load(opts.orgId, opts.entityId, opts.reference);
  if (f.status === "expired" || f.status === "cancelled") {
    throw new LedgerError(`${f.reference} is already ${f.status}.`);
  }
  const closedOn = asDate(opts.closedOn, "The closing date");
  const reason = opts.reason ?? "expire";

  const events = await prisma.tradeFacilityEvent.findMany({
    where: { orgId: opts.orgId, facilityId: f.id, kind: { in: ["draw", "settle"] } },
  });
  const outstanding = events.reduce(
    (a, e) => a + (e.kind === "draw" ? e.amountMinor : -e.amountMinor), 0n,
  );
  if (outstanding > 0n) {
    throw new LedgerError(
      `${f.reference} still owes ${outstanding} to ${f.bank}. Closing it would leave a debt with no facility ` +
      `behind it, and the bank would still be holding the margin.`,
    );
  }

  let entryId: string | null = null;
  if (f.marginMinor > 0n) {
    const entry = await post({
      orgId: opts.orgId, entityId: opts.entityId, entryDate: closedOn,
      source: "trade_finance", sourceType: "FACILITY_RELEASE", sourceId: f.id,
      memo: `${f.reference} closed — margin released by ${f.bank}`,
      externalKey: `tradefin:release:${f.id}`,
      series: "TF", actorId: opts.actorId,
      lines: [
        { account: BANK, debit: f.marginMinor, memo: `Margin returned by ${f.bank}` },
        { account: MARGIN, credit: f.marginMinor, memo: `Margin released on ${f.reference}` },
      ],
    });
    entryId = entry.id;
  }

  await prisma.tradeFacility.update({
    where: { id: f.id },
    data: { status: reason === "cancel" ? "cancelled" : "expired", closedOn },
  });
  await prisma.tradeFacilityEvent.create({
    data: {
      orgId: opts.orgId, facilityId: f.id, kind: reason === "cancel" ? "cancel" : "expire",
      happenedOn: closedOn, amountMinor: f.marginMinor, entryId,
    },
  });

  return {
    reference: f.reference,
    status: reason === "cancel" ? "cancelled" : "expired",
    marginReleasedMinor: f.marginMinor,
    entryId,
  };
}

/* -------------------------------------------------------- the disclosures */

export interface ContingentLiabilities {
  asOf: string;
  /** IAS 37.86: what has been promised, by kind, and what is left of it. */
  byKind: {
    kind: FacilityKind;
    label: string;
    count: number;
    facedMinor: bigint;
    drawnMinor: bigint;
    contingentMinor: bigint;
  }[];
  totalFacedMinor: bigint;
  totalDrawnMinor: bigint;
  /** The face less what has already been called. This is the disclosure figure. */
  totalContingentMinor: bigint;
  /** Held by others in the entity's favour — security, not exposure. */
  heldInFavourMinor: bigint;
  restrictedCash: {
    /** IAS 7.48: cash the entity holds and cannot spend. */
    marginMinor: bigint;
    ledgerMinor: bigint;
    agrees: boolean;
    differenceMinor: bigint;
  };
  expiringWithin90Days: { reference: string; kind: FacilityKind; expiresOn: string; contingentMinor: bigint }[];
  statement: string;
  basis: string;
}

export async function contingentLiabilities(opts: {
  orgId: string; entityId: string; asOf?: Date | string;
}): Promise<ContingentLiabilities> {
  const asOf = opts.asOf ? asDate(opts.asOf, "The date") : new Date();

  const facilities = await prisma.tradeFacility.findMany({
    where: {
      orgId: opts.orgId, entityId: opts.entityId,
      issuedOn: { lte: asOf },
      OR: [{ closedOn: null }, { closedOn: { gt: asOf } }],
    },
    orderBy: [{ kind: "asc" }, { expiresOn: "asc" }],
  });

  // A facility whose expiry has passed is no longer an exposure, whatever the
  // register still says: nobody can call a credit that has run out. It is
  // dropped from the disclosure rather than waiting for somebody to close it.
  const live = facilities.filter((f) => f.expiresOn >= asOf);

  const groups = new Map<FacilityKind, { count: number; faced: bigint; drawn: bigint }>();
  let heldInFavour = 0n;
  for (const f of live) {
    const kind = f.kind as FacilityKind;
    if (!isOwnExposure(kind)) { heldInFavour += f.amountMinor - f.drawnMinor; continue; }
    const g = groups.get(kind) ?? { count: 0, faced: 0n, drawn: 0n };
    g.count += 1;
    g.faced += f.amountMinor;
    g.drawn += f.drawnMinor;
    groups.set(kind, g);
  }

  const byKind = [...groups.entries()].map(([kind, g]) => ({
    kind, label: KINDS[kind], count: g.count,
    facedMinor: g.faced, drawnMinor: g.drawn,
    contingentMinor: g.faced - g.drawn,
  }));

  const totalFaced = byKind.reduce((a, r) => a + r.facedMinor, 0n);
  const totalDrawn = byKind.reduce((a, r) => a + r.drawnMinor, 0n);

  // The margin on the register against what 1255 actually holds. A difference
  // is either a margin somebody released without closing the facility or a
  // posting by hand, and both are findings.
  const margin = live.reduce((a, f) => a + f.marginMinor, 0n);
  const ledger = await ledgerBalances({ orgId: opts.orgId, entityId: opts.entityId, codes: [MARGIN] });
  const held = ledger.get(MARGIN) ?? 0n;

  const soon = new Date(asOf.getTime() + 90 * 86_400_000);

  return {
    asOf: iso(asOf),
    byKind,
    totalFacedMinor: totalFaced,
    totalDrawnMinor: totalDrawn,
    totalContingentMinor: totalFaced - totalDrawn,
    heldInFavourMinor: heldInFavour,
    restrictedCash: {
      marginMinor: margin,
      ledgerMinor: held,
      agrees: margin === held,
      differenceMinor: margin - held,
    },
    expiringWithin90Days: live
      .filter((f) => isOwnExposure(f.kind as FacilityKind) && f.expiresOn <= soon)
      .map((f) => ({
        reference: f.reference,
        kind: f.kind as FacilityKind,
        expiresOn: iso(f.expiresOn),
        contingentMinor: f.amountMinor - f.drawnMinor,
      })),
    statement:
      totalFaced === 0n
        ? "The entity has given no guarantees or letters of credit that are still in force."
        : `The entity has given guarantees and credits with a face of ${totalFaced} of which ${totalDrawn} has been ` +
          `called. None of the remainder is recognised as a liability: the obligation depends on a future event ` +
          `outside the entity's control, which IAS 37.27 says is a contingent liability and IAS 37.86 says must be ` +
          `disclosed rather than provided for.`,
    basis: "IAS 37.27, IAS 37.86, IAS 7.48",
  };
}

/**
 * The most facilities one read will list, and how far back a closed one is
 * still worth listing.
 *
 * The old read took the first 500 ordered by status ascending, which sorts
 * "cancelled" and "drawn" before "expired" and "issued" — so the live undrawn
 * facilities, the only ones anybody can still act on, were the first to fall
 * off as dead rows accumulated. Two changes fix that: everything still open is
 * read whatever its age, and what is closed is bounded by date instead of by
 * luck of the alphabet.
 */
const MAX_FACILITIES = 500;
const CLOSED_MONTHS = 24;

/** Lapsed references named on the screen. The panel says how many there are. */
const MAX_LAPSED = 200;

export async function facilityRegister(opts: {
  orgId: string; entityId: string; asOf?: Date | string; status?: FacilityStatus;
}) {
  const asOf = opts.asOf ? asDate(opts.asOf, "The date") : new Date();
  const since = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - CLOSED_MONTHS, asOf.getUTCDate()));

  const page = await prisma.tradeFacility.findMany({
    where: {
      orgId: opts.orgId, entityId: opts.entityId,
      ...(opts.status ? { status: opts.status } : {}),
      OR: [
        // Still open, however long ago it was issued: the bank is holding
        // margin against it and somebody has to act on it.
        { status: { in: ["issued", "drawn"] } },
        // Closed, but recent enough that a reader is still reconciling it.
        { expiresOn: { gte: since } },
      ],
    },
    // Soonest expiry first, so what has lapsed and what is about to lapse are
    // at the top rather than behind a decade of settled paper.
    orderBy: [{ expiresOn: "asc" }, { reference: "asc" }],
    take: MAX_FACILITIES + 1,
  });
  const truncated = page.length > MAX_FACILITIES;
  const facilities = truncated ? page.slice(0, MAX_FACILITIES) : page;

  const events = facilities.length
    ? await prisma.tradeFacilityEvent.findMany({
        where: { orgId: opts.orgId, facilityId: { in: facilities.map((f) => f.id) } },
        orderBy: { happenedOn: "asc" },
      })
    : [];

  const byFacility = new Map<string, typeof events>();
  for (const e of events) byFacility.set(e.facilityId, [...(byFacility.get(e.facilityId) ?? []), e]);

  /**
   * A facility past its expiry that nobody has closed. The bank is still
   * holding the margin and the register still shows a facility that has
   * lapsed — the first overstates cash, the second leaves a line on a
   * screen that no longer means anything.
   *
   * A drawn facility counts. Drawing against a credit does not close it:
   * the balance may be settled, the margin is still with the bank, and
   * "drawn" is exactly the state a forgotten facility sits in.
   *
   * Asked of the database rather than read off the page above, and without
   * the status filter: whether the bank is still holding margin against a
   * dead facility does not change because somebody is looking at the
   * cancelled ones.
   */
  const lapsedRows = await prisma.tradeFacility.findMany({
    where: {
      orgId: opts.orgId, entityId: opts.entityId,
      status: { in: ["issued", "drawn"] },
      expiresOn: { lt: asOf },
    },
    orderBy: { expiresOn: "asc" },
    take: MAX_LAPSED + 1,
    select: { reference: true },
  });
  const lapsedTruncated = lapsedRows.length > MAX_LAPSED;

  const lapsedCount = lapsedTruncated
    ? await prisma.tradeFacility.count({
        where: {
          orgId: opts.orgId, entityId: opts.entityId,
          status: { in: ["issued", "drawn"] },
          expiresOn: { lt: asOf },
        },
      })
    : lapsedRows.length;

  return {
    asOf: iso(asOf),
    since: iso(since),
    /** True when more facilities matched than were listed. */
    truncated,
    listed: facilities.length,
    facilities: facilities.map((f) => {
      const mine = byFacility.get(f.id) ?? [];
      const outstanding = mine.reduce(
        (a, e) => a + (e.kind === "draw" ? e.amountMinor : e.kind === "settle" ? -e.amountMinor : 0n), 0n,
      );
      const daysToExpiry = Math.round((f.expiresOn.getTime() - asOf.getTime()) / 86_400_000);
      return {
        reference: f.reference,
        kind: f.kind as FacilityKind,
        kindLabel: KINDS[f.kind as FacilityKind],
        bank: f.bank,
        beneficiary: f.beneficiary,
        currency: f.currency,
        amountMinor: f.amountMinor,
        marginMinor: f.marginMinor,
        commissionMinor: f.commissionMinor,
        drawnMinor: f.drawnMinor,
        availableMinor: f.amountMinor - f.drawnMinor,
        owedToBankMinor: outstanding,
        issuedOn: iso(f.issuedOn),
        expiresOn: iso(f.expiresOn),
        daysToExpiry,
        expired: f.expiresOn < asOf && (f.status === "issued" || f.status === "drawn"),
        status: f.status as FacilityStatus,
        ownExposure: isOwnExposure(f.kind as FacilityKind),
        notes: f.notes,
        events: mine.map((e) => ({
          kind: e.kind, happenedOn: iso(e.happenedOn),
          amountMinor: e.amountMinor, entryId: e.entryId, memo: e.memo,
        })),
      };
    }),
    lapsed: lapsedRows.slice(0, MAX_LAPSED).map((f) => f.reference),
    lapsedCount,
  };
}
