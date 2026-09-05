import { prisma } from "@/lib/server/prisma";
import { post, LedgerError, type PostLine } from "./post";
import { assertApproved } from "./approvals";

/**
 * Employee expense claims — the subledger for money staff spent out of their
 * own pocket on the company's behalf.
 *
 * It looks like payables and it is not. A supplier bill arrives with a document
 * behind it and a supplier who will chase the payment; an expense claim arrives
 * with a person who works here, a handful of receipts, and nobody outside the
 * business who has any reason to check it. So the control that matters here is
 * not the reconciliation — it is the approval, and specifically that the
 * approver is not the claimant. Everything else in this file is bookkeeping.
 *
 * The shape of a posted claim:
 *
 *   Dr  6xxx  Expense                net, plus any VAT that cannot be reclaimed
 *   Dr  1350  VAT input              only the VAT backed by a valid tax invoice
 *     Cr  2200  Payable to the employee   everything they actually spent
 *
 * The VAT split is the part people get wrong. Under Article 55 of Federal
 * Decree-Law 8/2017 input tax is recoverable only where the taxable person
 * holds a valid tax invoice showing the supplier's TRN. A taxi receipt, a
 * handwritten chit, a foreign hotel folio — the VAT on those is not recoverable,
 * and it does not vanish either: it is money the business spent, so it belongs
 * in the expense account with the rest of the cost. Booking it to 1350 anyway
 * overstates the recoverable input tax on the VAT return, which is the
 * expensive mistake; writing it off to a "VAT written off" bin understates the
 * cost of the expense, which is merely a wrong one.
 */

/* ------------------------------------------------------------------ accounts */

/**
 * What the business owes the employee.
 *
 * The UAE chart in setup.ts has 1400 Employee advances — an asset, money paid
 * *to* staff before they spend it — but no liability for reimbursements owed
 * back to them. Rather than invent an account this ledger's chart does not
 * have, a claim credits 2200 Salaries payable: it is already the account where
 * amounts due to staff sit, and it is already the account the payroll run and
 * the WPS transfer settle. If the chart later gains a dedicated
 * "Reimbursements payable", only this constant moves.
 */
const EMPLOYEE_PAYABLE = "2200";
const VAT_INPUT = "1350";
const BANK = "1010";

/**
 * Where an uncoded claim line lands. Travel and entertainment (6400) is the
 * archetypal expense claim, but guessing it would put restaurant bills and
 * stationery in the same place on no evidence. An uncoded line goes to other
 * operating expenses, which is honest about what is known.
 */
const DEFAULT_EXPENSE = "6900";

/* ------------------------------------------------------------ status machine */

export type ClaimStatus = "draft" | "submitted" | "approved" | "rejected" | "posted" | "paid";

/**
 * Every legal move a claim can make, in one place — the same shape as the
 * period status machine in the periods route. Anything not listed here is
 * refused, so there is exactly one statement of the lifecycle to read and to
 * argue with.
 *
 * The asymmetry is deliberate. A claim can go back to draft from submitted or
 * rejected, because it has not touched the ledger yet and correcting it is
 * free. Once posted it never can: the entry exists, the VAT return may already
 * have read it, and the only honest correction is a reversal.
 */
const NEXT: Record<ClaimStatus, ClaimStatus[]> = {
  draft: ["submitted"],
  submitted: ["approved", "rejected", "draft"],
  approved: ["posted", "rejected"],
  rejected: ["draft"],
  posted: ["paid"],
  paid: [],
};

/** Why the machine is shaped the way it is, said to the user who hit the wall. */
const WHY: Record<ClaimStatus, string> = {
  draft: "A draft is submitted first, so that someone other than the claimant sees it.",
  submitted: "A submitted claim is approved or rejected, or sent back to draft to be corrected.",
  approved: "An approved claim is posted to the ledger, or rejected before it gets there.",
  rejected: "A rejected claim goes back to draft, is corrected, and is submitted again.",
  posted: "A posted claim has already reached the general ledger, so it can only be paid — correct it by reversing its journal entry, never by editing the claim.",
  paid: "A paid claim is finished. Anything after it is a new claim or a reversal.",
};

function assertTransition(claim: { reference: string; status: string }, to: ClaimStatus): void {
  const from = claim.status as ClaimStatus;
  if ((NEXT[from] ?? []).includes(to)) return;
  throw new LedgerError(
    `Claim ${claim.reference} is ${from} and cannot move to ${to}. ${WHY[from] ?? "That is not a status this ledger recognises."}`,
  );
}

/* ------------------------------------------------------------------- helpers */

