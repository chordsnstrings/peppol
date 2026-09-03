import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  createClaim, addLine, removeLine, updateClaim,
  submitClaim, approveClaim, rejectClaim, reopenClaim,
  postClaim, payClaim, claimList, claimDetail,
  type NewClaimLine,
} from "@/lib/server/ledger/expenses";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { trialBalance } from "@/lib/server/ledger/reports";
import { LedgerError } from "@/lib/server/ledger/post";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-exp";
const ENT = "t-ent-exp";

/** A real fifteen-digit UAE TRN shape — anything else is not recoverable. */
const TRN = "100123456700003";

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "ExpenseClaimLine" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "ExpenseClaim" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "JournalLineDimension" WHERE "lineId" IN (SELECT id FROM "JournalLine" WHERE "orgId" = '${ORG}')`),
    db.$executeRawUnsafe(`DELETE FROM "JournalLine" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "JournalEntry" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "AccountBalance" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Account" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "AccountingPeriod" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "FiscalYear" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Book" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "DocumentSequence" WHERE "orgId" = '${ORG}'`),
  ]);
}

async function linesOf(entryId: string) {
  const rows = await db.journalLine.findMany({ where: { entryId }, include: { account: true }, orderBy: { lineNo: "asc" } });
  const out: Record<string, bigint> = {};
  for (const r of rows) out[r.account.code] = (out[r.account.code] ?? 0n) + r.txnAmountMinor;
  return out;
}

const taxi = (over: Partial<NewClaimLine> = {}): NewClaimLine => ({
  spentOn: "2026-05-06", description: "Airport taxi", accountCode: "6400",
  netMinor: 100_000, vatMinor: 5_000, supplierTrn: TRN, vatRecoverable: true, receiptRef: "R-1",
  ...over,
});

let ref = 0;
async function draft(lines: NewClaimLine[], over: Partial<{ reference: string; employeeCode: string }> = {}) {
  const claim = await createClaim({
    orgId: ORG, entityId: ENT,
    claim: {
      reference: over.reference ?? `EXP-${++ref}`,
      employeeCode: over.employeeCode ?? "E-001",
      employeeName: "Layla Haddad",
      claimedOn: "2026-05-10",
      lines,
    },
  });
  return claim;
}

d("employee expense claims", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("runs a claim from draft to paid, hitting the right accounts on the way", async () => {
    const claim = await draft([
      taxi(),                                                         // 1,000.00 + 50.00 recoverable VAT
      taxi({                                                          // a chit with no TRN: VAT is a cost
        description: "Parking", accountCode: "6900",
        netMinor: 20_000, vatMinor: 1_000, supplierTrn: null, vatRecoverable: false, receiptRef: "R-2",
      }),
    ], { reference: "EXP-HAPPY" });
    expect(claim.status).toBe("draft");

    const submitted = await submitClaim({ orgId: ORG, claimId: claim.id });
    expect(submitted.status).toBe("submitted");
    expect(submitted.submittedAt).not.toBeNull();

    const approved = await approveClaim({ orgId: ORG, claimId: claim.id, approverId: "M-900" });
    expect(approved.status).toBe("approved");
    expect(approved.approvedBy).toBe("M-900");
    expect(approved.approvedAt).not.toBeNull();

    const posted = await postClaim({ orgId: ORG, claimId: claim.id, actorId: "M-900" });
    expect(posted.alreadyPosted).toBe(false);
    expect(posted.reference.startsWith("EX-")).toBe(true);
    expect(await linesOf(posted.entryId)).toEqual({
      "6400": 100_000n,   // Dr travel — net only, its VAT is reclaimable
      "6900": 21_000n,    // Dr other expenses — net PLUS the VAT that cannot be reclaimed
      "1350": 5_000n,     // Dr input VAT — only the line with a valid TRN
      "2200": -126_000n,  // Cr owed to the employee — everything they actually paid out
    });
    expect(posted.payableMinor).toBe("126000");
    expect(posted.blockedVatMinor).toBe("1000");

    const paid = await payClaim({ orgId: ORG, claimId: claim.id, paidOn: "2026-05-20" });
    expect(paid.reference.startsWith("EP-")).toBe(true);
    expect(await linesOf(paid.entryId)).toEqual({
      "2200": 126_000n,   // Dr — no longer owed
      "1010": -126_000n,  // Cr bank — the money left
    });

    const after = await db.expenseClaim.findUniqueOrThrow({ where: { id: claim.id } });
    expect(after.status).toBe("paid");
    expect(after.entryId).toBe(posted.entryId);
    expect(after.paidEntryId).toBe(paid.entryId);
  });

  it("refuses to let an employee approve their own claim", async () => {
    const claim = await draft([taxi()], { reference: "EXP-SELF", employeeCode: "E-777" });
    await submitClaim({ orgId: ORG, claimId: claim.id });
    // Self-approval is the one control that matters here: without it a claim is
    // just a person moving money from the company to themselves.
    await expect(approveClaim({ orgId: ORG, claimId: claim.id, approverId: "E-777" }))
      .rejects.toThrow(/cannot be approved by the same person/i);
    await expect(approveClaim({ orgId: ORG, claimId: claim.id, approverId: " e-777 " }))
      .rejects.toThrow(LedgerError);
    // …and the claim is untouched, still waiting for a real approver.
    const row = await db.expenseClaim.findUniqueOrThrow({ where: { id: claim.id } });
    expect(row.status).toBe("submitted");
    expect(row.approvedBy).toBeNull();
  });

  it("refuses a rejection that does not say why", async () => {
    const claim = await draft([taxi()], { reference: "EXP-REJ" });
    await submitClaim({ orgId: ORG, claimId: claim.id });
    await expect(rejectClaim({ orgId: ORG, claimId: claim.id, approverId: "M-900", reason: "   " }))
      .rejects.toThrow(/needs a reason/i);

    const rejected = await rejectClaim({ orgId: ORG, claimId: claim.id, approverId: "M-900", reason: "No receipt attached." });
    expect(rejected.status).toBe("rejected");
    expect(rejected.rejectedReason).toBe("No receipt attached.");
  });

  it("refuses to post a claim nobody approved", async () => {
    const claim = await draft([taxi()], { reference: "EXP-UNAPPROVED" });
    await submitClaim({ orgId: ORG, claimId: claim.id });
    await expect(postClaim({ orgId: ORG, claimId: claim.id }))
      .rejects.toThrow(/is submitted and cannot move to posted/i);
    // Nothing reached the ledger.
    expect(await db.journalEntry.count({ where: { orgId: ORG, externalKey: `expense-claim:${claim.id}` } })).toBe(0);
  });

  it("never lets a posted claim go back to draft", async () => {
    const claim = await draft([taxi()], { reference: "EXP-NOBACK" });
    await submitClaim({ orgId: ORG, claimId: claim.id });
    await approveClaim({ orgId: ORG, claimId: claim.id, approverId: "M-900" });
    await postClaim({ orgId: ORG, claimId: claim.id });

    await expect(reopenClaim({ orgId: ORG, claimId: claim.id }))
      .rejects.toThrow(/is posted and cannot move to draft/i);
    // Nor may its lines be edited behind the ledger's back.
    await expect(addLine({ orgId: ORG, claimId: claim.id, line: taxi() }))
      .rejects.toThrow(/can no longer be changed/i);
  });

  it("sends a submitted claim back to draft and drops any approval with it", async () => {
    const claim = await draft([taxi()], { reference: "EXP-REOPEN" });
    await submitClaim({ orgId: ORG, claimId: claim.id });
    await approveClaim({ orgId: ORG, claimId: claim.id, approverId: "M-900" });
    await rejectClaim({ orgId: ORG, claimId: claim.id, approverId: "M-900", reason: "Wrong cost centre." });
    const reopened = await reopenClaim({ orgId: ORG, claimId: claim.id });
    expect(reopened.status).toBe("draft");
    // A claim that changed after approval has to be approved again.
    expect(reopened.approvedBy).toBeNull();
    expect(reopened.rejectedReason).toBeNull();
  });

  it("puts recoverable VAT in 1350 and leaves the expense at net", async () => {
    const claim = await draft([taxi({ netMinor: 40_000, vatMinor: 2_000 })], { reference: "EXP-VAT-OK" });
    await submitClaim({ orgId: ORG, claimId: claim.id });
    await approveClaim({ orgId: ORG, claimId: claim.id, approverId: "M-900" });
    const r = await postClaim({ orgId: ORG, claimId: claim.id });
    const l = await linesOf(r.entryId);
    expect(l["6400"]).toBe(40_000n);
    expect(l["1350"]).toBe(2_000n);
    expect(l["2200"]).toBe(-42_000n);
    expect(r.recoverableVatMinor).toBe("2000");

    // It is tagged so the VAT return reads it out of the ledger rather than out
    // of a second pass over the claims.
    const vatLine = await db.journalLine.findFirstOrThrow({
      where: { entryId: r.entryId, account: { code: "1350" } },
    });
    expect(vatLine.taxCode).toBe("INPUT_VAT");
  });

  it("adds non-recoverable VAT to the expense instead of reclaiming it", async () => {
    // A restaurant bill with no TRN on it. Art 55 of the VAT Decree-Law says
    // the input tax is not recoverable — and it is still money the business
    // spent, so it belongs in the expense, not in 1350 and not written off.
    const claim = await draft([
      taxi({ description: "Client lunch", netMinor: 30_000, vatMinor: 1_500, supplierTrn: null, vatRecoverable: false }),
    ], { reference: "EXP-VAT-BLOCKED" });
    await submitClaim({ orgId: ORG, claimId: claim.id });
    await approveClaim({ orgId: ORG, claimId: claim.id, approverId: "M-900" });
    const r = await postClaim({ orgId: ORG, claimId: claim.id });

    const l = await linesOf(r.entryId);
    expect(l["6400"]).toBe(31_500n);        // net 30,000 + the 1,500 that cannot be reclaimed
    expect(l["1350"]).toBeUndefined();      // nothing went to input VAT
    expect(l["2200"]).toBe(-31_500n);
    expect(r.blockedVatMinor).toBe("1500");
    expect(r.recoverableVatMinor).toBe("0");

    // And the detail view shows the claimant the same figure before approval.
    const detail = await claimDetail({ orgId: ORG, claimId: claim.id });
    expect(detail.lines[0].expenseMinor).toBe(31_500n);
  });

  it("refuses recoverable VAT with no supplier TRN behind it", async () => {
    await expect(draft([taxi({ supplierTrn: null, vatRecoverable: true })], { reference: "EXP-NO-TRN" }))
      .rejects.toThrow(/Art 55/i);
    await expect(draft([taxi({ supplierTrn: "12345", vatRecoverable: true })], { reference: "EXP-BAD-TRN" }))
      .rejects.toThrow(/fifteen digits/i);
    await expect(draft([taxi({ vatMinor: 0, vatRecoverable: true })], { reference: "EXP-NO-VAT" }))
      .rejects.toThrow(/carries no VAT/i);
  });

  it("refuses to submit an empty claim, by name", async () => {
    const claim = await draft([], { reference: "EXP-EMPTY" });
    await expect(submitClaim({ orgId: ORG, claimId: claim.id }))
      .rejects.toThrow(/Claim EXP-EMPTY has no lines/);
  });

  it("posts the same claim twice without reimbursing it twice", async () => {
    const claim = await draft([taxi({ netMinor: 15_000, vatMinor: 750 })], { reference: "EXP-DUP" });
    await submitClaim({ orgId: ORG, claimId: claim.id });
    await approveClaim({ orgId: ORG, claimId: claim.id, approverId: "M-900" });
    const first = await postClaim({ orgId: ORG, claimId: claim.id });
    const second = await postClaim({ orgId: ORG, claimId: claim.id });
    expect(second.alreadyPosted).toBe(true);
    expect(second.entryId).toBe(first.entryId);
    expect(await db.journalEntry.count({ where: { orgId: ORG, externalKey: `expense-claim:${claim.id}` } })).toBe(1);

    // The same holds for the payment.
    const p1 = await payClaim({ orgId: ORG, claimId: claim.id, paidOn: "2026-05-25" });
    const p2 = await payClaim({ orgId: ORG, claimId: claim.id, paidOn: "2026-05-25" });
    expect(p2.alreadyPaid).toBe(true);
    expect(p2.entryId).toBe(p1.entryId);
  });

  it("repairs a claim whose entry was written but whose status never caught up", async () => {
    const claim = await draft([taxi({ netMinor: 10_000, vatMinor: 500 })], { reference: "EXP-TORN" });
    await submitClaim({ orgId: ORG, claimId: claim.id });
    await approveClaim({ orgId: ORG, claimId: claim.id, approverId: "M-900" });
    const first = await postClaim({ orgId: ORG, claimId: claim.id });

    // Simulate the process dying between post() and the claim update: the
    // journal entry exists, the claim still says approved.
    await db.expenseClaim.update({ where: { id: claim.id }, data: { status: "approved", entryId: null } });

    const retry = await postClaim({ orgId: ORG, claimId: claim.id });
    expect(retry.alreadyPosted).toBe(true);
    expect(retry.entryId).toBe(first.entryId);
    const healed = await db.expenseClaim.findUniqueOrThrow({ where: { id: claim.id } });
    expect(healed.status).toBe("posted");
    expect(healed.entryId).toBe(first.entryId);
    // And still exactly one entry — the repair does not post a second one.
    expect(await db.journalEntry.count({ where: { orgId: ORG, externalKey: `expense-claim:${claim.id}` } })).toBe(1);

    await payClaim({ orgId: ORG, claimId: claim.id, paidOn: "2026-05-26" });
  });

  it("edits a draft, and refuses a duplicate reference", async () => {
    const claim = await draft([taxi(), taxi({ description: "Hotel", netMinor: 50_000, vatMinor: 2_500 })], { reference: "EXP-EDIT" });
    const removed = await removeLine({ orgId: ORG, claimId: claim.id, lineId: claim.lines[1].id });
    expect(removed.remaining).toBe(1);

    const updated = await updateClaim({ orgId: ORG, claimId: claim.id, patch: { employeeName: "Layla H." } });
    expect(updated.employeeName).toBe("Layla H.");

    await expect(draft([taxi()], { reference: "EXP-EDIT" })).rejects.toThrow(/already in use/i);
  });

  it("shows what is waiting for approval and what is owed to staff", async () => {
    // One more claim left sitting with the approver.
    const waiting = await draft([taxi({ netMinor: 60_000, vatMinor: 3_000 })], { reference: "EXP-WAITING" });
    await submitClaim({ orgId: ORG, claimId: waiting.id });

    const list = await claimList({ orgId: ORG, entityId: ENT });
    const byRef = new Map(list.claims.map((c) => [c.reference, c]));
    expect(byRef.get("EXP-HAPPY")?.status).toBe("paid");
    expect(byRef.get("EXP-HAPPY")?.totals.totalMinor).toBe(126_000n);
    expect(byRef.get("EXP-VAT-BLOCKED")?.totals.blockedVatMinor).toBe(1_500n);

    // Awaiting approval: EXP-SELF (105,000), EXP-UNAPPROVED (105,000), EXP-WAITING (63,000).
    expect(list.summary.awaitingApprovalCount).toBe(3);
    expect(list.summary.awaitingApprovalMinor).toBe(105_000n + 105_000n + 63_000n);

    // Approved-but-unpaid counts posted claims too: EXP-NOBACK (105,000),
    // EXP-VAT-OK (42,000), EXP-VAT-BLOCKED (31,500). EXP-DUP was paid.
    expect(list.summary.approvedUnpaidCount).toBe(3);
    expect(list.summary.approvedUnpaidMinor).toBe(105_000n + 42_000n + 31_500n);

    // A filter narrows the rows but never the "what do we owe staff" figures.
    const filtered = await claimList({ orgId: ORG, entityId: ENT, status: "paid" });
    expect(filtered.claims.every((c) => c.status === "paid")).toBe(true);
    expect(filtered.summary.approvedUnpaidMinor).toBe(list.summary.approvedUnpaidMinor);
  });

  it("keeps the trial balance tied after everything above", async () => {
    const tb = await trialBalance({ orgId: ORG, entityId: ENT, periodLabel: "2026-05" });
    expect(tb.balanced).toBe(true);
    expect(tb.differenceMinor).toBe(0n);
  });
});
