import { prisma } from "@/lib/server/prisma";
import { fmtMinor } from "@/lib/ledger/format";
import { post, LedgerError, type PostLine } from "./post";

/**
 * Petty cash held on the imprest system — the tin in the drawer, and the person
 * who has to account for it.
 *
 * An imprest float is a *fixed sum*. The custodian is given, say, 2,000.00 once;
 * they spend it in small pieces and keep the receipt for every piece; when they
 * hand the receipts in they are given back exactly what the receipts total, and
 * the tin is a fixed sum again. So at every moment, without exception:
 *
 *     cash on hand + unreimbursed receipts = the float
 *
 * That identity is the entire control. It is checkable in ten seconds by
 * counting the notes and adding up the chits, by somebody who knows no
 * accounting at all, and a float that fails it has either lost money or lost a
 * receipt. Everything in this file exists to keep it true, and `fundState()`
 * reports the difference so that a fund which has drifted says so out loud
 * rather than waiting for the year-end.
 *
 * ── Why a spend does not reach the ledger until it is reimbursed ────────────
 *
 * This is the imprest treatment, and it is deliberate. Between reimbursements
 * the petty cash account carries the float and nothing else; the receipts hit
 * the expense accounts in one entry when the custodian presents them.
 *
 * The alternative — a journal per receipt — would mean a numbered, periodised,
 * irreversible-except-by-reversal ledger entry for every AED 12 taxi, each one
 * raised on the say-so of the only person who has seen the receipt. Under the
 * imprest treatment the expenses are posted at the moment somebody *else* has
 * looked at the receipts and paid the money back, which is the only real
 * control a petty cash tin has. It is also why the float amount, not a running
 * cash balance, is what the general ledger holds: between reimbursements the
 * ledger is not out of date, because cash plus receipts still equals the float.
 *
 * The price is that a receipt spent in March and reimbursed in April lands in
 * April. That is the accepted imprest trade-off at the amounts a float carries;
 * where it matters at a period end, `fundState().unreimbursedMinor` is exactly
 * the figure to accrue, which is why it is reported rather than buried.
 *
 * The shape of what does reach the ledger:
 *
 *   Opening       Dr  1000 Petty cash        float
 *                   Cr  1010 Bank              float
 *
 *   Reimbursement Dr  6xxx Expense           receipts, plus any VAT not recoverable
 *                 Dr  1350 VAT input         only VAT backed by a supplier TRN
 *                   Cr  1010 Bank              what the custodian was handed back
 *
 *   Return        Dr  1010 Bank              cash the custodian gave back
 *                   Cr  1000 Petty cash        the float, wound down by that much
 *
 * The VAT split is the same rule as an expense claim, for the same reason:
 * under Article 55 of Federal Decree-Law 8/2017 input tax is recoverable only
 * where the business holds a valid tax invoice showing the supplier's TRN.
 * A chit from a car park has no TRN, so its VAT is not recoverable — and it has
 * not vanished either, it is money the business spent, so it belongs in the
 * expense account with the rest of the cost. See `expenses.ts`, which states
 * the rule at length; this module applies it, it does not restate it.
 */

/* ------------------------------------------------------------------ accounts */

/**
 * Where the tin sits in the chart.
 *
 * The schema's column default is 1020, which in this chart is "Bank — savings
 * account" — a petty cash float is not a savings account, and money in a tin is
 * not money in a bank. 1000 "Cash on hand" is what the UAE chart in setup.ts
 * actually provides for it, so that is the default a caller gets here. A fund
 * may still name its own account (one per custodian, if a business wants the
 * separation on the face of the trial balance).
 */
const DEFAULT_CASH = "1000";
const BANK = "1010";
const VAT_INPUT = "1350";

/**
 * Where an uncoded receipt lands. Guessing travel because petty cash is often
 * taxis would put stationery and parking in the same place on no evidence; other
 * operating expenses is honest about what is known.
 */
const DEFAULT_EXPENSE = "6900";

/* ------------------------------------------------------------------- helpers */

function minor(v: number | bigint | string | undefined | null, what: string): bigint {
  if (v === undefined || v === null || v === "") return 0n;
  if (typeof v === "number" && !Number.isInteger(v)) {
    throw new LedgerError(`${what} must be in whole minor units, got ${v}. Amounts are fils, never a decimal.`);
  }
  if (typeof v === "string" && !/^-?\d+$/.test(v.trim())) {
    throw new LedgerError(`${what} must be in whole minor units, got "${v}".`);
  }
  return BigInt(typeof v === "string" ? v.trim() : v);
}

