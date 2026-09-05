import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  setRule, listRules, deactivateRule, rulesFor,
  approvalState, decide, withdraw, assertApproved, pendingFor,
} from "@/lib/server/ledger/approvals";
import { seedBuiltInRoles } from "@/lib/server/ledger/permissions";
import { createClaim, submitClaim } from "@/lib/server/ledger/expenses";
import { LedgerError } from "@/lib/server/ledger/post";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-apr";
const ENT = "t-ent-apr";

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "ApprovalDecision" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "ApprovalRule" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "ExpenseClaimLine" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "ExpenseClaim" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "FxRate" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Book" WHERE "orgId" = '${ORG}'`),
  ]);
}

/** The house policy these tests are written against. */
async function policy() {
  // Everything needs a manager; anything six figures needs two directors.
  await setRule({ orgId: ORG, entityId: ENT, subjectType: "PAYMENT", thresholdMinor: 0, approverRole: "MANAGER", approversRequired: 1 });
  await setRule({ orgId: ORG, entityId: ENT, subjectType: "PAYMENT", thresholdMinor: 100_000, approverRole: "DIRECTOR", approversRequired: 2 });
  // Bills name people rather than roles: the AP clerk always, the CFO above 1,000.
  await setRule({ orgId: ORG, entityId: ENT, subjectType: "BILL", thresholdMinor: 0, approverUserId: "u-ops" });
  await setRule({ orgId: ORG, entityId: ENT, subjectType: "BILL", thresholdMinor: 100_000, approverUserId: "u-cfo" });
  // Payroll is only controlled at the top — nothing below 10,000.00 meets a rule.
  await setRule({ orgId: ORG, entityId: ENT, subjectType: "PAYROLL", thresholdMinor: 1_000_000, approverRole: "DIRECTOR" });
  await setRule({ orgId: ORG, entityId: ENT, subjectType: "EXPENSE_CLAIM", thresholdMinor: 0, approverRole: "MANAGER" });
}

const pay = (subjectId: string, extra: Partial<Parameters<typeof decide>[0]> = {}) => ({
  orgId: ORG, entityId: ENT, subjectType: "PAYMENT" as const, subjectId, amountMinor: 500_000, ...extra,
});