function minor(v: number | bigint | string | undefined, what: string): bigint {
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

export interface ClaimTotals {
  /** What the receipts said before tax. */
  netMinor: bigint;
  /** All the VAT on the receipts, recoverable or not. */
  vatMinor: bigint;
  /** The VAT backed by a valid tax invoice, and only that. */
  recoverableVatMinor: bigint;
  /** VAT that cannot be reclaimed, and therefore is part of the cost. */
  blockedVatMinor: bigint;
  /** What hits the profit and loss: net plus the blocked VAT. */
  expenseMinor: bigint;
  /** What the employee is out of pocket, and so what they are owed. */
  totalMinor: bigint;
}

type LineLike = { netMinor: bigint; vatMinor: bigint; vatRecoverable: boolean };

export function totalsOf(lines: LineLike[]): ClaimTotals {
  let net = 0n, vat = 0n, recoverable = 0n, blocked = 0n;
  for (const l of lines) {
    net += l.netMinor;
    vat += l.vatMinor;
    if (l.vatRecoverable) recoverable += l.vatMinor;
    else blocked += l.vatMinor;
  }
  return {
    netMinor: net,
    vatMinor: vat,
    recoverableVatMinor: recoverable,
    blockedVatMinor: blocked,
    expenseMinor: net + blocked,
    totalMinor: net + vat,
  };
}

async function loadClaim(orgId: string, claimId: string) {
  const claim = await prisma.expenseClaim.findFirst({
    where: { id: claimId, orgId },
    include: { lines: { orderBy: [{ spentOn: "asc" }, { id: "asc" }] } },
  });
  if (!claim) throw new LedgerError("That expense claim does not exist.");
  return claim;
}

function assertDraft(claim: { reference: string; status: string }): void {
  if (claim.status === "draft") return;
  throw new LedgerError(
    `Claim ${claim.reference} is ${claim.status}, so its lines can no longer be changed. ` +
      `Only a draft claim is editable — an approver has to see the same claim the claimant submitted.`,
  );
}

/* -------------------------------------------------------------------- drafting */

export interface NewClaimLine {
  spentOn: Date | string;
  description: string;
  /** Where the cost belongs in the chart; defaults to other operating expenses. */
  accountCode?: string;
  netMinor: number | bigint | string;
  vatMinor?: number | bigint | string;
  /** From the tax invoice. Fifteen digits, or the VAT is not recoverable. */
  supplierTrn?: string | null;
  vatRecoverable?: boolean;
  receiptRef?: string | null;
}

/**
 * Validate one line before it reaches the table.
 *
 * The database enforces most of this independently (netMinor <> 0, vatMinor >= 0,
 * and recoverable VAT requiring both a TRN and a positive amount). These checks
 * exist so the claimant is told which receipt is wrong and what to do about it,
 * rather than being handed a constraint name.
 */
function prepareLine(claimRef: string, l: NewClaimLine) {
  const description = (l.description ?? "").trim();
  if (!description) {
    throw new LedgerError(
      `Every line on claim ${claimRef} needs a description of what was bought. An expense nobody can identify is one nobody can approve.`,
    );
  }
  if (!l.spentOn) {
    throw new LedgerError(`Line "${description}" on claim ${claimRef} needs the date the money was spent.`);
  }

  const net = minor(l.netMinor, `Net amount on "${description}"`);
  const vat = minor(l.vatMinor ?? 0, `VAT on "${description}"`);
  if (net === 0n) {
    throw new LedgerError(`Line "${description}" on claim ${claimRef} claims nothing. Give it an amount, or take it off the claim.`);
  }
  if (vat < 0n) {
    throw new LedgerError(
      `VAT on "${description}" (claim ${claimRef}) cannot be negative. A refund is a negative net amount, not negative tax.`,
    );
  }

  const recoverable = l.vatRecoverable ?? false;
  const trn = (l.supplierTrn ?? "").trim() || null;
  if (recoverable) {
    // Article 55 of Federal Decree-Law 8/2017: input tax is recoverable only
    // where the business holds a valid tax invoice showing the supplier's TRN.
    // Without one the VAT is still a cost — it is just the company's cost, not
    // the FTA's problem — so the fix is to clear the flag, not to delete the VAT.
    if (!trn) {
      throw new LedgerError(
        `Line "${description}" on claim ${claimRef} claims recoverable VAT but names no supplier TRN. ` +
          `Input tax is only recoverable against a valid tax invoice showing the supplier's TRN (UAE VAT Decree-Law Art 55). ` +
          `Enter the TRN from the receipt, or mark the VAT non-recoverable and it will be absorbed into the expense.`,
      );
    }
    if (vat <= 0n) {
      throw new LedgerError(
        `Line "${description}" on claim ${claimRef} is marked VAT-recoverable but carries no VAT. ` +
          `Enter the VAT shown on the tax invoice, or clear the recoverable flag.`,
      );
    }
    if (!/^\d{15}$/.test(trn)) {
      throw new LedgerError(
        `Supplier TRN "${trn}" on line "${description}" of claim ${claimRef} is not a UAE TRN — a TRN is fifteen digits. ` +
          `Input tax recovered against an invalid TRN is a disallowed claim, so check the receipt before ticking recoverable.`,
      );
    }
  }

  return {
    spentOn: asDate(l.spentOn),
    description,
    accountCode: (l.accountCode ?? "").trim() || DEFAULT_EXPENSE,
    netMinor: net,
    vatMinor: vat,
    supplierTrn: trn,
    vatRecoverable: recoverable,
    receiptRef: (l.receiptRef ?? "")?.trim() || null,
  };
}

export interface NewClaim {
  reference: string;
  employeeCode: string;
  employeeName: string;
  claimedOn: Date | string;
  currency?: string;
  notes?: string | null;
  lines?: NewClaimLine[];
}

/** Start a claim. It begins as a draft: nothing about it is a control yet. */
export async function createClaim(opts: { orgId: string; entityId: string; claim: NewClaim }) {
  const c = opts.claim;
  const reference = (c.reference ?? "").trim();
  const employeeCode = (c.employeeCode ?? "").trim();
  const employeeName = (c.employeeName ?? "").trim();

  if (!reference) throw new LedgerError("An expense claim needs a reference — it is what the approver and the payment will both quote.");
  if (!employeeCode || !employeeName) {
    throw new LedgerError(`Claim ${reference} needs the employee's code and name. A claim has to say who is being reimbursed.`);
  }
  if (!c.claimedOn) throw new LedgerError(`Claim ${reference} needs a claim date; it decides which period the expense lands in.`);

  const clash = await prisma.expenseClaim.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, reference },
    select: { id: true, status: true },
  });
  if (clash) {
    throw new LedgerError(`Claim reference ${reference} is already in use by a ${clash.status} claim. Give this one its own reference.`);
  }

  const lines = (c.lines ?? []).map((l) => prepareLine(reference, l));

  return prisma.expenseClaim.create({
    data: {
      orgId: opts.orgId,
      entityId: opts.entityId,
      reference,
      employeeCode,
      employeeName,
      claimedOn: asDate(c.claimedOn),
      currency: c.currency ?? "AED",
      status: "draft",
      notes: c.notes ?? null,
      lines: { create: lines.map((l) => ({ orgId: opts.orgId, ...l })) },
    },
    include: { lines: true },
  });
}