const asDate = (d: Date | string) => (typeof d === "string" ? new Date(d) : d);
const day = (d: Date) => d.toISOString().slice(0, 10);

export type MovementKind = "OPENING" | "SPEND" | "REIMBURSE" | "RETURN";

interface MovementLike {
  id: string;
  seq: number;
  kind: string;
  movedOn: Date;
  description: string;
  amountMinor: bigint;
  accountCode: string | null;
  vatMinor: bigint;
  supplierTrn: string | null;
  receiptRef: string | null;
  entryId: string | null;
}

interface FundLike {
  id: string;
  code: string;
  name: string;
  custodian: string;
  floatMinor: bigint;
  accountCode: string;
  currency: string;
  status: string;
}

/**
 * Input tax on a receipt is recoverable exactly when the receipt is a tax
 * invoice naming the supplier's TRN — Art 55 again. The table has no
 * "recoverable" flag and does not need one: `recordSpend` refuses a TRN that is
 * not a valid one, so a stored TRN is a valid TRN, and recoverability is a fact
 * about the row rather than a second thing that can disagree with it.
 */
function recoverableVatOf(m: { supplierTrn: string | null; vatMinor: bigint }): bigint {
  return m.supplierTrn && m.vatMinor > 0n ? m.vatMinor : 0n;
}

/**
 * The receipts the custodian is still holding: everything spent since the last
 * reimbursement. A reimbursement always pays out the whole of that set — an
 * imprest float is restored to its exact amount or it is not an imprest float —
 * so "since the last one" is the only definition the module ever needs.
 */
function outstandingOf(movements: MovementLike[]): MovementLike[] {
  let since = 0;
  for (const m of movements) if (m.kind === "REIMBURSE" && m.seq > since) since = m.seq;
  return movements.filter((m) => m.kind === "SPEND" && m.seq > since);
}

const nextSeq = (movements: MovementLike[]) => movements.reduce((n, m) => Math.max(n, m.seq), 0) + 1;

export interface FundState {
  fundId: string;
  code: string;
  name: string;
  custodian: string;
  currency: string;
  status: string;
  accountCode: string;
  /** The imprest amount the fund was set up with. */
  floatMinor: bigint;
  /** What the OPENING movement actually advanced — should equal the float. */
  openedMinor: bigint;
  /** Cash the custodian has handed back, permanently winding the float down. */
  returnedMinor: bigint;
  /**
   * The float in force now: what was advanced, less anything given back. This
   * is the figure the identity is against, and it is also what the petty cash
   * account carries in the general ledger.
   */
  imprestMinor: bigint;
  /** What should be in the tin. */
  cashMinor: bigint;
  /** Receipts held and not yet reimbursed. */
  unreimbursedMinor: bigint;
  /** Input tax inside those receipts, which the next reimbursement will reclaim. */
  unreimbursedVatMinor: bigint;
  /** cash + unreimbursed − imprest. Zero, or the fund has lost money or paper. */
  differenceMinor: bigint;
  reconciled: boolean;
  receiptCount: number;
  movementCount: number;
  lastMovedOn: string | null;
}

/**
 * The identity, computed from the movement log rather than from a running
 * balance kept on the fund. A cached total is a second place for the truth to
 * live, and a float exists precisely to be recounted.
 */
export function stateOf(fund: FundLike, movements: MovementLike[]): FundState {
  let opened = 0n, spent = 0n, reimbursed = 0n, returned = 0n;
  for (const m of movements) {
    if (m.kind === "OPENING") opened += m.amountMinor;
    else if (m.kind === "SPEND") spent += m.amountMinor;
    else if (m.kind === "REIMBURSE") reimbursed += m.amountMinor;
    else if (m.kind === "RETURN") returned += m.amountMinor;
  }

  const outstanding = outstandingOf(movements);
  const unreimbursed = outstanding.reduce((a, m) => a + m.amountMinor, 0n);
  const unreimbursedVat = outstanding.reduce((a, m) => a + recoverableVatOf(m), 0n);

  const cash = opened + reimbursed - spent - returned;
  // The float in force is taken from the fund header, not from the OPENING
  // movement, so that a missing or duplicated opening shows up as a difference
  // instead of quietly redefining what the float is.
  const imprest = fund.floatMinor - returned;
  const difference = cash + unreimbursed - imprest;

  const last = movements.reduce<Date | null>((d, m) => (d === null || m.movedOn > d ? m.movedOn : d), null);

  return {
    fundId: fund.id,
    code: fund.code,
    name: fund.name,
    custodian: fund.custodian,
    currency: fund.currency,
    status: fund.status,
    accountCode: fund.accountCode,
    floatMinor: fund.floatMinor,
    openedMinor: opened,
    returnedMinor: returned,
    imprestMinor: imprest,
    cashMinor: cash,
    unreimbursedMinor: unreimbursed,
    unreimbursedVatMinor: unreimbursedVat,
    differenceMinor: difference,
    reconciled: difference === 0n,
    receiptCount: outstanding.length,
    movementCount: movements.length,
    lastMovedOn: last ? day(last) : null,
  };
}

