import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  createClaim, addLine, updateLine, removeLine, updateClaim,
  submitClaim, approveClaim, rejectClaim, reopenClaim,
  postClaim, payClaim, claimList, claimSummary, claimDetail,
  type NewClaimLine,
} from "@/lib/server/ledger/expenses";
import { setRule, decide } from "@/lib/server/ledger/approvals";
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
    db.$executeRawUnsafe(`DELETE FROM "ApprovalDecision" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "ApprovalRule" WHERE "orgId" = '${ORG}'`),
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

  /*
   * Correcting a receipt in place.
   *
   * Without this verb a mistyped figure meant taking the line off and keying
   * the whole receipt again — including the TRN, which is what the input tax
   * rests on.
   */
  it("corrects a line on a draft claim, keeping the claim and the line it is on", async () => {
    const claim = await draft([taxi({ netMinor: 100_000, vatMinor: 5_000 })], { reference: "EXP-FIX" });
    const lineId = claim.lines[0].id;

    const fixed = await updateLine({
      orgId: ORG, claimId: claim.id, lineId,
      line: taxi({ description: "Airport taxi (corrected)", netMinor: 10_000, vatMinor: 500 }),
    });
    expect(fixed.id).toBe(lineId);
    expect(fixed.netMinor).toBe(10_000n);
    expect(fixed.vatMinor).toBe(500n);
    expect(fixed.description).toBe("Airport taxi (corrected)");
    // The recoverable VAT and the TRN behind it survive the correction, which
    // is the whole reason the verb exists.
    expect(fixed.vatRecoverable).toBe(true);
    expect(fixed.supplierTrn).toBe(TRN);

    const detail = await claimDetail({ orgId: ORG, claimId: claim.id });
    expect(detail.lines).toHaveLength(1);
    expect(detail.claim.totals.netMinor).toBe(10_000n);
  });

  it("holds a corrected line to the same rules a new one is held to", async () => {
    const claim = await draft([taxi()], { reference: "EXP-FIX-BAD" });
    const lineId = claim.lines[0].id;

    // Article 55 again, on the way back in: recoverable VAT with the TRN taken
    // off it is refused exactly as `addLine` refuses it.
    await expect(updateLine({
      orgId: ORG, claimId: claim.id, lineId, line: taxi({ supplierTrn: null }),
    })).rejects.toThrow(/names no supplier TRN/i);
    await expect(updateLine({
      orgId: ORG, claimId: claim.id, lineId, line: taxi({ netMinor: 0 }),
    })).rejects.toThrow(/claims nothing/i);

    // And the line is untouched by either refusal.
    const detail = await claimDetail({ orgId: ORG, claimId: claim.id });
    expect(detail.lines[0].netMinor).toBe(100_000n);
    expect(detail.lines[0].supplierTrn).toBe(TRN);
  });

  it("refuses to correct a line once the claim has left the claimant", async () => {
    const claim = await draft([taxi()], { reference: "EXP-FIX-SENT" });
    await submitClaim({ orgId: ORG, claimId: claim.id });
    await expect(updateLine({
      orgId: ORG, claimId: claim.id, lineId: claim.lines[0].id, line: taxi({ netMinor: 1 }),
    })).rejects.toThrow(/Only a draft claim is editable/i);

    // Put it back where it was: the totals further down count what is sitting
    // with an approver, and this claim is not part of that story.
    await reopenClaim({ orgId: ORG, claimId: claim.id });
  });

  it("refuses to correct a line that is not on the claim", async () => {
    const claim = await draft([taxi()], { reference: "EXP-FIX-MISSING" });
    const other = await draft([taxi()], { reference: "EXP-FIX-OTHER" });
    await expect(updateLine({
      orgId: ORG, claimId: claim.id, lineId: other.lines[0].id, line: taxi(),
    })).rejects.toThrow(/has no line/i);
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

  /*
   * The two figures on their own.
   *
   * The attention queue wants exactly these and nothing else, and was getting
   * them by loading every claim the business has ever filed — with every line
   * on every one of them — and then discarding the list. The cost of that grows
   * with the age of the business while the answer stays two numbers. What this
   * test holds is that the cheap read and the list still agree: two answers to
   * "what do we owe staff" is worse than either of them being wrong.
   */
  it("answers what is waiting and what is owed without reading every claim ever filed", async () => {
    const list = await claimList({ orgId: ORG, entityId: ENT });
    const summary = await claimSummary({ orgId: ORG, entityId: ENT });
    expect(summary).toEqual(list.summary);
    expect(summary.awaitingApprovalMinor).toBe(105_000n + 105_000n + 63_000n);
    expect(summary.approvedUnpaidMinor).toBe(105_000n + 42_000n + 31_500n);

    // It is entity-scoped and org-scoped like everything else here: another
    // organisation's staff are not owed anything out of these books.
    const elsewhere = await claimSummary({ orgId: "someone-else", entityId: ENT });
    expect(elsewhere.awaitingApprovalCount).toBe(0);
    expect(elsewhere.approvedUnpaidMinor).toBe(0n);
  });

  /*
   * The entity's approval rules, as they bind on this subledger.
   *
   * approveClaim() is a single signature from somebody who is not the claimant,
   * and that is all it will ever be. The rules in approvals.ts are the other
   * half — how many signatures, from whom, above what amount — and until
   * postClaim() called the guard an organisation could see "claims over 50,000
   * need a director" on its own approvals screen while every one of them posted
   * on a line manager's tick.
   *
   * The threshold is set far above every fixture above so the rest of the file
   * is untouched by it, which is itself the point: a claim under every
   * threshold posts exactly as it always did.
   */
  it("holds a claim over the threshold until the rules are satisfied, and posts it after", async () => {
    // Claims over AED 50,000 need a director, on top of the line manager.
    await setRule({
      orgId: ORG, entityId: ENT, subjectType: "EXPENSE_CLAIM",
      thresholdMinor: 5_000_000, approverRole: "DIRECTOR", approversRequired: 1,
    });

    const claim = await draft(
      [taxi({ description: "Relocation shipping", netMinor: 6_000_000, vatMinor: 300_000 })],
      { reference: "EXP-RULE" },
    );
    await submitClaim({ orgId: ORG, claimId: claim.id });
    // The subledger's own control, fully satisfied: submitted, and approved by
    // somebody other than the claimant.
    const ok = await approveClaim({ orgId: ORG, claimId: claim.id, approverId: "M-900" });
    expect(ok.status).toBe("approved");

    // And still refused, because a line manager's tick is not what the business
    // wrote down for a claim this size.
    await expect(postClaim({ orgId: ORG, claimId: claim.id })).rejects.toThrow(LedgerError);
    await expect(postClaim({ orgId: ORG, claimId: claim.id })).rejects.toThrow(/Expense claim EXP-RULE has not been approved/i);
    await expect(postClaim({ orgId: ORG, claimId: claim.id })).rejects.toThrow(/one more approval from a director/i);

    // Refused before anything was written: no entry, and the claim is left
    // exactly where it was rather than half-moved to posted.
    expect(await db.journalEntry.count({ where: { orgId: ORG, externalKey: `expense-claim:${claim.id}` } })).toBe(0);
    const held = await db.expenseClaim.findUniqueOrThrow({ where: { id: claim.id } });
    expect(held.status).toBe("approved");
    expect(held.entryId).toBeNull();

    await decide({
      orgId: ORG, entityId: ENT, subjectType: "EXPENSE_CLAIM", subjectId: claim.id,
      decision: "APPROVED", decidedBy: "u-dir-1",
      // Net plus ALL the VAT — what the employee is out of pocket, which is the
      // figure postClaim() tests and the figure the approvals screen shows.
      amountMinor: 6_300_000,
      submittedBy: claim.employeeCode,
    });

    const posted = await postClaim({ orgId: ORG, claimId: claim.id });
    expect(posted.alreadyPosted).toBe(false);
    expect(posted.payableMinor).toBe("6300000");
    expect(await linesOf(posted.entryId)).toEqual({
      "6400": 6_000_000n,   // Dr travel — net
      "1350": 300_000n,     // Dr recoverable input VAT
      "2200": -6_300_000n,  // Cr owed to the employee
    });
    expect((await db.expenseClaim.findUniqueOrThrow({ where: { id: claim.id } })).status).toBe("posted");
  });

  it("lets a claim under every threshold post with no decisions on file at all", async () => {
    // The rule above is still in force. A 1,050.00 taxi claim meets none of it,
    // so the guard returns quietly and nothing about the everyday claim
    // changes — which is what makes it safe to call the guard on every posting
    // rather than only on the large ones.
    const claim = await draft([taxi()], { reference: "EXP-UNDER" });
    await submitClaim({ orgId: ORG, claimId: claim.id });
    await approveClaim({ orgId: ORG, claimId: claim.id, approverId: "M-900" });

    const posted = await postClaim({ orgId: ORG, claimId: claim.id });
    expect(posted.payableMinor).toBe("105000");
    expect(await db.approvalDecision.count({ where: { orgId: ORG, subjectId: claim.id } })).toBe(0);
  });

  it("does not count a decision recorded against some other figure", async () => {
    // The failure the whole workflow exists to catch: a claim signed at one
    // amount and posted at another. The signature on file is for a claim that
    // no longer exists, so it counts for nothing and the refusal says so.
    const claim = await draft(
      [taxi({ description: "Conference", netMinor: 6_000_000, vatMinor: 300_000 })],
      { reference: "EXP-REKEYED" },
    );
    await submitClaim({ orgId: ORG, claimId: claim.id });
    await approveClaim({ orgId: ORG, claimId: claim.id, approverId: "M-900" });
    // Signed while the claim came to 52,500.00; a receipt was added afterwards
    // and it now comes to 63,000.00.
    await decide({
      orgId: ORG, entityId: ENT, subjectType: "EXPENSE_CLAIM", subjectId: claim.id,
      decision: "APPROVED", decidedBy: "u-dir-1", amountMinor: 5_250_000,
      submittedBy: claim.employeeCode,
    });

    await expect(postClaim({ orgId: ORG, claimId: claim.id })).rejects.toThrow(/An approval on file was given when this expense claim was/i);
    expect(await db.journalEntry.count({ where: { orgId: ORG, externalKey: `expense-claim:${claim.id}` } })).toBe(0);
  });

  it("keeps the trial balance tied after everything above", async () => {
    const tb = await trialBalance({ orgId: ORG, entityId: ENT, periodLabel: "2026-05" });
    expect(tb.balanced).toBe(true);
    expect(tb.differenceMinor).toBe(0n);
  });
});