/** Add one receipt to a draft claim. */
export async function addLine(opts: { orgId: string; claimId: string; line: NewClaimLine }) {
  const claim = await loadClaim(opts.orgId, opts.claimId);
  assertDraft(claim);
  const line = prepareLine(claim.reference, opts.line);
  return prisma.expenseClaimLine.create({ data: { orgId: opts.orgId, claimId: claim.id, ...line } });
}

/** Take a receipt back off a draft claim. */
export async function removeLine(opts: { orgId: string; claimId: string; lineId: string }) {
  const claim = await loadClaim(opts.orgId, opts.claimId);
  assertDraft(claim);
  const line = claim.lines.find((l) => l.id === opts.lineId);
  if (!line) throw new LedgerError(`Claim ${claim.reference} has no line ${opts.lineId}.`);
  await prisma.expenseClaimLine.delete({ where: { id: line.id } });
  return { removed: line.id, remaining: claim.lines.length - 1 };
}

/** Edit the header of a draft claim. */
export async function updateClaim(opts: {
  orgId: string;
  claimId: string;
  patch: Partial<Pick<NewClaim, "reference" | "employeeCode" | "employeeName" | "claimedOn" | "currency" | "notes">>;
}) {
  const claim = await loadClaim(opts.orgId, opts.claimId);
  assertDraft(claim);
  const p = opts.patch;

  if (p.reference !== undefined) {
    const reference = p.reference.trim();
    if (!reference) throw new LedgerError(`Claim ${claim.reference} cannot be left without a reference.`);
    if (reference !== claim.reference) {
      const clash = await prisma.expenseClaim.findFirst({
        where: { orgId: opts.orgId, entityId: claim.entityId, reference },
        select: { id: true },
      });
      if (clash) throw new LedgerError(`Claim reference ${reference} is already in use. Give this one its own reference.`);
    }
  }
  if (p.employeeCode !== undefined && !p.employeeCode.trim()) {
    throw new LedgerError(`Claim ${claim.reference} has to say which employee it belongs to.`);
  }
  if (p.employeeName !== undefined && !p.employeeName.trim()) {
    throw new LedgerError(`Claim ${claim.reference} has to name the employee being reimbursed.`);
  }

  return prisma.expenseClaim.update({
    where: { id: claim.id },
    data: {
      ...(p.reference !== undefined ? { reference: p.reference.trim() } : {}),
      ...(p.employeeCode !== undefined ? { employeeCode: p.employeeCode.trim() } : {}),
      ...(p.employeeName !== undefined ? { employeeName: p.employeeName.trim() } : {}),
      ...(p.claimedOn !== undefined ? { claimedOn: asDate(p.claimedOn) } : {}),
      ...(p.currency !== undefined ? { currency: p.currency } : {}),
      ...(p.notes !== undefined ? { notes: p.notes } : {}),
    },
    include: { lines: true },
  });
}

