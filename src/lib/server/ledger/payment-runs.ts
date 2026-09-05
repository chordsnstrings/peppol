import { prisma } from "@/lib/server/prisma";
import { Prisma } from "@prisma/client";
import { fmtMinor, exponentOf } from "@/lib/ledger/format";
import { post, LedgerError } from "./post";
import { payablesAgeing } from "./ap";
import { partyIndex, attributeDocument } from "./counterparties";
import { assertApproved } from "./approvals";
import type { Invoice } from "@/lib/domain/types";

/**
 * Supplier payment runs — paying many bills as one act.
 *
 * ap.ts settles one bill at a time, and that is the right shape for a bill
 * somebody pays because the supplier rang up. A payment run is the other way a
 * business pays: on a Tuesday, somebody asks "what is due?", the answer is
 * ninety bills, and the whole batch goes to the bank in one file. Three things
 * make that different from ninety individual payments, and they are what this
 * file is for.
 *
 * 1. What was LEFT OUT matters more than what went in. A bill dropped from the
 *    run with no reason recorded is the one the supplier chases in three weeks,
 *    and by then nobody can say whether it was on hold, unapproved, or missed.
 *    So every candidate the proposal touches is written down — included or
 *    excluded, and if excluded, why, in a sentence. The database agrees:
 *    PaymentRunItem CHECKs that an excluded item carries a reason.
 *
 * 2. Preparing and releasing money must be two people. Whoever built the run
 *    cannot approve it. Everything else here is bookkeeping; that rule is the
 *    control the run exists for, and it is refused by name rather than by a
 *    silent no-op — see approveRun().
 *
 * 3. Release is idempotent. A retried release must not pay the batch twice,
 *    which is exactly the failure a payment run can afford least, so every
 *    posting carries an externalKey derived from the run and the item.
 *
 * HOW THIS RELATES TO approvals.ts. That file is the general approval
 * mechanism: rules per subject type, cumulative thresholds, several signatures,
 * append-only decisions, and self-approval refused. It already lists PAYMENT
 * among its subject types, and a business that wants two directors on anything
 * above a million should say so there — one rule table, not a second one hidden
 * in this file. What lives here is the *irreducible* control: one approver, who
 * is not the preparer, recorded on the run itself, because PaymentRun.approvedBy
 * and the database CHECK behind it mean a run cannot reach `released` without
 * it. The two are deliberately NOT wired together: approvals.ts says in its own
 * words that its guard is called by the posting paths rather than reaching into
 * them, and a run that quietly depended on a rule row existing would lose its
 * control the day somebody deactivated the rule. Where both are in use the
 * shape is: approvals.ts collects the signatures policy asks for against
 * subject PAYMENT and this run's id, and releaseRun() calls assertApproved()
 * before it posts. It does. The two are different questions — the run's own
 * control says somebody other than the preparer signed it and cannot be
 * switched off; the rules say which people and how many policy wants for money
 * of this size — so a run needs both and losing either loses something real.
 *
 * ONE ENTRY, MANY BILLS. A release posts a single entry: one debit to payables
 * per bill, each line naming the bill it settles, and one credit to the bank
 * for the transfer that actually left the account. That is only possible
 * because settlement is recorded on the LINE (`JournalLine.settlesId`) as well
 * as on the entry. It matters twice over. If the entry could name only one
 * document, every bill but the first would still show as outstanding while the
 * cash had gone — the precise condition under which a supplier gets paid twice.
 * And if the run posted a separate entry per bill instead, the bank would be
 * credited once per bill against a statement showing a single debit, leaving
 * the run correct in the payables ledger and impossible to reconcile in the
 * cash book.
 *
 * NOT MODELLED, deliberately:
 *   • Part payment. A run pays what the payable carries, in full. Paying half a
 *     bill is a negotiation, not a batch operation, and belongs in
 *     postSupplierPayment() where the cleared and bank amounts can differ.
 *   • Foreign-currency settlement, for the same reason: the run pays the
 *     payable at its carrying amount, so there is no realised exchange
 *     difference to book. A payment at a different rate goes through
 *     postSupplierPayment(), which knows how to split the gain or loss.
 *   • Supplier bank details. There is no table for them in this schema and
 *     inventing one here would be a second, unmaintained supplier master — so
 *     bankFile() takes the beneficiaries from its caller. See the note on it.
 */

const AP_CONTROL = "2000";
const BANK_DEFAULT = "1010";

export type RunStatus = "draft" | "approved" | "released" | "cancelled";

/** How a status reads in the middle of a sentence somebody has to act on. */
const STATE_WORDS: Record<RunStatus, string> = {
  draft: "still a draft",
  approved: "approved and waiting to be released",
  released: "already released",
  cancelled: "cancelled",
};

/* ------------------------------------------------------------------ helpers */

const tidy = (v: string | null | undefined) => (v ?? "").trim();

/** Either the client or a transaction of it — a claim has to be read inside one. */
type Db = Prisma.TransactionClient;

/**
 * The advisory-lock namespace this module proposes runs under, and a stable
 * key for one entity within it.
 *
 * Two proposals built at the same moment each read the claims before the other
 * had written one, so each found the field clear and each took the bill: a bill
 * on two live runs, paid twice, with nothing in the ledger to say it was coming
 * because neither run had posted yet. There is no unique index that could have
 * caught it — the same bill legitimately sits on a cancelled run and on the run
 * that replaces it — so the read and the write are made one act instead.
 *
 * `pg_advisory_xact_lock` is the smallest thing that does that: taken on the
 * entity, held for the length of the transaction, released by the commit, with
 * no row and no table to maintain. Proposals are a handful a week; serialising
 * them per entity costs nothing anybody will notice.
 *
 * The key is hashed here rather than by `hashtext()` so it does not depend on
 * a Postgres internal, and it is 32-bit signed because that is what the
 * two-argument form of the lock takes.
 */
const RUN_LOCK_NAMESPACE = 0x7061_796d | 0; // "paym"