/**
 * Every read and every write goes through here.
 *
 * A fund id on its own is not authority to touch a fund: the lookup is by id
 * *and* org *and* entity, so an id guessed or leaked from another tenant finds
 * nothing. Movements are then loaded by fund id, which is safe only because the
 * fund itself has already been proved to belong to the caller.
 */
async function loadFund(orgId: string, entityId: string, fundId: string) {
  const fund = await prisma.pettyCashFund.findFirst({
    where: { id: fundId, orgId, entityId },
    include: { movements: { orderBy: { seq: "asc" } } },
  });
  if (!fund) throw new LedgerError("That petty cash fund does not exist.");
  return fund;
}

function assertActive(fund: FundLike): void {
  if (fund.status === "active") return;
  throw new LedgerError(
    `Petty cash fund ${fund.code} (${fund.name}) is closed, so nothing further moves through it. ` +
      `Open a new float if the custodian needs one again — reopening a closed fund would leave two floats ` +
      `claiming the same history.`,
  );
}

/**
 * Foreign-currency floats post through the same rate mechanism as an expense
 * claim: the amount stays in the fund's currency and carries a rate to AED.
 */
function fxOf(fund: FundLike, fxRate: number | undefined, what: string) {
  if (fund.currency === "AED") return {};
  if (!(fxRate && fxRate > 0)) {
    throw new LedgerError(
      `Petty cash fund ${fund.code} is in ${fund.currency} but ${what} carries no exchange rate to AED. Set the rate first.`,
    );
  }
  return { currency: fund.currency, fxRate };
}

type Actor = { actorId?: string; actorType?: "HUMAN" | "RULE" | "MODEL" | "AGENT" | "INTEGRATION" };

/* --------------------------------------------------------------- opening it */

export interface OpenFundResult {
  fundId: string;
  code: string;
  entryId: string;
  reference: string;
  /** True when the float was already advanced; the second call posted nothing. */
  alreadyOpen: boolean;
  floatMinor: string;
  state: FundState;
}

/**
 * Advance the float.
 *
 *   Dr  1000  Petty cash   the float
 *     Cr  1010  Bank         the float
 *
 * Idempotent on `petty-cash-open:<fundId>`. The key is what makes the ledger
 * effect happen once: a retry after a torn write (the fund row committed, the
 * journal did not, or the reverse) converges on the same entry and the same
 * OPENING movement rather than handing the custodian a second float.
 */