/* ------------------------------------------------------------------ approval */

/** Hand the claim to an approver. An empty claim is not a claim. */
export async function submitClaim(opts: { orgId: string; claimId: string }) {
  const claim = await loadClaim(opts.orgId, opts.claimId);
  assertTransition(claim, "submitted");

  if (claim.lines.length === 0) {
    throw new LedgerError(
      `Claim ${claim.reference} has no lines, so there is nothing to approve. Add the receipts before submitting it.`,
    );
  }
  const totals = totalsOf(claim.lines);
  if (totals.totalMinor === 0n) {
    throw new LedgerError(
      `Claim ${claim.reference} nets to nothing, so it reimburses nothing. Check the lines before submitting it.`,
    );
  }

  return prisma.expenseClaim.update({
    where: { id: claim.id },
    data: { status: "submitted", submittedAt: new Date(), rejectedReason: null },
    include: { lines: true },
  });
}

/** Two people looking at the same claim, by code — trimmed and case-insensitive. */
const samePerson = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Approve a claim.
 *
 * This is the one control in the whole subledger that is worth anything, so it
 * is the one thing the code refuses outright: an employee cannot approve their
 * own claim. Every other check here protects the books; this one protects the
 * bank account. The database already insists that an approved claim records an
 * approver and a time — a tick with nobody's name against it is not an approval
 * — and this adds the part a CHECK constraint cannot see, which is whether the
 * name against it is the claimant's own.
 *
 * The claimant is identified by the claim's `employeeCode`, so `approverId` has
 * to be drawn from the same namespace for the comparison to mean anything — an
 * employee code against a user id would compare two things that are never
 * equal, and the check would pass every time while protecting nothing.
 */
export async function approveClaim(opts: { orgId: string; claimId: string; approverId: string; approvedOn?: Date | string }) {
  const claim = await loadClaim(opts.orgId, opts.claimId);
  assertTransition(claim, "approved");

  const approverId = (opts.approverId ?? "").trim();
  if (!approverId) {
    throw new LedgerError(
      `Approving claim ${claim.reference} needs the approver's identity. An approval nobody signed is a checkbox, not a control.`,
    );
  }
  if (samePerson(approverId, claim.employeeCode)) {
    throw new LedgerError(
      `Claim ${claim.reference} was claimed by ${claim.employeeName} (${claim.employeeCode}) and cannot be approved by the same person. ` +
        `An expense claim has to be approved by somebody other than the claimant — self-approval is the only thing standing between a reimbursement and a withdrawal.`,
    );
  }

  return prisma.expenseClaim.update({
    where: { id: claim.id },
    data: {
      status: "approved",
      approvedBy: approverId,
      approvedAt: opts.approvedOn ? asDate(opts.approvedOn) : new Date(),
      rejectedReason: null,
    },
    include: { lines: true },
  });
}

/**
 * Send a claim back.
 *
 * A rejection without a reason is worse than no rejection: the claimant learns
 * only that somebody said no, resubmits the same thing, and the approver is
 * asked again. The database refuses a rejected claim with no reason; this names
 * the claim and says what the reason is for.
 */
export async function rejectClaim(opts: { orgId: string; claimId: string; approverId: string; reason: string }) {
  const claim = await loadClaim(opts.orgId, opts.claimId);
  assertTransition(claim, "rejected");

  const reason = (opts.reason ?? "").trim();
  if (!reason) {
    throw new LedgerError(
      `Rejecting claim ${claim.reference} needs a reason. The claimant has to know what to fix, or they will simply submit it again.`,
    );
  }
  const approverId = (opts.approverId ?? "").trim();
  if (!approverId) throw new LedgerError(`Rejecting claim ${claim.reference} needs the identity of whoever rejected it.`);

  return prisma.expenseClaim.update({
    where: { id: claim.id },
    data: { status: "rejected", rejectedReason: reason },
    include: { lines: true },
  });
}