function lockKey(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

/**
 * Which of these bills is already claimed by a run that has not been released
 * or cancelled.
 *
 * A bill sitting in an unreleased run is the double payment this module exists
 * to prevent, and it is invisible in the ageing: nothing has been posted yet,
 * so the payable is still wide open.
 */
async function claimedElsewhere(
  tx: Db, orgId: string, entityId: string, billIds: string[], exceptRunId?: string,
): Promise<Map<string, { reference: string; status: string }>> {
  if (billIds.length === 0) return new Map();
  const rows = await tx.paymentRunItem.findMany({
    where: {
      orgId,
      excluded: false,
      billId: { in: billIds },
      run: { entityId, status: { in: ["draft", "approved"] }, ...(exceptRunId ? { id: { not: exceptRunId } } : {}) },
    },
    include: { run: { select: { reference: true, status: true } } },
  });
  return new Map(rows.filter((r) => r.billId).map((r) => [r.billId as string, r.run]));
}
/** Two people, by id — trimmed and case-insensitive, as in approvals.ts. */
const fold = (v: string) => v.trim().toLowerCase();
const samePerson = (a: string, b: string) => fold(a) === fold(b);
const iso = (d: Date) => d.toISOString().slice(0, 10);
const money = (v: bigint, currency = "AED") => `${currency} ${fmtMinor(v, currency, { zero: "zero" })}`;

/**
 * A date the ledger can use. A bare YYYY-MM-DD is read as UTC midnight rather
 * than local midnight: the column is a DATE, and reading "2026-04-25" in a
 * timezone behind UTC would store the 24th.
 */
function asDate(v: Date | string, what: string): Date {
  const d = typeof v === "string" ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? `${v.trim()}T00:00:00.000Z` : v) : v;
  if (Number.isNaN(d.getTime())) {
    throw new LedgerError(`${what} is not a date this can read: "${String(v)}". Use YYYY-MM-DD.`);
  }
  return d;
}

const addDays = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);

/** Minor units as a plain decimal for a bank file. Integer arithmetic only. */
function decimal(minor: bigint, currency: string): string {
  const exp = exponentOf(currency);
  const neg = minor < 0n;
  const abs = neg ? -minor : minor;
  const s = abs.toString().padStart(exp + 1, "0");
  const body = exp === 0 ? s : `${s.slice(0, -exp)}.${s.slice(-exp)}`;
  return `${neg ? "-" : ""}${body}`;
}

/**
 * A CSV field. Supplier names carry commas ("Gulf Supplies, LLC") far more
 * often than salary files do, and one unquoted comma shifts every column after
 * it — which the bank reads as a different amount, not as a broken file.
 */