export async function openFund(opts: {
  orgId: string;
  entityId: string;
  code: string;
  name: string;
  custodian: string;
  floatMinor: number | bigint | string;
  accountCode?: string;
  currency?: string;
  openedOn?: Date | string;
  bankAccount?: string;
  fxRate?: number;
} & Actor): Promise<OpenFundResult> {
  const code = (opts.code ?? "").trim();
  const name = (opts.name ?? "").trim();
  const custodian = (opts.custodian ?? "").trim();

  if (!code) throw new LedgerError("A petty cash fund needs a code — it is what the tin, the receipts and the journal all quote.");
  if (!name) throw new LedgerError(`Fund ${code} needs a name, so a reader knows which tin it is.`);
  if (!custodian) {
    throw new LedgerError(
      `Fund ${code} needs a custodian. A float with nobody's name against it is cash nobody has to account for.`,
    );
  }

  const floatMinor = minor(opts.floatMinor, `The float on fund ${code}`);
  if (floatMinor <= 0n) {
    throw new LedgerError(`Fund ${code} needs a float greater than nothing — an imprest amount of zero is not a float.`);
  }

  const existing = await prisma.pettyCashFund.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code },
    include: { movements: { orderBy: { seq: "asc" } } },
  });
  if (existing && existing.movements.some((m) => m.kind === "OPENING")) {
    throw new LedgerError(
      `Petty cash fund ${code} already exists (${existing.name}, held by ${existing.custodian}) and its float has been advanced. ` +
        `Give this one its own code — two funds sharing a code would share a history and neither would reconcile.`,
    );
  }

  // A fund row with no opening movement is a half-finished open, not a second
  // fund: reuse it so the retry completes rather than colliding on the code.
  const fund = existing
    ? existing
    : await prisma.pettyCashFund.create({
        data: {
          orgId: opts.orgId,
          entityId: opts.entityId,
          code,
          name,
          custodian,
          floatMinor,
          accountCode: (opts.accountCode ?? "").trim() || DEFAULT_CASH,
          currency: opts.currency ?? "AED",
          status: "active",
        },
        include: { movements: { orderBy: { seq: "asc" } } },
      });

  const openedOn = opts.openedOn ? asDate(opts.openedOn) : new Date();
  const externalKey = `petty-cash-open:${fund.id}`;
  const fx = fxOf(fund, opts.fxRate, "the opening");

  const already = await prisma.journalEntry.findFirst({
    where: { orgId: opts.orgId, externalKey },
    select: { id: true, series: true, number: true },
  });

  const entry = already
    ? already
    : await post({
        orgId: fund.orgId,
        entityId: fund.entityId,
        entryDate: openedOn,
        memo: `Petty cash float ${fund.code} — ${fund.custodian}`,
        source: "petty-cash",
        sourceType: "PETTY_CASH_OPENING",
        sourceId: fund.id,
        externalKey,
        actorType: opts.actorType ?? "HUMAN",
        actorId: opts.actorId,
        series: "PC",
        lines: [
          { account: fund.accountCode, debit: fund.floatMinor, ...fx, memo: `Float held by ${fund.custodian}` },
          { account: opts.bankAccount ?? BANK, credit: fund.floatMinor, ...fx, memo: `Float advanced — ${fund.code}` },
        ],
      });

  const movement =
    fund.movements.find((m) => m.kind === "OPENING") ??
    (await prisma.pettyCashMovement.create({
      data: {
        orgId: fund.orgId,
        fundId: fund.id,
        seq: nextSeq(fund.movements),
        kind: "OPENING",
        movedOn: openedOn,
        description: `Float advanced to ${fund.custodian}`,
        amountMinor: fund.floatMinor,
        entryId: entry.id,
      },
    }));

  const movements = [...fund.movements.filter((m) => m.id !== movement.id), movement].sort((a, b) => a.seq - b.seq);

  return {
    fundId: fund.id,
    code: fund.code,
    entryId: entry.id,
    reference: `${entry.series}-${entry.number}`,
    alreadyOpen: Boolean(already),
    floatMinor: fund.floatMinor.toString(),
    state: stateOf(fund, movements),
  };
}

/* ------------------------------------------------------------------ spending */

export interface SpendResult {
  movementId: string;
  seq: number;
  amountMinor: string;
  /** The part of the VAT that a valid tax invoice makes recoverable. */
  recoverableVatMinor: string;
  /** VAT with no TRN behind it — a cost, and part of the expense. */
  blockedVatMinor: string;
  state: FundState;
}

/**
 * Record a receipt. This is a subledger entry and nothing else — see the note
 * at the top of the file for why the ledger does not hear about it until the
 * float is reimbursed.
 *
 * Two things are refused rather than absorbed. A spend larger than the cash in
 * the tin is arithmetically impossible, and saying so with the amount actually
 * available is the difference between a custodian finding their own mistake and
 * a float that silently goes negative. And a supplier TRN that is not a TRN is
 * refused rather than treated as absent, because "we could not reclaim your VAT
 * because you fat-fingered the TRN" is not a thing anybody discovers later.
 */