/**
 * Send a claim back to draft so it can be corrected.
 *
 * Legal from submitted (the approver wants it fixed rather than refused) and
 * from rejected (the claimant is fixing it). Never from posted: the transition
 * map has no route out of the ledger, because there isn't one.
 *
 * Any approval already on the claim is cleared. A claim that goes back for
 * changes has to be approved again afterwards — otherwise "approved" would
 * describe a version of the claim nobody approved.
 */
export async function reopenClaim(opts: { orgId: string; claimId: string }) {
  const claim = await loadClaim(opts.orgId, opts.claimId);
  assertTransition(claim, "draft");

  return prisma.expenseClaim.update({
    where: { id: claim.id },
    data: { status: "draft", submittedAt: null, approvedAt: null, approvedBy: null, rejectedReason: null },
    include: { lines: true },
  });
}

/* ------------------------------------------------------------------- posting */

export interface PostClaimResult {
  entryId: string;
  reference: string;
  alreadyPosted: boolean;
  /** What went to the expense accounts — net plus the VAT that is not recoverable. */
  expenseMinor: string;
  /** What went to 1350, and so onto the VAT return. */
  recoverableVatMinor: string;
  /** VAT the business swallowed, absorbed into the expense rather than reclaimed. */
  blockedVatMinor: string;
  /** What the employee is owed. */
  payableMinor: string;
}

/**
 * Post an approved claim to the general ledger.
 *
 *   Dr  6xxx  Expense    net, plus the VAT that could not be reclaimed
 *   Dr  1350  VAT input  only where the line is backed by a valid tax invoice
 *     Cr  2200  Owed to the employee   everything they spent
 *
 * The VAT treatment is the whole point of the function. Recoverable VAT is
 * tagged INPUT_VAT so the VAT return picks it up from the ledger — the return is
 * computed from these postings, not from a second pass over the claims, which
 * is what stops the two disagreeing. Non-recoverable VAT deliberately carries
 * no input-tax tag and never touches 1350: under Article 55 of the UAE VAT
 * Decree-Law it cannot be reclaimed without a valid tax invoice showing the
 * supplier's TRN, and VAT that cannot be reclaimed is not a tax asset at all —
 * it is part of what the thing cost. So it is added to the expense account.
 *
 * Idempotent on `expense-claim:<id>`: posting twice returns the first entry.
 */