d("approval workflows", () => {
  beforeAll(async () => {
    await wipe();
    await policy();
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("refuses a rule that nobody in particular has to satisfy", async () => {
    // The whole point of a rule is that a named someone has to answer it. A rule
    // with neither a role nor a person on it is satisfied by whoever raised the
    // document, which is not a control at all.
    await expect(setRule({ orgId: ORG, entityId: ENT, subjectType: "BILL", thresholdMinor: 500 }))
      .rejects.toThrow(/has to name who may approve/i);
    await expect(setRule({ orgId: ORG, entityId: ENT, subjectType: "BILL", thresholdMinor: 500 }))
      .rejects.toThrow(/anyone can satisfy is not a control/i);

    // Naming both leaves it ambiguous which one is doing the work.
    await expect(setRule({
      orgId: ORG, entityId: ENT, subjectType: "BILL", thresholdMinor: 500,
      approverRole: "DIRECTOR", approverUserId: "u-cfo",
    })).rejects.toThrow(/Pick one/i);

    // One person cannot sign twice, so a rule naming one person cannot ask for two.
    await expect(setRule({
      orgId: ORG, entityId: ENT, subjectType: "BILL", thresholdMinor: 500,
      approverUserId: "u-cfo", approversRequired: 2,
    })).rejects.toThrow(/one person only ever has one/i);

    await expect(setRule({
      orgId: ORG, entityId: ENT, subjectType: "BILL", approverRole: "DIRECTOR", approversRequired: 6,
    })).rejects.toThrow(/between one and five/i);

    await expect(setRule({ orgId: ORG, entityId: ENT, subjectType: "INVOICE", approverRole: "DIRECTOR" }))
      .rejects.toThrow(LedgerError);

    // None of the refusals left a rule behind.
    const rules = await listRules({ orgId: ORG, entityId: ENT, subjectType: "BILL", includeInactive: true });
    expect(rules.every((r) => r.thresholdMinor !== 500n)).toBe(true);
  });

  it("applies every rule the amount clears, not just the closest band", async () => {
    // THIS is the one most implementations get wrong. 5,000.00 clears the rule
    // at zero and the rule at 1,000.00, and both are in force — a big payment
    // does not excuse the everyday signature, it adds to it.
    const big = await rulesFor({ orgId: ORG, entityId: ENT, subjectType: "PAYMENT", amountMinor: 500_000 });
    expect(big.length).toBe(2);
    expect(big.map((r) => r.thresholdMinor)).toEqual([100_000n, 0n]); // most specific first
    expect(big.map((r) => r.approverRole)).toEqual(["DIRECTOR", "MANAGER"]);

    const small = await rulesFor({ orgId: ORG, entityId: ENT, subjectType: "PAYMENT", amountMinor: 50_000 });
    expect(small.map((r) => r.thresholdMinor)).toEqual([0n]);

    // Size, not sign: a 5,000.00 refund moves as much money as a 5,000.00 payment.
    const refund = await rulesFor({ orgId: ORG, entityId: ENT, subjectType: "PAYMENT", amountMinor: -500_000 });
    expect(refund.length).toBe(2);
  });

  it("is not approved until every applicable rule is satisfied", async () => {
    const s0 = await approvalState({ ...pay("PAY-CUM") });
    expect(s0.approved).toBe(false);
    expect(s0.rules.length).toBe(2);
    expect(s0.approvalsOutstanding).toBe(2);

    const first = await decide({ ...pay("PAY-CUM"), decision: "APPROVED", decidedBy: "u-m1" });
    // The manager rule is answered; the two-director rule is not. A naive "find
    // the band" implementation would call this approved, and it is not.
    expect(first.state.approved).toBe(false);
    expect(first.state.approvalsOutstanding).toBe(1);
    expect(first.state.rules.find((r) => r.approverRole === "MANAGER")?.satisfied).toBe(true);
    expect(first.state.rules.find((r) => r.approverRole === "DIRECTOR")?.satisfied).toBe(false);
    expect(first.state.blockers.join(" ")).toMatch(/one more approval from a director/i);

    const second = await decide({ ...pay("PAY-CUM"), decision: "APPROVED", decidedBy: "u-d1" });
    expect(second.state.approved).toBe(true);
    expect(second.state.approvalsOutstanding).toBe(0);
    expect(second.state.blockers).toEqual([]);
    expect(second.state.approvers).toEqual(["u-m1", "u-d1"]);
  });

  it("refuses a second decision from the same person, in a sentence", async () => {
    await decide({ ...pay("PAY-DUP"), decision: "APPROVED", decidedBy: "u-m1" });

    // Two approvers means two people. The unique index guarantees it; what is
    // being tested here is that the approver gets told why rather than being
    // handed a constraint violation.
    const second = decide({ ...pay("PAY-DUP"), decision: "APPROVED", decidedBy: " U-M1 " });
    await expect(second).rejects.toThrow(LedgerError);
    await expect(second).rejects.toThrow(/already approved/i);
    await expect(second).rejects.toThrow(/one decision per document/i);
    await expect(second).rejects.not.toThrow(/unique constraint|P2002/i);

    expect(await db.approvalDecision.count({ where: { orgId: ORG, subjectId: "PAY-DUP" } })).toBe(1);
    const state = await approvalState({ ...pay("PAY-DUP") });
    expect(state.approved).toBe(false);
    expect(state.approvalsOutstanding).toBe(1);
  });

  it("refuses self-approval and says why", async () => {
    const self = decide({ ...pay("PAY-SELF"), decision: "APPROVED", decidedBy: "u-m1", submittedBy: "u-m1" });
    await expect(self).rejects.toThrow(/cannot approve it/i);
    await expect(self).rejects.toThrow(/self-approval/i);

    // Case and whitespace do not make it a different person.
    await expect(decide({ ...pay("PAY-SELF"), decision: "APPROVED", decidedBy: "u-m1", submittedBy: " U-M1 " }))
      .rejects.toThrow(LedgerError);

    expect(await db.approvalDecision.count({ where: { orgId: ORG, subjectId: "PAY-SELF" } })).toBe(0);
  });

  it("lets somebody refuse their own document", async () => {
    // The bar is on approving, not on refusing. Turning down your own payment
    // costs the business nothing and is how a mistake gets withdrawn.
    const r = await decide({
      ...pay("PAY-OWN-NO"), decision: "REJECTED", decidedBy: "u-m1", submittedBy: "u-m1",
      reason: "Keyed against the wrong supplier.",
    });
    expect(r.state.rejected).toBe(true);
    expect(r.decision.reason).toBe("Keyed against the wrong supplier.");
  });

  it("refuses a rejection that does not say why", async () => {
    await expect(decide({ ...pay("PAY-NOREASON"), decision: "REJECTED", decidedBy: "u-d1", reason: "   " }))
      .rejects.toThrow(/needs a reason/i);
    expect(await db.approvalDecision.count({ where: { orgId: ORG, subjectId: "PAY-NOREASON" } })).toBe(0);
  });

  it("keeps a subject rejected even when somebody approves it afterwards", async () => {
    await decide({ ...pay("PAY-REJ"), decision: "REJECTED", decidedBy: "u-d1", reason: "No supporting invoice." });

    const late = decide({ ...pay("PAY-REJ"), decision: "APPROVED", decidedBy: "u-m1" });
    await expect(late).rejects.toThrow(/cannot be approved/i);
    await expect(late).rejects.toThrow(/rejection stands/i);

    const state = await approvalState({ ...pay("PAY-REJ") });
    expect(state.rejected).toBe(true);
    expect(state.approved).toBe(false);
    expect(state.state).toBe("rejected");
    expect(state.rejection?.by).toBe("u-d1");
    expect(state.blockers.join(" ")).toMatch(/withdrawn and resubmitted/i);
  });

  it("clears the round when a rejected subject is withdrawn, and not before", async () => {
    await expect(withdraw({ orgId: ORG, subjectType: "PAYMENT", subjectId: "PAY-REJ", withdrawnBy: "u-m1", reason: "" }))
      .rejects.toThrow(/needs a reason/i);

    const { cleared } = await withdraw({
      orgId: ORG, subjectType: "PAYMENT", subjectId: "PAY-REJ",
      withdrawnBy: "u-m1", reason: "Invoice attached, resubmitting.",
    });
    expect(cleared.length).toBe(1);

    // A fresh round: the same people may now decide again, which the unique
    // index would otherwise have made impossible.
    await decide({ ...pay("PAY-REJ"), decision: "APPROVED", decidedBy: "u-d1" });
    const done = await decide({ ...pay("PAY-REJ"), decision: "APPROVED", decidedBy: "u-m1" });
    expect(done.state.approved).toBe(true);
    expect(done.state.rejected).toBe(false);
  });

  it("says in words who is still outstanding, and counts only the person a rule names", async () => {
    const bill = { orgId: ORG, entityId: ENT, subjectType: "BILL" as const, subjectId: "BILL-BLOCK", amountMinor: 500_000 };

    const before = await approvalState(bill);
    expect(before.blockers.length).toBe(2);
    expect(before.blockers.join(" ")).toMatch(/needs the approval of u-cfo/i);
    expect(before.blockers.join(" ")).toMatch(/needs the approval of u-ops/i);

    // Somebody else's approval does not answer a rule that names a person.
    await decide({ ...bill, decision: "APPROVED", decidedBy: "u-random" });
    const after = await approvalState(bill);
    expect(after.approved).toBe(false);
    expect(after.rules.every((r) => !r.satisfied)).toBe(true);
    expect(after.blockers.join(" ")).toMatch(/needs the approval of u-cfo/i);
  });

  it("assertApproved names what is missing, and passes once it is satisfied", async () => {
    const bill = { orgId: ORG, entityId: ENT, subjectType: "BILL" as const, subjectId: "BILL-GUARD", amountMinor: 500_000 };

    const guard = assertApproved({ ...bill, reference: "BILL-2026-004" });
    await expect(guard).rejects.toThrow(LedgerError);
    await expect(guard).rejects.toThrow(/Supplier bill BILL-2026-004 has not been approved/i);
    await expect(guard).rejects.toThrow(/u-cfo/);

    await decide({ ...bill, decision: "APPROVED", decidedBy: "u-ops" });
    await expect(assertApproved({ ...bill })).rejects.toThrow(/u-cfo/);

    await decide({ ...bill, decision: "APPROVED", decidedBy: "u-cfo" });
    const state = await assertApproved({ ...bill });
    expect(state.approved).toBe(true);
    expect(state.blockers).toEqual([]);
  });

  it("needs no approval at all below every threshold", async () => {
    // Payroll is only controlled above 10,000.00. A 5,000.00 run meets no rule,
    // so the guard passes quietly — which is what makes it safe to call it on
    // every posting rather than only on the big ones.
    const small = { orgId: ORG, entityId: ENT, subjectType: "PAYROLL" as const, subjectId: "PR-SMALL", amountMinor: 500_000 };
    const state = await approvalState(small);
    expect(state.rules).toEqual([]);
    expect(state.approved).toBe(true);
    expect(state.approvalsOutstanding).toBe(0);
    expect(state.blockers).toEqual([]);
    await expect(assertApproved(small)).resolves.toBeTruthy();

    // The same run at 20,000.00 does meet the rule, and is not approved.
    const big = await approvalState({ ...small, subjectId: "PR-BIG", amountMinor: 2_000_000 });
    expect(big.rules.length).toBe(1);
    expect(big.approved).toBe(false);
  });

  it("treats an approval as covering the amount it was shown", async () => {
    const bill = { orgId: ORG, entityId: ENT, subjectType: "BILL" as const, subjectId: "BILL-STALE" };
    // 500.00 clears only the rule at zero, which names u-ops — so his signature
    // is the whole of what this bill needs.
    await decide({ ...bill, amountMinor: 50_000, decision: "APPROVED", decidedBy: "u-ops" });
    expect((await approvalState({ ...bill, amountMinor: 50_000 })).approved).toBe(true);

    // Somebody then re-keys the bill from 500.00 to 5,000.00 after it was
    // signed. The signature on file is for a document that no longer exists —
    // and the new figure has crossed the CFO's threshold besides.
    const changed = await approvalState({ ...bill, amountMinor: 500_000 });
    expect(changed.approved).toBe(false);
    expect(changed.blockers.join(" ")).toMatch(/approval covers the amount it was shown/i);
    expect(changed.blockers.join(" ")).toMatch(/was AED 500\.00, and it is now AED 5,000\.00/);
    expect(changed.blockers.join(" ")).toMatch(/needs the approval of u-ops/i);
  });

  it("returns only what is genuinely waiting on a given person", async () => {
    // Part-approved: u-ops has signed, the CFO rule is outstanding.
    await decide({ orgId: ORG, entityId: ENT, subjectType: "BILL", subjectId: "BILL-P1", amountMinor: 500_000, decision: "APPROVED", decidedBy: "u-ops" });
    // Fully approved.
    await decide({ orgId: ORG, entityId: ENT, subjectType: "BILL", subjectId: "BILL-P2", amountMinor: 500_000, decision: "APPROVED", decidedBy: "u-ops" });
    await decide({ orgId: ORG, entityId: ENT, subjectType: "BILL", subjectId: "BILL-P2", amountMinor: 500_000, decision: "APPROVED", decidedBy: "u-cfo" });
    // Refused.
    await decide({ orgId: ORG, entityId: ENT, subjectType: "BILL", subjectId: "BILL-P3", amountMinor: 500_000, decision: "REJECTED", decidedBy: "u-ops", reason: "Duplicate of BILL-P1." });

    const cfo = await pendingFor({ orgId: ORG, userId: "u-cfo", subjectType: "BILL" });
    const ids = cfo.map((i) => i.subjectId);
    expect(ids).toContain("BILL-P1");
    expect(ids).not.toContain("BILL-P2");  // nothing left to do
    expect(ids).not.toContain("BILL-P3");  // refused, not waiting
    const p1 = cfo.find((i) => i.subjectId === "BILL-P1")!;
    expect(p1.amountMinor).toBe(500_000n);
    expect(p1.approvalsOutstanding).toBe(1);
    expect(p1.blockers.join(" ")).toMatch(/u-cfo/);

    // The person who already signed it is not waiting on it.
    const ops = await pendingFor({ orgId: ORG, userId: "u-ops", subjectType: "BILL" });
    expect(ops.map((i) => i.subjectId)).not.toContain("BILL-P1");

    // Somebody no rule names has an empty queue rather than everybody's work.
    expect(await pendingFor({ orgId: ORG, userId: "u-nobody" })).toEqual([]);
  });

  it("puts a submitted expense claim in front of an approver, never in front of the claimant", async () => {
    const claim = await createClaim({
      orgId: ORG, entityId: ENT,
      claim: {
        reference: "APR-CLAIM-1", employeeCode: "u-claimant", employeeName: "Layla Haddad", claimedOn: "2026-05-10",
        lines: [{ spentOn: "2026-05-06", description: "Airport taxi", accountCode: "6400", netMinor: 100_000, vatMinor: 5_000 }],
      },
    });
    await submitClaim({ orgId: ORG, claimId: claim.id });

    const mgr = await pendingFor({ orgId: ORG, userId: "u-mgr", role: "MANAGER", subjectType: "EXPENSE_CLAIM" });
    const queued = mgr.find((i) => i.subjectId === claim.id);
    expect(queued).toBeTruthy();
    expect(queued!.amountMinor).toBe(105_000n);
    expect(queued!.label).toContain("APR-CLAIM-1");

    // Their own claim is not work waiting on them, whatever role they hold.
    const own = await pendingFor({ orgId: ORG, userId: "u-claimant", role: "MANAGER", subjectType: "EXPENSE_CLAIM" });
    expect(own.map((i) => i.subjectId)).not.toContain(claim.id);

    // And a person whose role nobody can establish is not shown role-based work.
    const unknown = await pendingFor({ orgId: ORG, userId: "u-mgr", subjectType: "EXPENSE_CLAIM" });
    expect(unknown.map((i) => i.subjectId)).not.toContain(claim.id);
  });

  it("replaces the rule that says the same thing rather than doubling it", async () => {
    const before = await listRules({ orgId: ORG, entityId: ENT, subjectType: "PAYMENT" });
    const again = await setRule({
      orgId: ORG, entityId: ENT, subjectType: "PAYMENT", thresholdMinor: 100_000,
      approverRole: "DIRECTOR", approversRequired: 3,
    });
    const after = await listRules({ orgId: ORG, entityId: ENT, subjectType: "PAYMENT" });
    expect(after.length).toBe(before.length);          // two identical rules would demand six signatures
    expect(again.approversRequired).toBe(3);

    // Put it back, then switch it off: it leaves the rules in force but stays on file.
    await setRule({ orgId: ORG, entityId: ENT, subjectType: "PAYMENT", thresholdMinor: 100_000, approverRole: "DIRECTOR", approversRequired: 2 });
    const off = await deactivateRule({ orgId: ORG, ruleId: again.id });
    expect(off.active).toBe(false);
    expect((await rulesFor({ orgId: ORG, entityId: ENT, subjectType: "PAYMENT", amountMinor: 500_000 })).length).toBe(1);
    expect((await listRules({ orgId: ORG, entityId: ENT, subjectType: "PAYMENT", includeInactive: true })).length).toBe(2);
    await expect(deactivateRule({ orgId: ORG, ruleId: "no-such-rule" })).rejects.toThrow(/does not exist/i);

    // Writing it again is how it comes back — the same row, not a second one.
    const back = await setRule({ orgId: ORG, entityId: ENT, subjectType: "PAYMENT", thresholdMinor: 100_000, approverRole: "DIRECTOR", approversRequired: 2 });
    expect(back.id).toBe(again.id);
    expect(back.active).toBe(true);
  });

  /* ------------------------------------------ a threshold has a currency too */

  it("tests a foreign amount against the threshold in the book's own currency", async () => {
    // A book that reports in dirhams, and a euro rate on file. Without the
    // book there is nothing to convert INTO, so this is the first test here
    // that needs one.
    await db.book.create({
      data: { orgId: ORG, entityId: ENT, code: "PRIMARY", name: "Primary", isDefault: true, functionalCurrency: "AED" },
    });
    await db.fxRate.create({
      data: { orgId: ORG, entityId: ENT, currency: "EUR", rate: "3.9500000000", rateDate: new Date("2026-01-01") },
    });

    // EUR 200.00 is AED 790.00. The payment rules here are AED 0 (a manager)
    // and AED 1,000.00 (two directors), so this is under the second either way
    // and the conversion cannot change the answer — which is the case that has
    // to stay cheap.
    const small = await approvalState({
      orgId: ORG, entityId: ENT, subjectType: "PAYMENT", subjectId: "PAY-EUR-SMALL",
      amountMinor: 20_000, currency: "EUR",
    });
    expect(small.matchedOnMinor).toBe(79_000n);
    expect(small.thresholdCurrency).toBe("AED");
    expect(small.rules.map((r) => r.thresholdMinor)).toEqual([0n]);

    // EUR 400.00 is AED 1,580.00, which IS over the AED 1,000.00 director
    // rule — and 40,000 read as dirhams would have sailed under it. This is the
    // whole defect: a foreign document four times the size of the limit passing
    // a rule written to stop it, because 40,000 fils were compared with
    // 100,000 fils and nobody asked which currency either was in.
    const big = await approvalState({
      orgId: ORG, entityId: ENT, subjectType: "PAYMENT", subjectId: "PAY-EUR-BIG",
      amountMinor: 40_000, currency: "EUR",
    });
    expect(big.matchedOnMinor).toBe(158_000n);
    expect(big.rules.map((r) => r.thresholdMinor)).toEqual([100_000n, 0n]);
    expect(big.approved).toBe(false);
    // The threshold is quoted in the currency it is written in, not the
    // document's — "payments of AED 1,000.00 and above", never "EUR 1,000.00".
    expect(big.blockers.join(" ")).toMatch(/AED 1,000\.00 and above/);
    // And the document is still quoted at its face value, which is what the
    // approver will be looking at.
    expect(big.blockers.join(" ")).toMatch(/EUR 400\.00/);
  });

  it("keeps the approver's own figure for the staleness check, not the converted one", async () => {
    // The approver signed EUR 400.00 and the decision records 40,000 — the face
    // amount. If the guard compared that against the converted 158,000 every
    // signature on every foreign document would read as stale and nothing would
    // ever post.
    await decide({
      orgId: ORG, entityId: ENT, subjectType: "PAYMENT", subjectId: "PAY-EUR-BIG",
      amountMinor: 40_000, currency: "EUR", decision: "APPROVED", decidedBy: "u-d1",
    });
    const after = await approvalState({
      orgId: ORG, entityId: ENT, subjectType: "PAYMENT", subjectId: "PAY-EUR-BIG",
      amountMinor: 40_000, currency: "EUR",
    });
    expect(after.blockers.join(" ")).not.toMatch(/approval covers the amount it was shown/);
    expect(after.approvers).toEqual(["u-d1"]);
  });

  it("refuses to guess when a foreign amount has no rate, but only where it could matter", async () => {
    // GBP 400.00, no GBP rate anywhere. Reading 40,000 as dirhams would put it
    // under the 100,000 director rule; the truth is that nobody here knows
    // which side of the line it falls, and quietly picking the lenient side is
    // the failure this is about.
    const unknown = await approvalState({
      orgId: ORG, entityId: ENT, subjectType: "PAYMENT", subjectId: "PAY-GBP",
      amountMinor: 40_000, currency: "GBP",
    });
    expect(unknown.approved).toBe(false);
    expect(unknown.blockers.join(" ")).toMatch(/no GBP rate is on file/);

    // But a payroll run of GBP 20,000.00 is already past the only payroll rule
    // there is, at AED 10,000.00, on its face value. A rate can only move it
    // further past — and if it moved it BELOW, keeping the rule is the strict
    // answer rather than the lenient one, which is nobody's problem. So nothing
    // is asked for here: a control that interrupts people for a number which
    // cannot make it more permissive is a control they learn to work around.
    const immaterial = await approvalState({
      orgId: ORG, entityId: ENT, subjectType: "PAYROLL", subjectId: "PAYROLL-GBP",
      amountMinor: 2_000_000, currency: "GBP",
    });
    expect(immaterial.blockers.join(" ")).not.toMatch(/rate is on file/);
    // The rule still applies and is still unmet — strictness is not the thing
    // being relaxed.
    expect(immaterial.approved).toBe(false);
    expect(immaterial.rules.map((r) => r.thresholdMinor)).toEqual([1_000_000n]);
  });

  /* ------------------------------------ a rule naming a role names a role */

  describe("rules that name a role", () => {
    // Its own organisation, because the escape hatch turns on whether the
    // WORKSPACE has configured any roles at all: everything above runs in one
    // with none, and this needs one with some.
    const RORG = "t-org-apr-roles";
    const RS = { orgId: RORG, entityId: ENT };

    beforeAll(async () => {
      await db.$transaction([
        db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
        db.$executeRawUnsafe(`DELETE FROM "ApprovalDecision" WHERE "orgId" = '${RORG}'`),
        db.$executeRawUnsafe(`DELETE FROM "ApprovalRule" WHERE "orgId" = '${RORG}'`),
        db.$executeRawUnsafe(`DELETE FROM "RoleAssignment" WHERE "orgId" = '${RORG}'`),
        db.$executeRawUnsafe(`DELETE FROM "AccountingRole" WHERE "orgId" = '${RORG}'`),
      ]);
      await seedBuiltInRoles({ orgId: RORG });
      const director = await db.accountingRole.findFirstOrThrow({ where: { orgId: RORG, code: "APPROVER" } });
      const bookkeeper = await db.accountingRole.findFirstOrThrow({ where: { orgId: RORG, code: "BOOKKEEPER" } });
      await db.roleAssignment.createMany({
        data: [
          { orgId: RORG, userId: "u-appr-1", roleId: director.id, entityId: "*" },
          { orgId: RORG, userId: "u-appr-2", roleId: director.id, entityId: "*" },
          { orgId: RORG, userId: "u-book", roleId: bookkeeper.id, entityId: "*" },
        ],
      });
      await setRule({
        ...RS, subjectType: "PAYMENT", thresholdMinor: 0,
        approverRole: "APPROVER", approversRequired: 2,
      });
    });

    afterAll(async () => {
      await db.$transaction([
        db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
        db.$executeRawUnsafe(`DELETE FROM "ApprovalDecision" WHERE "orgId" = '${RORG}'`),
        db.$executeRawUnsafe(`DELETE FROM "ApprovalRule" WHERE "orgId" = '${RORG}'`),
        db.$executeRawUnsafe(`DELETE FROM "RoleAssignment" WHERE "orgId" = '${RORG}'`),
        db.$executeRawUnsafe(`DELETE FROM "AccountingRole" WHERE "orgId" = '${RORG}'`),
      ]);
    });

    it("is not answered by two people who do not hold it", async () => {
      // The defect this replaces: the rule counted signatures and never asked
      // what the signatories were, so "two approvers" was satisfied by any two
      // people who could reach the endpoint. A rule naming a PERSON was
      // enforced and a rule naming a ROLE was a tally — and naming a role is
      // the half a business actually writes, because naming individuals means
      // rewriting the rules whenever somebody leaves.
      await decide({
        ...RS, subjectType: "PAYMENT", subjectId: "PAY-ROLE", amountMinor: 500_000,
        decision: "APPROVED", decidedBy: "u-book",
      });
      await decide({
        ...RS, subjectType: "PAYMENT", subjectId: "PAY-ROLE", amountMinor: 500_000,
        decision: "APPROVED", decidedBy: "u-nobody",
      });

      const state = await approvalState({
        ...RS, subjectType: "PAYMENT", subjectId: "PAY-ROLE", amountMinor: 500_000,
      });
      expect(state.approved).toBe(false);
      expect(state.approvalsOutstanding).toBe(2);
      // And it names who signed and does not answer, so somebody chases the
      // right person rather than merely somebody.
      expect(state.blockers.join(" ")).toMatch(/u-book/);
      expect(state.blockers.join(" ")).toMatch(/do not answer this rule/);
    });

    it("is answered by two people who do hold it", async () => {
      for (const who of ["u-appr-1", "u-appr-2"]) {
        await decide({
          ...RS, subjectType: "PAYMENT", subjectId: "PAY-ROLE-OK", amountMinor: 500_000,
          decision: "APPROVED", decidedBy: who,
        });
      }
      const state = await approvalState({
        ...RS, subjectType: "PAYMENT", subjectId: "PAY-ROLE-OK", amountMinor: 500_000,
      });
      expect(state.approved).toBe(true);
      expect(state.caveats).toEqual([]);
    });

    it("keeps the role the approver held, not the role they hold now", async () => {
      await decide({
        ...RS, subjectType: "PAYMENT", subjectId: "PAY-ROLE-MOVED", amountMinor: 500_000,
        decision: "APPROVED", decidedBy: "u-appr-1",
      });
      await decide({
        ...RS, subjectType: "PAYMENT", subjectId: "PAY-ROLE-MOVED", amountMinor: 500_000,
        decision: "APPROVED", decidedBy: "u-appr-2",
      });
      expect((await approvalState({
        ...RS, subjectType: "PAYMENT", subjectId: "PAY-ROLE-MOVED", amountMinor: 500_000,
      })).approved).toBe(true);

      // u-appr-2 changes job. The document they signed as an approver stays
      // signed: an approval is a statement about a moment, and re-reading the
      // assignments would silently un-approve documents that have posted.
      await db.roleAssignment.deleteMany({ where: { orgId: RORG, userId: "u-appr-2" } });
      const after = await approvalState({
        ...RS, subjectType: "PAYMENT", subjectId: "PAY-ROLE-MOVED", amountMinor: 500_000,
      });
      expect(after.approved).toBe(true);
    });

    it("waives the check for a signature taken before roles were recorded, and says so", async () => {
      // A decision written straight to the table, as every decision on file
      // before this column existed was.
      await db.approvalDecision.create({
        data: {
          orgId: RORG, entityId: ENT, subjectType: "PAYMENT", subjectId: "PAY-ROLE-OLD",
          decision: "APPROVED", decidedBy: "u-legacy-1", amountMinor: 500_000n, decidedByRoles: null,
        },
      });
      await db.approvalDecision.create({
        data: {
          orgId: RORG, entityId: ENT, subjectType: "PAYMENT", subjectId: "PAY-ROLE-OLD",
          decision: "APPROVED", decidedBy: "u-legacy-2", amountMinor: 500_000n, decidedByRoles: null,
        },
      });

      const state = await approvalState({
        ...RS, subjectType: "PAYMENT", subjectId: "PAY-ROLE-OLD", amountMinor: 500_000,
      });
      // They count — failing them would block every part-approved document in
      // flight the day this shipped, and a control that breaks on installation
      // is a control that gets taken out again.
      expect(state.approved).toBe(true);
      // And the waiver is reported as a caveat, never as a blocker: nothing is
      // outstanding on this document, and something about it is still worth
      // knowing.
      expect(state.blockers).toEqual([]);
      expect(state.caveats.join(" ")).toMatch(/waived/);
      expect(state.caveats.join(" ")).toMatch(/Collecting the approval again would prove it/);
    });
  });

  it("records who decided, when, and against what amount — and never edits it", async () => {
    const r = await decide({ ...pay("PAY-RECORD"), decision: "APPROVED", decidedBy: "u-m1" });
    const row = await db.approvalDecision.findUniqueOrThrow({ where: { id: r.decision.id } });
    expect(row.decidedBy).toBe("u-m1");
    expect(row.amountMinor).toBe(500_000n);
    expect(row.reason).toBeNull();
    expect(row.decidedAt).toBeInstanceOf(Date);

    // A change of mind is not an edit. The same person cannot overwrite their
    // decision with the opposite one — the way back is a withdrawal, exactly as
    // a posted journal entry is corrected by a reversal and never by an update.
    await expect(decide({ ...pay("PAY-RECORD"), decision: "REJECTED", decidedBy: "u-m1", reason: "Changed my mind." }))
      .rejects.toThrow(/already approved/i);
    const after = await db.approvalDecision.findUniqueOrThrow({ where: { id: r.decision.id } });
    expect(after.decision).toBe("APPROVED");
    expect(after.decidedAt.getTime()).toBe(row.decidedAt.getTime());
  });
});