export async function recordSpend(opts: {
  orgId: string;
  entityId: string;
  fundId: string;
  movedOn: Date | string;
  description: string;
  amountMinor: number | bigint | string;
  accountCode?: string;
  vatMinor?: number | bigint | string;
  supplierTrn?: string | null;
  receiptRef?: string | null;
}): Promise<SpendResult> {
  const fund = await loadFund(opts.orgId, opts.entityId, opts.fundId);
  assertActive(fund);

  const description = (opts.description ?? "").trim();
  if (!description) {
    throw new LedgerError(
      `Every petty cash spend on fund ${fund.code} needs a description of what was bought. ` +
        `A receipt nobody can identify is one nobody can approve.`,
    );
  }
  if (!opts.movedOn) {
    throw new LedgerError(`Spend "${description}" on fund ${fund.code} needs the date the money left the tin.`);
  }

  const amount = minor(opts.amountMinor, `Amount on "${description}"`);
  if (amount <= 0n) {
    throw new LedgerError(
      `Spend "${description}" on fund ${fund.code} has to be a positive amount. ` +
        `Money coming back into the tin is a reimbursement, not a negative spend.`,
    );
  }

  const vat = minor(opts.vatMinor ?? 0, `VAT on "${description}"`);
  if (vat < 0n) {
    throw new LedgerError(`VAT on "${description}" (fund ${fund.code}) cannot be negative.`);
  }
  if (vat > amount) {
    throw new LedgerError(
      `VAT of ${fmtMinor(vat, fund.currency)} on "${description}" is more than the ${fmtMinor(amount, fund.currency)} ` +
        `that left the tin. The amount is what was paid, VAT included.`,
    );
  }

  const trn = (opts.supplierTrn ?? "").trim() || null;
  if (trn && !/^\d{15}$/.test(trn)) {
    // Same rule and the same refusal as an expense claim: input tax recovered
    // against an invalid TRN is a disallowed claim, so it is better to stop here
    // than to reclaim it and find out at an audit.
    throw new LedgerError(
      `Supplier TRN "${trn}" on "${description}" is not a UAE TRN — a TRN is fifteen digits. ` +
        `Check the receipt, or leave the TRN empty and the VAT will be absorbed into the expense ` +
        `(UAE VAT Decree-Law Art 55).`,
    );
  }

  const state = stateOf(fund, fund.movements);
  if (amount > state.cashMinor) {
    throw new LedgerError(
      `"${description}" is ${fmtMinor(amount, fund.currency)} but fund ${fund.code} only holds ` +
        `${fmtMinor(state.cashMinor, fund.currency, { zero: "zero" })} in cash. ` +
        `Reimburse the ${state.receiptCount} receipt${state.receiptCount === 1 ? "" : "s"} already in the tin ` +
        `(${fmtMinor(state.unreimbursedMinor, fund.currency, { zero: "zero" })}) to restore the float, then record it.`,
    );
  }

  const movement = await prisma.pettyCashMovement.create({
    data: {
      orgId: fund.orgId,
      fundId: fund.id,
      seq: nextSeq(fund.movements),
      kind: "SPEND",
      movedOn: asDate(opts.movedOn),
      description,
      amountMinor: amount,
      accountCode: (opts.accountCode ?? "").trim() || DEFAULT_EXPENSE,
      vatMinor: vat,
      supplierTrn: trn,
      receiptRef: (opts.receiptRef ?? "")?.trim() || null,
    },
  });

  const recoverable = recoverableVatOf(movement);
  return {
    movementId: movement.id,
    seq: movement.seq,
    amountMinor: amount.toString(),
    recoverableVatMinor: recoverable.toString(),
    blockedVatMinor: (vat - recoverable).toString(),
    state: stateOf(fund, [...fund.movements, movement]),
  };
}

/* -------------------------------------------------------------- reimbursing */

export interface ReimburseResult {
  entryId: string;
  reference: string;
  alreadyPosted: boolean;
  /** What the custodian was handed back — the exact total of the receipts. */
  reimbursedMinor: string;
  /** What reached the expense accounts: receipts less the VAT that is reclaimable. */
  expenseMinor: string;
  recoverableVatMinor: string;
  blockedVatMinor: string;
  receiptCount: number;
  state: FundState;
}

/**
 * Top the float back up.
 *
 *   Dr  6xxx  Expense    the receipts, plus any VAT that cannot be reclaimed
 *   Dr  1350  VAT input  only the VAT backed by a supplier TRN
 *     Cr  1010  Bank       the exact total of the receipts
 *
 * The amount is never chosen. It is the total of the receipts since the last
 * reimbursement, which is what restores the tin to exactly the float — an
 * imprest float topped up by a round number is no longer an imprest float, and
 * the identity it is checked against stops being true.
 *
 * Idempotent on `petty-cash-reimburse:<fundId>:<last receipt id>`. The key is
 * derived from the set of receipts being settled, so a retry after a torn write
 * finds the same set, computes the same key, gets the original entry back from
 * `post()` and merely records the movement it failed to record the first time.
 * Once the movement exists those receipts are no longer outstanding, so the
 * next call has nothing to reimburse and says so.
 */