export async function postClaim(opts: {
  orgId: string;
  claimId: string;
  /** Rate to AED when the claim is in another currency. */
  fxRate?: number;
  actorId?: string;
  actorType?: "HUMAN" | "RULE" | "MODEL" | "AGENT" | "INTEGRATION";
}): Promise<PostClaimResult> {
  const claim = await loadClaim(opts.orgId, opts.claimId);
  const totals = totalsOf(claim.lines);

  const externalKey = `expense-claim:${claim.id}`;
  const existing = await prisma.journalEntry.findFirst({
    where: { orgId: opts.orgId, externalKey },
    select: { id: true, series: true, number: true },
  });
  if (existing) {
    // A retried post is not an error and must not produce a second entry —
    // paying an employee twice is exactly as expensive as paying a supplier twice.
    //
    // It can also be a repair. If a previous attempt wrote the entry and then
    // died before the claim was updated, the claim is sitting in approved with
    // a real posting behind it: it can never be paid, and it is counted as an
    // unposted liability twice over. Converging it here is the only way that
    // gets fixed without somebody writing an UPDATE by hand.
    if (claim.status === "approved") {
      await prisma.expenseClaim.update({
        where: { id: claim.id },
        data: { status: "posted", entryId: existing.id },
      });
    }
    return {
      entryId: existing.id,
      reference: `${existing.series}-${existing.number}`,
      alreadyPosted: true,
      expenseMinor: totals.expenseMinor.toString(),
      recoverableVatMinor: totals.recoverableVatMinor.toString(),
      blockedVatMinor: totals.blockedVatMinor.toString(),
      payableMinor: totals.totalMinor.toString(),
    };
  }

  assertTransition(claim, "posted");
  if (claim.lines.length === 0) {
    throw new LedgerError(`Claim ${claim.reference} has no lines, so there is nothing to post.`);
  }
  if (totals.totalMinor === 0n) {
    throw new LedgerError(
      `Claim ${claim.reference} nets to nothing, so it owes the employee nothing and has nothing to post. Check the lines.`,
    );
  }

  // The one approval this file knows about — approveClaim() above — is a single
  // signature from somebody other than the claimant. That is the right control
  // for a taxi receipt and nowhere near enough for a 200,000 relocation claim,
  // which is what the rules in approvals.ts exist to say. So both apply: the
  // claim has to be in `approved` (checked immediately above by
  // assertTransition) AND it has to satisfy whatever the entity's rules ask
  // for. Neither substitutes for the other, and dropping this call would leave
  // an organisation reading "claims over 50,000 need a director" off its own
  // screen while every one of them posted on a line manager's tick.
  //
  // Called on every claim, not only the big ones: where no rule covers the
  // amount assertApproved returns quietly, which is what makes an unconditional
  // call safe and what stops this becoming a guard somebody forgets.
  //
  // The amount is totalMinor — net plus ALL the VAT, recoverable or not, which
  // is what the employee is actually out of pocket and what the business will
  // reimburse. It is deliberately the same figure pendingFor() and the
  // approvals route compute for this claim from totalsOf(), because an approval
  // records the amount it was shown and counts for nothing if the two disagree:
  // testing expenseMinor here instead would make every approval collected
  // through the approvals screen look stale and nothing would ever post.
  //
  // Nothing has been written at this point — the entry and the status update
  // both happen below — so a refusal leaves the claim exactly as it was, still
  // approved and still postable once the signatures are in. And a claim whose
  // entry already exists returned further up, so a rule written after the fact
  // cannot block the repair path or a retry.
  await assertApproved({
    orgId: claim.orgId,
    entityId: claim.entityId,
    subjectType: "EXPENSE_CLAIM",
    subjectId: claim.id,
    amountMinor: totals.totalMinor,
    reference: claim.reference,
    // The claim's own currency, so the refusal quotes the figure in the unit
    // the receipts were in. The thresholds are held in AED, so a claim in
    // another currency is still compared against a dirham limit at its face
    // value — the same known limitation postBill() carries, set out at length
    // there. It is not fixed by converting on one path only.
    currency: claim.currency,
  });

  const fxRate = claim.currency === "AED" ? undefined : opts.fxRate;
  if (claim.currency !== "AED" && !(fxRate && fxRate > 0)) {
    throw new LedgerError(
      `Claim ${claim.reference} is in ${claim.currency} but carries no exchange rate to AED. Set the rate before posting it.`,
    );
  }
  const fx = fxRate === undefined ? {} : { currency: claim.currency, fxRate };

  // Group by account so a claim with four taxi receipts produces one line
  // against 6400, not four. Non-recoverable VAT rides along with its own line's
  // net into the expense account — that is the Article 55 treatment, applied
  // per line because recoverability is a property of the receipt, not of the claim.
  const byAccount = new Map<string, bigint>();
  for (const l of claim.lines) {
    const account = l.accountCode || DEFAULT_EXPENSE;
    const cost = l.netMinor + (l.vatRecoverable ? 0n : l.vatMinor);
    byAccount.set(account, (byAccount.get(account) ?? 0n) + cost);
  }

  const lines: PostLine[] = [];
  for (const [account, amount] of byAccount) {
    // A bucket that nets to zero (an expense and its refund coded together)
    // carries no information; the payable still balances without it.
    if (amount === 0n) continue;
    lines.push({
      account,
      ...(amount > 0n ? { debit: amount } : { credit: -amount }),
      ...fx,
      memo: `${claim.employeeName} — ${claim.reference}`,
    });
  }

  if (totals.recoverableVatMinor !== 0n) {
    lines.push({
      account: VAT_INPUT,
      debit: totals.recoverableVatMinor,
      ...fx,
      memo: "Recoverable input VAT",
      taxCode: "INPUT_VAT",
    });
  }

  const payable = totals.totalMinor;
  lines.push({
    account: EMPLOYEE_PAYABLE,
    ...(payable > 0n ? { credit: payable } : { debit: -payable }),
    ...fx,
    memo: `Due to ${claim.employeeName} (${claim.employeeCode}) — ${claim.reference}`,
  });

  const entry = await post({
    orgId: claim.orgId,
    entityId: claim.entityId,
    entryDate: claim.claimedOn,
    memo: `Expense claim ${claim.reference} — ${claim.employeeName}`,
    source: "expense-claim",
    sourceType: "EXPENSE_CLAIM",
    sourceId: claim.id,
    externalKey,
    actorType: opts.actorType ?? "HUMAN",
    actorId: opts.actorId,
    series: "EX",
    lines,
  });

  // Status and entryId move together: the database refuses a posted claim that
  // does not name the entry it produced, which is what stops a claim claiming
  // to be in the ledger when it is not.
  await prisma.expenseClaim.update({
    where: { id: claim.id },
    data: { status: "posted", entryId: entry.id },
  });

  return {
    entryId: entry.id,
    reference: `${entry.series}-${entry.number}`,
    alreadyPosted: false,
    expenseMinor: totals.expenseMinor.toString(),
    recoverableVatMinor: totals.recoverableVatMinor.toString(),
    blockedVatMinor: totals.blockedVatMinor.toString(),
    payableMinor: totals.totalMinor.toString(),
  };
}