function csvField(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * What the ledger memo says when the document itself is not in the record
 * store. postBill() writes "Bill BILL-7 — Gulf Supplies LLC", so the number and
 * the supplier can be read back out of it. This is a fallback, not the source
 * of truth: a bill posted through the API always has its document.
 */
function fromMemo(memo: string): { billNumber: string; supplierName: string } {
  const [head, ...rest] = memo.split(" — ");
  const supplierName = rest.join(" — ").trim();
  const billNumber = head.replace(/^(Bill|Supplier credit)\s+/i, "").trim();
  return { billNumber: billNumber || memo.trim(), supplierName: supplierName || "Unnamed supplier" };
}

async function loadRun(orgId: string, runId: string) {
  const run = await prisma.paymentRun.findFirst({
    where: { id: runId, orgId },
    include: { items: { orderBy: [{ excluded: "asc" }, { amountMinor: "desc" }] } },
  });
  if (!run) throw new LedgerError("That payment run does not exist.");
  return run;
}

type LoadedRun = Awaited<ReturnType<typeof loadRun>>;

const included = (run: LoadedRun) => run.items.filter((i) => !i.excluded);
const runTotal = (run: LoadedRun) => included(run).reduce((a, i) => a + i.amountMinor, 0n);

/* -------------------------------------------------------------- the bill gate */

/**
 * Whether a bill may be paid, read from the approval rows rather than through
 * approvals.ts.
 *
 * This reads the same two tables approvals.ts owns — its rules and its
 * decisions — and answers only the question a payment run asks: may this bill
 * be paid at all? It deliberately does not reproduce the role arithmetic or the
 * blocker sentences; approvalState() is authoritative and says all of that far
 * better. Two of its rules are reproduced because getting either wrong would
 * put money out of the door: a rejection stands whatever else is on file, and
 * an approval given at a different amount is a signature on a document that no
 * longer exists.
 *
 * Where they could disagree, this is the LOOSER of the two — it does not check
 * approver roles — so it can never invent a blocker that policy does not have.
 * A run being loose in that direction is safe: the run's own approver still has
 * to sign the batch, and that is a second pair of eyes on the same money.
 */
interface BillDecision {
  decision: string;
  decidedBy: string;
  decidedAt: Date;
  amountMinor: bigint | null;
  reason: string | null;
}

function billApproval(input: {
  billNumber: string;
  /** The amount the approval was given for: the document's total, not what is left. */
  amountMinor: bigint;
  currency: string;
  rules: { thresholdMinor: bigint; approversRequired: number; approverUserId: string | null }[];
  decisions: BillDecision[];
}): string | null {
  const rejection = input.decisions.find((d) => d.decision === "REJECTED");
  if (rejection) {
    return (
      `${input.billNumber} was rejected by ${rejection.decidedBy} on ${iso(rejection.decidedAt)}` +
      `${rejection.reason ? ` — "${rejection.reason}"` : ""}. A rejection stands until the bill is withdrawn and ` +
      `resubmitted, so it cannot be paid.`
    );
  }

  // Cumulative, not banded: every rule at or below the amount applies.
  const applicable = input.rules.filter((r) => r.thresholdMinor <= input.amountMinor);
  if (applicable.length === 0) return null;

  // An approval covers the amount it was shown. A bill re-keyed after it was
  // signed carries a signature for a document that no longer exists.
  const pool = new Set(
    input.decisions
      .filter((d) => d.decision === "APPROVED" && (d.amountMinor === null || d.amountMinor === input.amountMinor))
      .map((d) => fold(d.decidedBy)),
  );

  const namedMissing = applicable
    .map((r) => r.approverUserId)
    .filter((u): u is string => Boolean(u) && !pool.has(fold(u as string)));
  if (namedMissing.length) {
    return (
      `${input.billNumber} needs ${[...new Set(namedMissing)].join(" and ")} to approve it and has not been approved ` +
      `by ${namedMissing.length === 1 ? "them" : "all of them"} yet.`
    );
  }

  const need = applicable.reduce((m, r) => (r.approverUserId ? m : Math.max(m, r.approversRequired)), 0);
  if (pool.size < need) {
    const has = pool.size === 0 ? "nobody has approved it" : `only ${pool.size} of the ${need} approvals it needs are on file`;
    return (
      `${input.billNumber} is ${money(input.amountMinor, input.currency)} and ${has}. ` +
      `A bill nobody has approved does not get paid out of a batch.`
    );
  }
  return null;
}

/* --------------------------------------------------------------- the proposal */

export interface RunItemView {
  id: string;
  billId: string | null;
  billNumber: string;
  supplierName: string;
  /** Always positive: the table CHECKs it, and a payment is a positive amount. */
  amountMinor: string;
  excluded: boolean;
  excludeReason: string | null;
}

export interface RunEntryView {
  id: string;
  reference: string;
  entryDate: string;
  /** The bill this entry discharged. */
  settlesId: string | null;
}

export interface RunView {
  id: string;
  reference: string;
  runDate: string;
  bankAccount: string;
  currency: string;
  status: RunStatus;
  preparedBy: string | null;
  approvedBy: string | null;
  approvedAt: string | null;
  releasedAt: string | null;
  entryId: string | null;
  items: RunItemView[];
  includedCount: number;
  excludedCount: number;
  /** What the bank will be asked for. */
  totalMinor: string;
  /** What was found and left out — the figure somebody has to be able to explain. */
  excludedMinor: string;
  entries: RunEntryView[];
}

export interface ProposalView extends RunView {
  /**
   * Bills that exist and are not yet due. Not run items — nothing has been
   * dropped, they simply are not payable yet — but reported so that "why is
   * this not in the run?" has an answer without a second query.
   */
  notDue: { billId: string; billNumber: string; supplierName: string; amountMinor: string; dueDate: string }[];
}

const itemView = (i: {
  id: string; billId: string | null; billNumber: string; supplierName: string;
  amountMinor: bigint; excluded: boolean; excludeReason: string | null;
}): RunItemView => ({
  id: i.id,
  billId: i.billId,
  billNumber: i.billNumber,
  supplierName: i.supplierName,
  amountMinor: i.amountMinor.toString(),
  excluded: i.excluded,
  excludeReason: i.excludeReason,
});

async function view(run: LoadedRun): Promise<RunView> {
  // Every entry the release posted, found by the run it came from rather than
  // by the single id the run can store.
  const entries = await prisma.journalEntry.findMany({
    where: { orgId: run.orgId, sourceType: "PAYMENT_RUN", sourceId: run.id },
    select: { id: true, series: true, number: true, entryDate: true, settlesId: true },
    orderBy: [{ series: "asc" }, { number: "asc" }],
  });

  const ins = included(run);
  return {
    id: run.id,
    reference: run.reference,
    runDate: iso(run.runDate),
    bankAccount: run.bankAccount,
    currency: run.currency,
    status: run.status as RunStatus,
    preparedBy: run.preparedBy,
    approvedBy: run.approvedBy,
    approvedAt: run.approvedAt ? run.approvedAt.toISOString() : null,
    releasedAt: run.releasedAt ? run.releasedAt.toISOString() : null,
    entryId: run.entryId,
    items: run.items.map(itemView),
    includedCount: ins.length,
    excludedCount: run.items.length - ins.length,
    totalMinor: runTotal(run).toString(),
    excludedMinor: run.items.filter((i) => i.excluded).reduce((a, i) => a + i.amountMinor, 0n).toString(),
    entries: entries.map((e) => ({
      id: e.id,
      reference: `${e.series}-${e.number}`,
      entryDate: iso(e.entryDate),
      settlesId: e.settlesId,
    })),
  };
}

/**
 * Build a draft run from what the payables ageing says is outstanding.
 *
 * The candidates come from payablesAgeing() rather than from a query of this
 * file's own — so the run pays what the LEDGER says is owed, not what a
 * document store thinks. Worst first, because that is the order a business
 * pays in when there is not enough money for everything, and it is the order
 * the ageing already returns.
 *
 * The document store is consulted only for the facts the ledger does not hold:
 * a due date, a supplier name, and the bill's own total. A bill whose document
 * has gone missing still reaches the run — with its number and supplier read
 * out of the journal memo — because an unexplained payable is a reason to look,
 * not a reason to pay nobody.
 */
export async function proposeRun(opts: {
  orgId: string;
  entityId: string;
  /** The date the money moves, and the date the entries carry. */
  runDate: Date | string;
  /** Pay everything due on or before this. Defaults to the run date. */
  dueBy?: Date | string;
  bankAccount?: string;
  currency?: string;
  /** Defaults to PR-<run date>, with a suffix if that reference is taken. */
  reference?: string;
  /** Who is proposing it. Kept on the run, so approval can check against it. */
  preparedBy?: string | null;
}): Promise<ProposalView> {
  const runDate = asDate(opts.runDate, "A payment run date");
  const dueBy = opts.dueBy === undefined ? runDate : asDate(opts.dueBy, "The due-by date");
  const bankAccount = tidy(opts.bankAccount) || BANK_DEFAULT;

  const book = await prisma.book.findFirst({ where: { orgId: opts.orgId, entityId: opts.entityId, code: "PRIMARY" } });
  if (!book) throw new LedgerError("This entity has no book to pay from. Set up the chart of accounts first.");
  const currency = tidy(opts.currency) || book.functionalCurrency;
  if (currency !== book.functionalCurrency) {
    throw new LedgerError(
      `A payment run settles payables at what they carry, so it can only be in ${book.functionalCurrency}, not ${currency}. ` +
        `Pay a ${currency} bill on its own, where the exchange difference on settlement can be booked.`,
    );
  }

  const ageing = await payablesAgeing({ orgId: opts.orgId, entityId: opts.entityId, asOf: runDate });
  const billIds = ageing.open.map((o) => o.sourceId);

  // Everything the decision needs, in five queries rather than five per bill.
  const [docRows, suppliers, rules, decisions, inFlight] = await Promise.all([
    prisma.record.findMany({ where: { orgId: opts.orgId, store: "invoices", id: { in: billIds } } }),
    prisma.counterparty.findMany({
      where: { orgId: opts.orgId, entityId: opts.entityId, kind: { in: ["SUPPLIER", "BOTH"] } },
    }),
    prisma.approvalRule.findMany({
      where: { orgId: opts.orgId, entityId: opts.entityId, subjectType: "BILL", active: true },
    }),
    prisma.approvalDecision.findMany({ where: { orgId: opts.orgId, subjectType: "BILL", subjectId: { in: billIds } } }),
    // Read here so the exclusion carries its reason in the order the loop
    // decides them — already on a run comes before on hold, which comes before
    // unapproved. It is read AGAIN under the lock below, which is the read that
    // actually decides; this one is for the sentence.
    claimedElsewhere(prisma, opts.orgId, opts.entityId, billIds),
  ]);

  const docs = new Map<string, Invoice>();
  for (const r of docRows) {
    try { docs.set(r.id, JSON.parse(r.data) as Invoice); } catch { /* a corrupt document is not a reason to skip the payable */ }
  }
  // A bill is attributed to a supplier through the same ladder the sales
  // ledger uses — an explicit link, then the TRN, then the name — rather than
  // by name alone. Two attribution rules in one product is two answers to
  // "whose is this", and the weaker one would be the one governing who gets
  // paid. An unmatched bill simply means no hold and no agreed terms, which is
  // the honest answer rather than a guess.
  const supplierIndex = partyIndex(suppliers);
  const byId = new Map(suppliers.map((c) => [c.id, c]));
  const decisionsByBill = new Map<string, BillDecision[]>();
  for (const d of decisions) {
    const g = decisionsByBill.get(d.subjectId);
    if (g) g.push(d); else decisionsByBill.set(d.subjectId, [d]);
  }

  const items: { billId: string; billNumber: string; supplierName: string; amountMinor: bigint; excluded: boolean; excludeReason: string | null }[] = [];
  const notDue: ProposalView["notDue"] = [];

  for (const o of ageing.open) {
    const outstanding = BigInt(o.outstandingMinor);
    if (outstanding === 0n) continue;

    const doc = docs.get(o.sourceId);
    const memo = fromMemo(o.memo);
    const billNumber = tidy(doc?.number) || memo.billNumber;
    const supplierName = tidy(doc?.seller?.nameEn) || memo.supplierName;
    const billDate = asDate(o.date, "A bill date");

    // A credit note is a debit on payables: the supplier owes US. It cannot be
    // paid, and netting it away silently is how a credit goes unclaimed — so it
    // goes into the run as an exclusion with the reason saying what to do.
    // The amount is recorded absolute because the table CHECKs a positive
    // amount; the reason says which way round it is.
    if (outstanding < 0n) {
      items.push({
        billId: o.sourceId,
        billNumber,
        supplierName,
        amountMinor: -outstanding,
        excluded: true,
        excludeReason:
          `${billNumber} is a supplier credit of ${money(-outstanding, currency)}, not a bill — there is nothing to pay. ` +
          `Apply it against ${supplierName}'s next invoice so the credit is used rather than forgotten.`,
      });
      continue;
    }

    // Due date: what the document says; failing that, the supplier's agreed
    // terms; failing that, due on receipt. Guessing later than the truth is
    // what leaves a bill unpaid past its date, so the fallbacks get earlier,
    // never later.
    const party = doc ? byId.get(attributeDocument(doc, supplierIndex, "seller") ?? "") : undefined;
    const agreedTerms = party?.paymentTerms;
    const dueDate = doc?.dueDate
      ? asDate(doc.dueDate, `The due date on ${billNumber}`)
      : agreedTerms === undefined ? billDate : addDays(billDate, agreedTerms);

    if (dueDate > dueBy) {
      notDue.push({
        billId: o.sourceId, billNumber, supplierName,
        amountMinor: outstanding.toString(), dueDate: iso(dueDate),
      });
      continue;
    }

    const already = inFlight.get(o.sourceId);
    if (already) {
      items.push({
        billId: o.sourceId, billNumber, supplierName, amountMinor: outstanding, excluded: true,
        excludeReason:
          `${billNumber} is already on payment run ${already.reference}, which is ${STATE_WORDS[already.status as RunStatus]}. ` +
          `Release or cancel that run rather than paying the bill from two.`,
      });
      continue;
    }

    const hold = party?.onHold ? { name: party.name, reason: party.holdReason } : undefined;
    if (hold) {
      items.push({
        billId: o.sourceId, billNumber, supplierName, amountMinor: outstanding, excluded: true,
        excludeReason:
          `${hold.name} is on hold${hold.reason ? ` — ${hold.reason}` : ""}. ` +
          `Take the hold off the supplier before paying ${billNumber}, or exclude it on purpose with a reason of your own.`,
      });
      continue;
    }

    // Approvals were given against the document's own total; what is left on it
    // may be less if something has already been paid.
    const approvalAmount = doc?.totals?.payableMinor !== undefined ? BigInt(doc.totals.payableMinor) : outstanding;
    const unapproved = billApproval({
      billNumber,
      amountMinor: approvalAmount,
      currency,
      rules,
      decisions: decisionsByBill.get(o.sourceId) ?? [],
    });
    if (unapproved) {
      items.push({
        billId: o.sourceId, billNumber, supplierName, amountMinor: outstanding, excluded: true,
        excludeReason: unapproved,
      });
      continue;
    }

    items.push({ billId: o.sourceId, billNumber, supplierName, amountMinor: outstanding, excluded: false, excludeReason: null });
  }

  /*
   * The claims are read again here, and this is the read that decides. Between
   * the read above and this write another proposal can have taken a bill, so
   * the lock is held across both: nothing else can be proposing for this entity
   * while the run is written, and the reference is chosen inside it too, so two
   * proposals on one day cannot pick the same one and lose the race on a unique
   * index instead of on a sentence.
   */
  const created = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${RUN_LOCK_NAMESPACE}::int, ${lockKey(`${opts.orgId}:${opts.entityId}`)}::int)`;

    const claimed = await claimedElsewhere(
      tx, opts.orgId, opts.entityId, items.filter((i) => !i.excluded && i.billId).map((i) => i.billId),
    );
    for (const i of items) {
      const taken = i.excluded ? undefined : claimed.get(i.billId);
      if (!taken) continue;
      i.excluded = true;
      i.excludeReason =
        `${i.billNumber} is already on payment run ${taken.reference}, which is ${STATE_WORDS[taken.status as RunStatus]}. ` +
        `Release or cancel that run rather than paying the bill from two.`;
    }

    const reference = await nextReference(tx, opts.orgId, opts.entityId, tidy(opts.reference), runDate);
    return tx.paymentRun.create({
      data: {
        orgId: opts.orgId,
        entityId: opts.entityId,
        reference,
        runDate,
        bankAccount,
        currency,
        status: "draft",
        preparedBy: tidy(opts.preparedBy) || null,
        items: { create: items.map((i) => ({ orgId: opts.orgId, ...i })) },
      },
      select: { id: true },
    });
  });

  // The proposal comes back in the order it was decided — worst first, the
  // order somebody pays in. A later read cannot reproduce it: PaymentRunItem
  // has no sequence column and the ageing that ranked them is a moment in time,
  // so runDetail() sorts by amount instead and says so.
  const rank = new Map(items.map((i, n) => [i.billId, n]));
  const built = await view(await loadRun(opts.orgId, created.id));
  built.items.sort((a, b) => (rank.get(a.billId ?? "") ?? 0) - (rank.get(b.billId ?? "") ?? 0));
  return { ...built, notDue };
}

/**
 * A reference nobody has used. The run is keyed by (org, entity, reference), so
 * two runs on one day get PR-2026-04-25 and PR-2026-04-25-2 rather than one of
 * them failing on a unique constraint the operator did not ask about.
 */
async function nextReference(tx: Db, orgId: string, entityId: string, wanted: string, runDate: Date): Promise<string> {
  const base = wanted || `PR-${iso(runDate)}`;
  for (let n = 1; n < 100; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    const clash = await tx.paymentRun.findFirst({
      where: { orgId, entityId, reference: candidate }, select: { id: true },
    });
    if (!clash) return candidate;
    // An explicit reference is a caller's decision; silently renaming it would
    // hide that the run they meant to find already exists.
    if (wanted) throw new LedgerError(`Payment run ${base} already exists for this entity. Give this one a different reference.`);
  }
  throw new LedgerError(`There are already 99 payment runs called ${base}. Give this one a reference of its own.`);
}

/* --------------------------------------------------------- editing the batch */

/** A run's contents can only change while it is a draft, and this says why. */
function assertEditable(run: LoadedRun, what: string) {
  if (run.status === "draft") return;
  if (run.status === "approved") {
    throw new LedgerError(
      `Payment run ${run.reference} was approved by ${run.approvedBy} — ${what} now would mean the approval on file is a ` +
        `signature for a different batch of payments. Cancel the run and propose it again, or release it as approved.`,
    );
  }
  throw new LedgerError(`Payment run ${run.reference} is ${STATE_WORDS[run.status as RunStatus]}, so ${what} changes nothing.`);
}

function itemOf(run: LoadedRun, itemId: string) {
  const item = run.items.find((i) => i.id === itemId);
  if (!item) throw new LedgerError(`There is no such payment on run ${run.reference}.`);
  return item;
}

/**
 * Take a payment out of the run, on the record.
 *
 * The reason is not optional and not decorative: it is the answer given three
 * weeks later when the supplier asks why they were not paid, and the database
 * refuses an excluded item without one.
 */
export async function excludeItem(opts: {
  orgId: string;
  runId: string;
  itemId: string;
  reason: string;
}): Promise<RunView> {
  const run = await loadRun(opts.orgId, opts.runId);
  const item = itemOf(run, opts.itemId);
  const reason = tidy(opts.reason);
  if (!reason) {
    throw new LedgerError(
      `Say why ${item.billNumber} is being left out of run ${run.reference}. ` +
        `A payment dropped without a reason is one nobody can explain to the supplier later.`,
    );
  }
  assertEditable(run, `taking ${item.billNumber} out of it`);
  if (item.excluded) {
    throw new LedgerError(`${item.billNumber} is already out of run ${run.reference} — ${item.excludeReason}`);
  }

  await prisma.paymentRunItem.update({ where: { id: item.id }, data: { excluded: true, excludeReason: reason } });
  return view(await loadRun(opts.orgId, opts.runId));
}

/**
 * Put a payment back into the run.
 *
 * The reason is optional here and recorded when given, in the same column: the
 * schema has one reason field and no history table, and the excluded flag says
 * which way the note points. Losing "put back after the hold was lifted"
 * because there was nowhere to write it would be the wrong trade.
 */
export async function includeItem(opts: {
  orgId: string;
  runId: string;
  itemId: string;
  reason?: string;
}): Promise<RunView> {
  const run = await loadRun(opts.orgId, opts.runId);
  const item = itemOf(run, opts.itemId);
  assertEditable(run, `putting ${item.billNumber} back into it`);
  if (!item.excluded) throw new LedgerError(`${item.billNumber} is already in run ${run.reference}.`);

  const reason = tidy(opts.reason);
  await prisma.paymentRunItem.update({
    where: { id: item.id },
    data: { excluded: false, excludeReason: reason ? `Put back: ${reason}` : null },
  });
  return view(await loadRun(opts.orgId, opts.runId));
}

/* ------------------------------------------------------------------ approval */

/**
 * Approve the run.
 *
 * THE control in a payment run: whoever prepared it cannot approve it. Fraud
 * in accounts payable is not usually a forged invoice, it is one person who can
 * both create a payment and let it out of the door, and every other check here
 * is bookkeeping by comparison. So self-approval is refused by name, with the
 * reason said out loud rather than as a generic "not permitted".
 *
 * The preparer is read from the run, not taken from the approver. A control
 * that depends on the person it constrains truthfully naming the preparer is
 * not a control — so `preparedBy` is written when the run is proposed and the
 * database holds the rule as well (PaymentRun_separation_check). `submittedBy`
 * remains as a parameter only for runs proposed before that column existed,
 * which carry no preparer to check against.
 */
export async function approveRun(opts: {
  orgId: string;
  runId: string;
  approvedBy: string;
  /**
   * Only consulted for a run proposed before preparedBy existed on the row.
   * A run that records its own preparer is checked against that.
   */
  submittedBy?: string | null;
  approvedAt?: Date;
}): Promise<RunView> {
  const run = await loadRun(opts.orgId, opts.runId);
  const approvedBy = tidy(opts.approvedBy);
  if (!approvedBy) throw new LedgerError("An approval has to name the person giving it.");

  if (run.status === "released") {
    throw new LedgerError(
      `Payment run ${run.reference} is already released — it was approved by ${run.approvedBy} and the money has gone. ` +
        `Approving it again would record a signature after the fact.`,
    );
  }
  if (run.status === "cancelled") {
    throw new LedgerError(`Payment run ${run.reference} was cancelled, so there is nothing left to approve.`);
  }
  if (run.status === "approved") {
    throw new LedgerError(
      `Payment run ${run.reference} was already approved by ${run.approvedBy}` +
        `${run.approvedAt ? ` on ${iso(run.approvedAt)}` : ""}. A second approval adds nothing; release it instead.`,
    );
  }

  // The row wins over anything the approver says about who prepared it.
  const preparedBy = tidy(run.preparedBy) || tidy(opts.submittedBy);
  if (preparedBy && samePerson(preparedBy, approvedBy)) {
    throw new LedgerError(
      `${approvedBy} prepared payment run ${run.reference}, so ${approvedBy} cannot also approve it. ` +
        `Preparing a payment and releasing it have to be two different people — that is the one control a payment run ` +
        `exists for. Ask somebody else to approve it.`,
    );
  }

  const ins = included(run);
  if (ins.length === 0) {
    throw new LedgerError(
      `Payment run ${run.reference} has nothing in it to pay — every one of its ${run.items.length} candidates is ` +
        `excluded. Put something back into it, or cancel it.`,
    );
  }

  await prisma.paymentRun.update({
    where: { id: run.id },
    data: { status: "approved", approvedBy, approvedAt: opts.approvedAt ?? new Date() },
  });
  return view(await loadRun(opts.orgId, opts.runId));
}

/* ------------------------------------------------------------------- release */

export interface ReleaseResult extends RunView {
  /** Every entry posted for this run, oldest bill first. */
  entryIds: string[];
  /** True when the run was already released and nothing was posted this time. */
  alreadyReleased: boolean;
  /**
   * Bills the release paid differently from what the proposal said, because the
   * ageing had moved between the two. Reported rather than quietly dropped —
   * somebody has to be able to explain the difference between the batch that
   * was approved and the money that left.
   */
  restated: RestatedItem[];
}

export interface RestatedItem {
  billId: string;
  billNumber: string;
  supplierName: string;
  /** What the run was approved to pay. */
  proposedMinor: string;
  /** What it actually paid — nought where the bill had been settled since. */
  paidMinor: string;
  reason: string;
}

/**
 * Release the run: the money leaves.
 *
 *   Dr  2000  Trade payables   per bill — what we no longer owe
 *     Cr  1010  Bank             the total that left the account
 *
 * One entry per bill, each settling its own bill, for the reason set out at the
 * top of this file: settlement is recorded on the entry, so a single entry can
 * only discharge one open item and the ageing would otherwise keep showing
 * paid bills as owing. Each entry is what postSupplierPayment() would have
 * posted for that bill on its own, and they carry the run as their sourceId so
 * the batch can be found again as one thing.
 *
 * Idempotent twice over: the run's status stops a second release, and every
 * posting carries an externalKey of its own, so a release interrupted halfway
 * through can be repeated and will post only the entries that are missing.
 *
 * And it pays what is owed on the day it releases, not what was owed on the day
 * it was proposed. A run built on Monday and released on Wednesday can hold a
 * bill somebody paid on Tuesday by cheque or by transfer, and nothing about
 * that payment touches the run — so the ageing is read again here and the
 * difference is written onto the run and returned in `restated`, rather than a
 * supplier being paid twice for the same invoice.
 */
export async function releaseRun(opts: {
  orgId: string;
  runId: string;
  /** Defaults to the run date; the entries are dated by it. */
  releasedOn?: Date | string;
  actorId?: string;
  actorType?: "HUMAN" | "RULE" | "MODEL" | "AGENT" | "INTEGRATION";
}): Promise<ReleaseResult> {
  const run = await loadRun(opts.orgId, opts.runId);

  if (run.status === "released") {
    const v = await view(run);
    return { ...v, entryIds: v.entries.map((e) => e.id), alreadyReleased: true, restated: [] };
  }
  if (run.status === "cancelled") {
    throw new LedgerError(
      `Payment run ${run.reference} was cancelled, so it cannot be released. Propose a new run for what is still owed.`,
    );
  }
  if (run.status !== "approved") {
    throw new LedgerError(
      `Payment run ${run.reference} is ${STATE_WORDS[run.status as RunStatus]} — nobody has approved it. ` +
        `Money does not leave the bank on an unapproved run: have somebody other than whoever prepared it approve it first.`,
    );
  }

  const ins = included(run);
  if (ins.length === 0) {
    throw new LedgerError(`Payment run ${run.reference} has nothing left in it to pay. Cancel it instead of releasing it.`);
  }

  const entryDate = opts.releasedOn === undefined ? run.runDate : asDate(opts.releasedOn, "A release date");

  for (const item of ins) {
    if (!item.billId) {
      throw new LedgerError(
        `${item.billNumber} on run ${run.reference} names no bill, so paying it could not be matched against anything ` +
          `in the payables ageing. Take it out of the run and pay it on its own.`,
      );
    }
  }

  /*
   * What the ageing says NOW, not what it said when the run was proposed.
   *
   * The run is a proposal made on Monday and released on Wednesday, and a bill
   * on it can be paid directly in between — by a cheque, by a transfer, through
   * `postSupplierPayment` — without anything touching the run. Releasing what
   * the proposal said would pay that bill a second time and put the payables
   * control account into debit for it, which is the most expensive mistake this
   * module can make.
   *
   * That it needs no lock is the point of reading it here: the ledger is the
   * record, every one of those payments is in it, and the ageing is the ledger
   * read back. What a re-read cannot do is stop a payment made in the seconds
   * after it — which is why settlement is also keyed per bill on the line
   * below, so a bill paid twice shows as a credit balance on that document
   * rather than disappearing into the supplier's total.
   *
   * Any difference is written onto the run and reported to the caller. Quietly
   * paying less than the batch somebody approved, with nothing to show for the
   * difference, is how a run stops being an auditable act.
   *
   * It is read as at the LATER of the release date and today. A run is dated by
   * its own run date unless the caller says otherwise, so asking the ageing
   * only up to that date would hide a payment made the day after it — which is
   * exactly the settlement this read exists to find. What matters is that the
   * payment is in the ledger, not which side of the run's date it falls.
   */
  const asOf = new Date(Math.max(entryDate.getTime(), Date.now()));
  const nowOwed = await payablesAgeing({ orgId: run.orgId, entityId: run.entityId, asOf });
  const owed = new Map(nowOwed.open.map((o) => [o.sourceId, BigInt(o.outstandingMinor)]));

  const restated: RestatedItem[] = [];
  const paying: { item: LoadedRun["items"][number]; amountMinor: bigint }[] = [];
  for (const item of ins) {
    const billId = item.billId as string;
    // A bill the ageing no longer carries has been settled in full, and a debit
    // balance on one means it was over-paid. Neither is something to pay again.
    const outstanding = owed.get(billId) ?? 0n;
    const pay = outstanding <= 0n ? 0n : outstanding < item.amountMinor ? outstanding : item.amountMinor;
    if (pay === item.amountMinor) {
      paying.push({ item, amountMinor: pay });
      continue;
    }
    restated.push({
      billId,
      billNumber: item.billNumber,
      supplierName: item.supplierName,
      proposedMinor: item.amountMinor.toString(),
      paidMinor: pay.toString(),
      reason: pay === 0n
        ? `${item.billNumber} was settled between this run being proposed and released, so it was not paid again — ` +
          `the payables ledger shows nothing outstanding on it.`
        : `${item.billNumber} was part-settled between this run being proposed and released: ` +
          `${money(item.amountMinor, run.currency)} was proposed, ${money(pay, run.currency)} was still owed, ` +
          `and ${money(pay, run.currency)} was paid.`,
    });
    if (pay > 0n) paying.push({ item, amountMinor: pay });
  }

  if (paying.length === 0) {
    throw new LedgerError(
      `Every bill on payment run ${run.reference} has been settled since it was proposed, so there is nothing left ` +
        `to pay. Cancel the run — releasing it would send ${money(runTotal(run), run.currency)} that is no longer owed.`,
    );
  }

  // What the run is actually paying, written down before the money moves: a run
  // has to be able to explain itself afterwards, and an item whose amount was
  // quietly reduced at the moment of posting cannot.
  if (restated.length) {
    await prisma.$transaction(
      restated.map((r) => {
        const item = ins.find((i) => i.billId === r.billId)!;
        const paid = BigInt(r.paidMinor);
        return paid === 0n
          ? prisma.paymentRunItem.update({
              where: { id: item.id },
              data: { excluded: true, excludeReason: r.reason },
            })
          : prisma.paymentRunItem.update({
              where: { id: item.id },
              data: { amountMinor: paid, excludeReason: r.reason },
            });
      }),
    );
  }

  // One entry for the run, one bank line for the transfer that actually left
  // the account. Posting a separate entry per bill would credit the bank once
  // per bill while the statement shows a single debit for the total, and the
  // bank reconciliation would then have nothing to match — the run would be
  // correct in the payables ledger and unreconcilable in the cash book.
  //
  // What makes that possible is settlement recorded on the line: each payable
  // line names the bill it discharges, so the ageing clears exactly as it
  // would have done paying each bill on its own.
  const total = paying.reduce((a, p) => a + p.amountMinor, 0n);

  /*
   * The organisation's own approval rules, on the largest single movement of
   * money this product makes.
   *
   * This module's header used to argue that the call was not made here "the
   * same reason approvals.ts gives for not making it itself" — that guard was
   * called from nowhere at all, so wiring one path and not the others would
   * have been arbitrary. That reason has gone: `postBill`,
   * `postSupplierPayment`, `postClaim` and the manual journal route all call it
   * now, and a payment run is the one path where a rule saying "payments over a
   * million need two directors" most obviously means to bind. A run settling
   * forty bills bypassing a limit that stops a single payment of the same size
   * is not a policy, it is a gap.
   *
   * The run's own approval stays exactly as it was, and the two are different
   * controls rather than one duplicated. `PaymentRun.approvedBy` and the CHECK
   * behind it say SOMEBODY other than the preparer signed off this run; it is
   * enforced by the database and it does not depend on a rule row existing, so
   * it cannot be deactivated. The rules say WHICH people, and how many, policy
   * wants for money of this size. Where no rule covers the amount this returns
   * quietly and the run's own control is the whole of it, which is the
   * behaviour every organisation that has configured nothing already has.
   */
  await assertApproved({
    orgId: run.orgId,
    entityId: run.entityId,
    subjectType: "PAYMENT",
    subjectId: run.id,
    amountMinor: total,
    reference: run.reference,
    currency: run.currency,
  });

  const entry = await post({
    orgId: run.orgId,
    entityId: run.entityId,
    entryDate,
    memo: `Payment run ${run.reference} — ${paying.length} bill${paying.length === 1 ? "" : "s"}`,
    source: "payment",
    sourceType: "PAYMENT_RUN",
    sourceId: run.id,
    externalKey: `payment-run:${run.id}`,
    actorType: opts.actorType ?? "HUMAN",
    actorId: opts.actorId,
    series: "PR",
    lines: [
      ...paying.map((p) => ({
        account: AP_CONTROL,
        debit: p.amountMinor,
        settlesId: p.item.billId as string,
        memo: `Settles ${p.item.billNumber}`,
      })),
      { account: run.bankAccount, credit: total, memo: `Payment run ${run.reference}` },
    ],
  });

  await prisma.paymentRun.update({
    where: { id: run.id },
    data: { status: "released", entryId: entry.id, releasedAt: new Date() },
  });

  const v = await view(await loadRun(opts.orgId, opts.runId));
  return { ...v, entryIds: [entry.id], alreadyReleased: false, restated };
}

/* ---------------------------------------------------------------- cancelling */

/**
 * Cancel a run before it is released.
 *
 * After release there is nothing to cancel: the cash has moved and the ledger
 * is immutable, so the only honest correction is a reversal — which is what the
 * message says, rather than leaving somebody to discover it.
 *
 * The reason is written onto every item still in the run. The run table has no
 * cancellation-reason column, and the item's is the one place it can live; it
 * also happens to be exactly right — cancelling a run excludes everything in
 * it, and nothing in this module is ever dropped without a reason.
 */
export async function cancelRun(opts: { orgId: string; runId: string; reason: string }): Promise<RunView> {
  const run = await loadRun(opts.orgId, opts.runId);
  const reason = tidy(opts.reason);
  if (!reason) {
    throw new LedgerError(`Say why payment run ${run.reference} is being cancelled. Every supplier on it will want to know.`);
  }
  if (run.status === "released") {
    const entries = await prisma.journalEntry.findMany({
      where: { orgId: run.orgId, sourceType: "PAYMENT_RUN", sourceId: run.id },
      select: { series: true, number: true },
      orderBy: [{ series: "asc" }, { number: "asc" }],
    });
    const named = entries.map((e) => `${e.series}-${e.number}`).join(", ");
    throw new LedgerError(
      `Payment run ${run.reference} was released on ${run.releasedAt ? iso(run.releasedAt) : "its release date"} and the ` +
        `money has gone. A released run cannot be cancelled — reverse the entries it posted instead ` +
        `${named ? `(${named})` : ""}, which puts the payables back and leaves the original postings visible.`,
    );
  }
  if (run.status === "cancelled") {
    throw new LedgerError(`Payment run ${run.reference} was already cancelled.`);
  }

  await prisma.$transaction([
    prisma.paymentRunItem.updateMany({
      where: { runId: run.id, excluded: false },
      data: { excluded: true, excludeReason: `Run ${run.reference} cancelled: ${reason}` },
    }),
    prisma.paymentRun.update({ where: { id: run.id }, data: { status: "cancelled" } }),
  ]);
  return view(await loadRun(opts.orgId, opts.runId));
}

/* ----------------------------------------------------------- the bank file */

export interface Beneficiary {
  /** The supplier name as it appears on the run's items; matched case-insensitively. */
  name: string;
  iban: string;
}

export interface BankFile {
  reference: string;
  filename: string;
  rows: number;
  totalMinor: string;
  csv: string;
}

/** ISO 13616 check digits. A transposed pair in an IBAN fails this, not the bank. */
function ibanValid(iban: string): boolean {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  const rotated = `${iban.slice(4)}${iban.slice(0, 4)}`;
  let expanded = "";
  for (const ch of rotated) expanded += /[0-9]/.test(ch) ? ch : (ch.charCodeAt(0) - 55).toString();
  // Chunked so the modulus never needs a number larger than the arithmetic
  // being exact for — and it is BigInt arithmetic, so it is exact anyway.
  let remainder = 0n;
  for (let i = 0; i < expanded.length; i += 12) remainder = BigInt(`${remainder}${expanded.slice(i, i + 12)}`) % 97n;
  return remainder === 1n;
}

/**
 * The payment instruction file the bank uploads.
 *
 * SUPPLIER BANK DETAILS ARE NOT IN THIS SCHEMA. Counterparty holds terms, a
 * credit limit and a TRN, and nothing about where to send money; inventing a
 * table for it here would create a second supplier master that nothing else
 * maintains and that would quietly go stale. So the caller supplies the
 * beneficiaries, and this refuses to guess.
 *
 * It refuses ALL AT ONCE, naming every beneficiary that is missing or wrong. A
 * bank rejects the whole file for one bad row, so finding out about the
 * accounts one at a time — upload, reject, fix, upload — is a morning gone.
 */
export async function bankFile(opts: {
  orgId: string;
  runId: string;
  beneficiaries: Beneficiary[];
  /** Fixed for tests; the file records when it was produced. */
  createdAt?: Date;
}): Promise<BankFile> {
  const run = await loadRun(opts.orgId, opts.runId);

  if (run.status === "draft") {
    throw new LedgerError(
      `Payment run ${run.reference} has not been approved, so no bank file can be built from it. The file is the ` +
        `instruction that moves the money — building it before the approval is how a run gets paid without one.`,
    );
  }
  if (run.status === "cancelled") {
    throw new LedgerError(`Payment run ${run.reference} was cancelled. Nothing on it should reach the bank.`);
  }

  const ins = included(run);
  if (ins.length === 0) throw new LedgerError(`Payment run ${run.reference} has no payments left in it to instruct.`);

  const byName = new Map<string, string>();
  for (const b of opts.beneficiaries ?? []) byName.set(fold(b.name ?? ""), (b.iban ?? "").replace(/\s+/g, "").toUpperCase());

  const problems: string[] = [];
  for (const item of ins) {
    const iban = byName.get(fold(item.supplierName));
    if (!iban) problems.push(`${item.supplierName} (${item.billNumber}) has no IBAN`);
    else if (!ibanValid(iban)) problems.push(`${item.supplierName} (${item.billNumber}) has "${iban}", which is not a valid IBAN`);
  }
  if (problems.length) {
    throw new LedgerError(
      `The bank file for ${run.reference} cannot be built: ${problems.join("; ")}. ` +
        `A bank rejects the whole file for one bad row, so fix all of ${problems.length === 1 ? "this" : "these"} before ` +
        `generating it.`,
    );
  }

  // One row per bill rather than one per supplier: the supplier reconciles the
  // money against an invoice number, and a merged payment with three invoices
  // in one reference field is what generates the email asking what it was for.
  const rows = [["Beneficiary", "IBAN", "Amount", "Currency", "Reference"].join(",")];
  let total = 0n;
  for (const item of ins) {
    total += item.amountMinor;
    rows.push([
      csvField(item.supplierName),
      byName.get(fold(item.supplierName)) as string,
      decimal(item.amountMinor, run.currency),
      run.currency,
      csvField(`${run.reference} ${item.billNumber}`),
    ].join(","));
  }

  const created = opts.createdAt ?? new Date();
  return {
    reference: run.reference,
    filename: `PAYMENTS_${run.reference.replace(/[^A-Za-z0-9]+/g, "")}_${iso(created).replace(/-/g, "")}.csv`,
    rows: ins.length,
    totalMinor: total.toString(),
    // A trailing newline: some bank uploaders drop a final record without one.
    csv: `${rows.join("\n")}\n`,
  };
}

/* ------------------------------------------------------------------ reading */

export interface RunListRow {
  id: string;
  reference: string;
  runDate: string;
  status: RunStatus;
  bankAccount: string;
  currency: string;
  preparedBy: string | null;
  approvedBy: string | null;
  includedCount: number;
  excludedCount: number;
  totalMinor: string;
  excludedMinor: string;
}

export interface RunList {
  runs: RunListRow[];
  /** Approved and not yet released: money that has been signed for and not sent. */
  awaitingReleaseMinor: string;
  /** Prepared and not yet approved — the queue somebody has to look at. */
  awaitingApprovalMinor: string;
}

export async function runList(opts: { orgId: string; entityId: string; status?: RunStatus }): Promise<RunList> {
  const runs = await prisma.paymentRun.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, ...(opts.status ? { status: opts.status } : {}) },
    include: { items: true },
    orderBy: [{ runDate: "desc" }, { reference: "desc" }],
  });

  let awaitingRelease = 0n;
  let awaitingApproval = 0n;
  const rows = runs.map((r) => {
    const ins = r.items.filter((i) => !i.excluded);
    const total = ins.reduce((a, i) => a + i.amountMinor, 0n);
    if (r.status === "approved") awaitingRelease += total;
    if (r.status === "draft") awaitingApproval += total;
    return {
      id: r.id,
      reference: r.reference,
      runDate: iso(r.runDate),
      status: r.status as RunStatus,
      bankAccount: r.bankAccount,
      currency: r.currency,
      preparedBy: r.preparedBy,
      approvedBy: r.approvedBy,
      includedCount: ins.length,
      excludedCount: r.items.length - ins.length,
      totalMinor: total.toString(),
      excludedMinor: r.items.filter((i) => i.excluded).reduce((a, i) => a + i.amountMinor, 0n).toString(),
    };
  });

  return {
    runs: rows,
    awaitingReleaseMinor: awaitingRelease.toString(),
    awaitingApprovalMinor: awaitingApproval.toString(),
  };
}

export async function runDetail(opts: { orgId: string; runId: string }): Promise<RunView> {
  return view(await loadRun(opts.orgId, opts.runId));
}