export async function reimburse(opts: {
  orgId: string;
  entityId: string;
  fundId: string;
  movedOn?: Date | string;
  bankAccount?: string;
  fxRate?: number;
} & Actor): Promise<ReimburseResult> {
  const fund = await loadFund(opts.orgId, opts.entityId, opts.fundId);
  assertActive(fund);

  const outstanding = outstandingOf(fund.movements);
  if (outstanding.length === 0) {
    const state = stateOf(fund, fund.movements);
    throw new LedgerError(
      `Fund ${fund.code} has no receipts waiting to be reimbursed, so there is nothing to pay. ` +
        `It holds ${fmtMinor(state.cashMinor, fund.currency, { zero: "zero" })} against a float of ` +
        `${fmtMinor(state.imprestMinor, fund.currency)} — a float is topped up by the total of what was spent, ` +
        `never by an amount somebody picks.`,
    );
  }

  const total = outstanding.reduce((a, m) => a + m.amountMinor, 0n);
  const recoverableVat = outstanding.reduce((a, m) => a + recoverableVatOf(m), 0n);
  const blockedVat = outstanding.reduce((a, m) => a + (m.vatMinor - recoverableVatOf(m)), 0n);

  const movedOn = opts.movedOn ? asDate(opts.movedOn) : new Date();
  const externalKey = `petty-cash-reimburse:${fund.id}:${outstanding[outstanding.length - 1].id}`;
  const fx = fxOf(fund, opts.fxRate, "the reimbursement");

  const already = await prisma.journalEntry.findFirst({
    where: { orgId: opts.orgId, externalKey },
    select: { id: true, series: true, number: true },
  });

  let entry: { id: string; series: string; number: string };
  if (already) {
    entry = already;
  } else {
    // One line per expense account, so a fortnight of taxis is one line against
    // 6400 rather than nine. Non-recoverable VAT rides along with its own
    // receipt's amount into the expense account — the Art 55 treatment, applied
    // per receipt because recoverability is a property of the paper.
    const byAccount = new Map<string, bigint>();
    for (const m of outstanding) {
      const account = m.accountCode || DEFAULT_EXPENSE;
      const cost = m.amountMinor - recoverableVatOf(m);
      byAccount.set(account, (byAccount.get(account) ?? 0n) + cost);
    }

    const lines: PostLine[] = [];
    for (const [account, amount] of byAccount) {
      // A receipt that is nothing but recoverable VAT leaves no cost behind;
      // the bank side still balances against the input tax line.
      if (amount === 0n) continue;
      lines.push({ account, debit: amount, ...fx, memo: `Petty cash ${fund.code} — ${fund.custodian}` });
    }
    if (recoverableVat !== 0n) {
      lines.push({
        account: VAT_INPUT,
        debit: recoverableVat,
        ...fx,
        memo: "Recoverable input VAT",
        taxCode: "INPUT_VAT",
      });
    }
    lines.push({
      account: opts.bankAccount ?? BANK,
      credit: total,
      ...fx,
      memo: `Float ${fund.code} restored to ${fmtMinor(fund.floatMinor, fund.currency)}`,
    });

    entry = await post({
      orgId: fund.orgId,
      entityId: fund.entityId,
      entryDate: movedOn,
      memo: `Petty cash reimbursement ${fund.code} — ${outstanding.length} receipt${outstanding.length === 1 ? "" : "s"}`,
      source: "petty-cash",
      sourceType: "PETTY_CASH_REIMBURSEMENT",
      sourceId: fund.id,
      externalKey,
      actorType: opts.actorType ?? "HUMAN",
      actorId: opts.actorId,
      series: "PC",
      lines,
    });
  }

  const movement = await prisma.pettyCashMovement.create({
    data: {
      orgId: fund.orgId,
      fundId: fund.id,
      seq: nextSeq(fund.movements),
      kind: "REIMBURSE",
      movedOn,
      description: `Reimbursed ${outstanding.length} receipt${outstanding.length === 1 ? "" : "s"} — float restored`,
      amountMinor: total,
      entryId: entry.id,
    },
  });

  return {
    entryId: entry.id,
    reference: `${entry.series}-${entry.number}`,
    alreadyPosted: Boolean(already),
    reimbursedMinor: total.toString(),
    expenseMinor: (total - recoverableVat).toString(),
    recoverableVatMinor: recoverableVat.toString(),
    blockedVatMinor: blockedVat.toString(),
    receiptCount: outstanding.length,
    state: stateOf(fund, [...fund.movements, movement]),
  };
}

/* ----------------------------------------------------------- handing it back */

export interface ReturnResult {
  entryId: string;
  reference: string;
  alreadyPosted: boolean;
  returnedMinor: string;
  state: FundState;
}

/**
 * The custodian hands cash back.
 *
 *   Dr  1010  Bank         what came back
 *     Cr  1000  Petty cash   the float, wound down by that much
 *
 * This permanently reduces the float in force, and it has to: cash on hand plus
 * receipts must still equal the float afterwards, so money leaving the tin for
 * good has to leave the float with it. That is what makes winding a fund down
 * possible — reimburse the outstanding receipts, hand the whole float back, and
 * the fund closes at nil on both sides.
 *
 * Idempotent on `petty-cash-return:<fundId>:<seq>`: a retry after a torn write
 * lands on the same sequence number and so on the same entry, rather than
 * crediting the tin's cash into the bank twice.
 */