/**
 * Reimburse the employee.
 *
 *   Dr  2200  Owed to the employee   what we no longer owe
 *     Cr  1010  Bank                   what left the account
 *
 * A separate posting with its own idempotency key, because posting the expense
 * and paying it are two events that can be days apart — and because a claim
 * that is posted but unpaid is exactly the thing the "owed to staff" figure on
 * the list is for.
 */
export async function payClaim(opts: {
  orgId: string;
  claimId: string;
  paidOn: Date | string;
  bankAccount?: string;
  /** Distinguishes the payment run; the claim id is used when there is none. */
  paymentId?: string;
  fxRate?: number;
  actorId?: string;
  actorType?: "HUMAN" | "RULE" | "MODEL" | "AGENT" | "INTEGRATION";
}): Promise<{ entryId: string; reference: string; alreadyPaid: boolean; paidMinor: string }> {
  const claim = await loadClaim(opts.orgId, opts.claimId);
  const totals = totalsOf(claim.lines);

  const externalKey = `expense-claim-payment:${claim.id}`;
  const existing = await prisma.journalEntry.findFirst({
    where: { orgId: opts.orgId, externalKey },
    select: { id: true, series: true, number: true },
  });
  if (existing) {
    // Same repair as posting: an entry with no claim status behind it is a
    // reimbursement the ledger has made and the subledger does not know about.
    if (claim.status === "posted") {
      await prisma.expenseClaim.update({
        where: { id: claim.id },
        data: { status: "paid", paidEntryId: existing.id },
      });
    }
    return {
      entryId: existing.id,
      reference: `${existing.series}-${existing.number}`,
      alreadyPaid: true,
      paidMinor: totals.totalMinor.toString(),
    };
  }

  assertTransition(claim, "paid");
  if (totals.totalMinor <= 0n) {
    throw new LedgerError(
      `Claim ${claim.reference} owes the employee nothing, so there is nothing to pay. A claim that nets negative is recovered through payroll, not by a payment out.`,
    );
  }

  const fxRate = claim.currency === "AED" ? undefined : opts.fxRate;
  if (claim.currency !== "AED" && !(fxRate && fxRate > 0)) {
    throw new LedgerError(
      `Claim ${claim.reference} is in ${claim.currency} but carries no exchange rate to AED. Set the rate before paying it.`,
    );
  }
  const fx = fxRate === undefined ? {} : { currency: claim.currency, fxRate };

  const entry = await post({
    orgId: claim.orgId,
    entityId: claim.entityId,
    entryDate: opts.paidOn,
    memo: `Expense reimbursement ${claim.reference} — ${claim.employeeName}`,
    source: "payment",
    sourceType: "EXPENSE_CLAIM_PAYMENT",
    sourceId: opts.paymentId ?? claim.id,
    settlesId: claim.id,
    externalKey,
    actorType: opts.actorType ?? "HUMAN",
    actorId: opts.actorId,
    series: "EP",
    lines: [
      { account: EMPLOYEE_PAYABLE, debit: totals.totalMinor, ...fx, memo: `Settles ${claim.reference}` },
      { account: opts.bankAccount ?? BANK, credit: totals.totalMinor, ...fx, memo: `Reimbursed ${claim.employeeName}` },
    ],
  });

  await prisma.expenseClaim.update({
    where: { id: claim.id },
    data: { status: "paid", paidEntryId: entry.id },
  });

  return {
    entryId: entry.id,
    reference: `${entry.series}-${entry.number}`,
    alreadyPaid: false,
    paidMinor: totals.totalMinor.toString(),
  };
}

/* ------------------------------------------------------------------ reporting */

export interface ClaimSummaryRow {
  id: string;
  /** Whose books it belongs to — a claim is addressed by its own id, not by an entity. */
  entityId: string;
  reference: string;
  employeeCode: string;
  employeeName: string;
  claimedOn: string;
  currency: string;
  status: ClaimStatus;
  lineCount: number;
  approvedBy: string | null;
  rejectedReason: string | null;
  entryId: string | null;
  paidEntryId: string | null;
  totals: ClaimTotals;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

function summarise(claim: {
  id: string; entityId: string; reference: string; employeeCode: string; employeeName: string;
  claimedOn: Date; currency: string; status: string; approvedBy: string | null;
  rejectedReason: string | null; entryId: string | null; paidEntryId: string | null;
  lines: LineLike[];
}): ClaimSummaryRow {
  return {
    id: claim.id,
    // Which entity's books this claim belongs to. Carried because a claim is
    // addressed by its own id — the route reading one has no entity in hand
    // until this says so, and the permission check needs the entity the
    // posting would land in rather than one the caller named.
    entityId: claim.entityId,
    reference: claim.reference,
    employeeCode: claim.employeeCode,
    employeeName: claim.employeeName,
    claimedOn: day(claim.claimedOn),
    currency: claim.currency,
    status: claim.status as ClaimStatus,
    lineCount: claim.lines.length,
    approvedBy: claim.approvedBy,
    rejectedReason: claim.rejectedReason,
    entryId: claim.entryId,
    paidEntryId: claim.paidEntryId,
    totals: totalsOf(claim.lines),
  };
}

/**
 * The claim list, and the two figures anyone actually opens this screen for:
 * what is sitting on somebody's desk waiting to be approved, and what has been
 * approved and still has not been paid. The second is a real liability to staff
 * whether or not it has reached 2200 yet, so it counts approved and posted
 * claims alike — a claim approved on Thursday and posted on Monday is owed to
 * the employee on both days.
 *
 * Both totals are computed over every claim in the entity, never over whatever
 * the caller happened to filter to; a filtered total is how "what we owe staff"
 * quietly becomes "what we owe staff on this page".
 */
export async function claimList(opts: {
  orgId: string;
  entityId: string;
  status?: ClaimStatus | ClaimStatus[];
  employeeCode?: string;
}) {
  const status = opts.status === undefined ? undefined : Array.isArray(opts.status) ? opts.status : [opts.status];

  const claims = await prisma.expenseClaim.findMany({
    where: {
      orgId: opts.orgId,
      entityId: opts.entityId,
      ...(status ? { status: { in: status } } : {}),
      ...(opts.employeeCode ? { employeeCode: opts.employeeCode } : {}),
    },
    include: { lines: true },
    orderBy: [{ claimedOn: "desc" }, { reference: "desc" }],
  });

  const outstanding = await prisma.expenseClaim.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, status: { in: ["submitted", "approved", "posted"] } },
    select: { status: true, lines: { select: { netMinor: true, vatMinor: true, vatRecoverable: true } } },
  });

  let awaitingApproval = 0n, approvedUnpaid = 0n;
  let awaitingCount = 0, approvedCount = 0;
  for (const c of outstanding) {
    const t = totalsOf(c.lines).totalMinor;
    if (c.status === "submitted") { awaitingApproval += t; awaitingCount += 1; }
    else { approvedUnpaid += t; approvedCount += 1; }
  }

  return {
    claims: claims.map(summarise),
    summary: {
      /** Submitted, nobody has looked at it yet. */
      awaitingApprovalMinor: awaitingApproval,
      awaitingApprovalCount: awaitingCount,
      /** Approved or posted, and the employee still has not been paid. */
      approvedUnpaidMinor: approvedUnpaid,
      approvedUnpaidCount: approvedCount,
    },
  };
}

/** One claim, its lines, and the entries it produced. */
export async function claimDetail(opts: { orgId: string; claimId: string }) {
  const claim = await loadClaim(opts.orgId, opts.claimId);

  const entryIds = [claim.entryId, claim.paidEntryId].filter((v): v is string => Boolean(v));
  const entries = entryIds.length
    ? await prisma.journalEntry.findMany({
        where: { id: { in: entryIds }, orgId: opts.orgId },
        select: { id: true, series: true, number: true, status: true, entryDate: true },
      })
    : [];
  const ref = (id: string | null) => {
    const e = entries.find((x) => x.id === id);
    return e ? `${e.series}-${e.number}` : null;
  };

  return {
    claim: {
      ...summarise(claim),
      submittedAt: claim.submittedAt ? claim.submittedAt.toISOString() : null,
      approvedAt: claim.approvedAt ? claim.approvedAt.toISOString() : null,
      notes: claim.notes,
      entryReference: ref(claim.entryId),
      paidEntryReference: ref(claim.paidEntryId),
      /** What this claim is allowed to do next — the same map the server enforces. */
      nextStatuses: NEXT[claim.status as ClaimStatus] ?? [],
    },
    lines: claim.lines.map((l) => ({
      id: l.id,
      spentOn: day(l.spentOn),
      description: l.description,
      accountCode: l.accountCode,
      netMinor: l.netMinor,
      vatMinor: l.vatMinor,
      supplierTrn: l.supplierTrn,
      vatRecoverable: l.vatRecoverable,
      receiptRef: l.receiptRef,
      // What this line will actually cost the P&L once posted: non-recoverable
      // VAT is part of the expense, so the claimant can see it before approval.
      expenseMinor: l.netMinor + (l.vatRecoverable ? 0n : l.vatMinor),
    })),
  };
}

export { EMPLOYEE_PAYABLE as EMPLOYEE_PAYABLE_ACCOUNT, NEXT as CLAIM_TRANSITIONS };