export async function returnCash(opts: {
  orgId: string;
  entityId: string;
  fundId: string;
  amountMinor: number | bigint | string;
  movedOn?: Date | string;
  bankAccount?: string;
  reason?: string;
  fxRate?: number;
} & Actor): Promise<ReturnResult> {
  const fund = await loadFund(opts.orgId, opts.entityId, opts.fundId);
  assertActive(fund);

  const amount = minor(opts.amountMinor, `The amount returned from fund ${fund.code}`);
  if (amount <= 0n) {
    throw new LedgerError(`Returning nothing from fund ${fund.code} is not a movement. Give the amount handed back.`);
  }

  const state = stateOf(fund, fund.movements);
  if (amount > state.cashMinor) {
    throw new LedgerError(
      `Fund ${fund.code} holds ${fmtMinor(state.cashMinor, fund.currency, { zero: "zero" })} in cash, ` +
        `so ${fmtMinor(amount, fund.currency)} cannot come back out of it. ` +
        `The other ${fmtMinor(state.unreimbursedMinor, fund.currency, { zero: "zero" })} of the float is receipts, ` +
        `not notes — reimburse them first if the custodian is to hand the whole float back.`,
    );
  }

  const movedOn = opts.movedOn ? asDate(opts.movedOn) : new Date();
  const seq = nextSeq(fund.movements);
  const externalKey = `petty-cash-return:${fund.id}:${seq}`;
  const fx = fxOf(fund, opts.fxRate, "the return");

  const already = await prisma.journalEntry.findFirst({
    where: { orgId: opts.orgId, externalKey },
    select: { id: true, series: true, number: true },
  });

  const entry = already
    ? already
    : await post({
        orgId: fund.orgId,
        entityId: fund.entityId,
        entryDate: movedOn,
        memo: `Petty cash returned ${fund.code} — ${fund.custodian}`,
        source: "petty-cash",
        sourceType: "PETTY_CASH_RETURN",
        sourceId: fund.id,
        externalKey,
        actorType: opts.actorType ?? "HUMAN",
        actorId: opts.actorId,
        series: "PC",
        lines: [
          { account: opts.bankAccount ?? BANK, debit: amount, ...fx, memo: `Returned from ${fund.custodian}` },
          { account: fund.accountCode, credit: amount, ...fx, memo: `Float ${fund.code} reduced` },
        ],
      });

  const movement = await prisma.pettyCashMovement.create({
    data: {
      orgId: fund.orgId,
      fundId: fund.id,
      seq,
      kind: "RETURN",
      movedOn,
      description: (opts.reason ?? "").trim() || `Cash returned by ${fund.custodian}`,
      amountMinor: amount,
      entryId: entry.id,
    },
  });

  return {
    entryId: entry.id,
    reference: `${entry.series}-${entry.number}`,
    alreadyPosted: Boolean(already),
    returnedMinor: amount.toString(),
    state: stateOf(fund, [...fund.movements, movement]),
  };
}

/* ------------------------------------------------------------------ closing */

/**
 * Close a fund.
 *
 * Refused while anything is left in it, and the refusal names both figures
 * because they are settled in different ways: receipts are reimbursed, cash is
 * handed back, and being told only that "the fund is not empty" leaves the
 * custodian guessing which. A closed fund is left in place with its history —
 * the movements are what the ledger entries were raised from.
 */
export async function closeFund(opts: {
  orgId: string;
  entityId: string;
  fundId: string;
}): Promise<{ fundId: string; code: string; status: string; state: FundState }> {
  const fund = await loadFund(opts.orgId, opts.entityId, opts.fundId);
  const state = stateOf(fund, fund.movements);

  if (fund.status === "closed") return { fundId: fund.id, code: fund.code, status: fund.status, state };

  if (state.cashMinor !== 0n || state.unreimbursedMinor !== 0n) {
    throw new LedgerError(
      `Fund ${fund.code} still holds ${fmtMinor(state.cashMinor, fund.currency, { zero: "zero" })} in cash and ` +
        `${fmtMinor(state.unreimbursedMinor, fund.currency, { zero: "zero" })} in receipts that have not been reimbursed, ` +
        `so it cannot be closed. Reimburse the receipts, then have ${fund.custodian} hand the cash back.`,
    );
  }

  const closed = await prisma.pettyCashFund.update({ where: { id: fund.id }, data: { status: "closed" } });
  return { fundId: closed.id, code: closed.code, status: closed.status, state: stateOf(closed, fund.movements) };
}

/* ---------------------------------------------------------------- reporting */

/** The identity for one fund. */
export async function fundState(opts: { orgId: string; entityId: string; fundId: string }): Promise<FundState> {
  const fund = await loadFund(opts.orgId, opts.entityId, opts.fundId);
  return stateOf(fund, fund.movements);
}

export interface FundMovementRow {
  id: string;
  seq: number;
  kind: MovementKind;
  movedOn: string;
  description: string;
  amountMinor: bigint;
  accountCode: string | null;
  vatMinor: bigint;
  recoverableVatMinor: bigint;
  supplierTrn: string | null;
  receiptRef: string | null;
  entryId: string | null;
  entryReference: string | null;
  /** True while the receipt is still in the tin waiting to be reimbursed. */
  outstanding: boolean;
  /** What should have been in the tin immediately after this movement. */
  cashAfterMinor: bigint;
}

/**
 * One fund, its movements, and the running cash balance beside them — because
 * "where did the float go" is answered by reading down a column, not by adding
 * up rows in your head.
 */
export async function fundDetail(opts: { orgId: string; entityId: string; fundId: string }) {
  const fund = await loadFund(opts.orgId, opts.entityId, opts.fundId);
  const state = stateOf(fund, fund.movements);
  const outstanding = new Set(outstandingOf(fund.movements).map((m) => m.id));

  const entryIds = fund.movements.map((m) => m.entryId).filter((v): v is string => Boolean(v));
  const entries = entryIds.length
    ? await prisma.journalEntry.findMany({
        where: { id: { in: entryIds }, orgId: opts.orgId },
        select: { id: true, series: true, number: true },
      })
    : [];
  const ref = (id: string | null) => {
    const e = entries.find((x) => x.id === id);
    return e ? `${e.series}-${e.number}` : null;
  };

  let cash = 0n;
  const movements: FundMovementRow[] = fund.movements.map((m) => {
    cash += m.kind === "OPENING" || m.kind === "REIMBURSE" ? m.amountMinor : -m.amountMinor;
    return {
      id: m.id,
      seq: m.seq,
      kind: m.kind as MovementKind,
      movedOn: day(m.movedOn),
      description: m.description,
      amountMinor: m.amountMinor,
      accountCode: m.accountCode,
      vatMinor: m.vatMinor,
      recoverableVatMinor: recoverableVatOf(m),
      supplierTrn: m.supplierTrn,
      receiptRef: m.receiptRef,
      entryId: m.entryId,
      entryReference: ref(m.entryId),
      outstanding: outstanding.has(m.id),
      cashAfterMinor: cash,
    };
  });

  return { fund: state, movements };
}

/**
 * Every float in the entity with its identity, and the one number a finance
 * lead wants: how many of them do not reconcile. The totals are over every fund
 * in the entity rather than whatever the caller filtered to — a filtered total
 * is how "the cash we hold" quietly becomes "the cash on this page".
 */
export async function fundList(opts: { orgId: string; entityId: string; status?: "active" | "closed" }) {
  const funds = await prisma.pettyCashFund.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, ...(opts.status ? { status: opts.status } : {}) },
    include: { movements: { orderBy: { seq: "asc" } } },
    orderBy: [{ status: "asc" }, { code: "asc" }],
  });

  const states = funds.map((f) => stateOf(f, f.movements));
  const active = states.filter((s) => s.status === "active");

  return {
    funds: states,
    summary: {
      fundCount: states.length,
      activeCount: active.length,
      /** The float in force across the active funds. */
      floatMinor: active.reduce((a, s) => a + s.imprestMinor, 0n),
      /** What should be countable in the tins right now. */
      cashMinor: active.reduce((a, s) => a + s.cashMinor, 0n),
      /** Receipts held by custodians and not yet through the ledger. */
      unreimbursedMinor: active.reduce((a, s) => a + s.unreimbursedMinor, 0n),
      /** Input tax sitting in those receipts, not yet on a VAT return. */
      unreimbursedVatMinor: active.reduce((a, s) => a + s.unreimbursedVatMinor, 0n),
      /** Funds where cash + receipts ≠ float. Anything but zero needs a person. */
      outOfBalanceCount: states.filter((s) => !s.reconciled).length,
    },
  };
}

export { DEFAULT_CASH as PETTY_CASH_ACCOUNT, DEFAULT_EXPENSE as PETTY_CASH_DEFAULT_EXPENSE };
