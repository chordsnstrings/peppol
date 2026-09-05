import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { postBill, postSupplierPayment, payablesAgeing } from "@/lib/server/ledger/ap";
import { setRule, decide } from "@/lib/server/ledger/approvals";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { trialBalance } from "@/lib/server/ledger/reports";
import { LedgerError } from "@/lib/server/ledger/post";
import type { Invoice, InvoiceLine, TaxProfileCode } from "@/lib/domain/types";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-ap";
const ENT = "t-ent-ap";

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "ApprovalDecision" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "ApprovalRule" WHERE "orgId" = '${ORG}'`),
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

let seq = 0;
function line(net: number, vat: number, profile: TaxProfileCode = "STANDARD_5"): InvoiceLine {
  return {
    id: `l${++seq}`, lineNo: seq, description: "Supply", qty: 1, unitCode: "C62",
    unitPriceMinor: net, taxProfileCode: profile, lineNetMinor: net, lineVatMinor: vat,
  };
}

function bill(over: Partial<Invoice> = {}, lines: InvoiceLine[] = [line(100_000, 5_000)]): Invoice {
  const net = lines.reduce((a, l) => a + l.lineNetMinor, 0);
  const vat = lines.reduce((a, l) => a + l.lineVatMinor, 0);
  return {
    id: `bill-${++seq}`, orgId: ORG, entityId: ENT, direction: "INBOUND", docType: "TAX_INVOICE",
    number: `BILL-${seq}`, issueDate: "2026-04-08", supplyDate: "2026-04-08", currency: "AED",
    buyer: { nameEn: "Our Company" }, seller: { nameEn: "Gulf Supplies LLC" },
    lines,
    totals: { taxExclusiveMinor: net, vatMinor: vat, taxInclusiveMinor: net + vat, payableMinor: net + vat, perCategory: [] },
    lifecycleStatus: "SENT", exchangeStatus: "NOT_SENT", reportingStatusC2: "NOT_REPORTED",
    source: "INGEST",
    compliance: { taxableEventDate: "2026-04-08", daysRemaining: 14, breached: false },
    createdAt: "2026-04-08T00:00:00Z", updatedAt: "2026-04-08T00:00:00Z",
    ...over,
  } as Invoice;
}

async function linesOf(entryId: string) {
  const rows = await db.journalLine.findMany({ where: { entryId }, include: { account: true }, orderBy: { lineNo: "asc" } });
  const out: Record<string, bigint> = {};
  for (const r of rows) out[r.account.code] = (out[r.account.code] ?? 0n) + r.txnAmountMinor;
  return out;
}

d("payables subledger", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("turns a supplier bill into expense, recoverable VAT and a payable", async () => {
    const r = await postBill({ orgId: ORG, bill: bill() });
    expect(await linesOf(r.entryId)).toEqual({
      "6900": 100_000n,   // Dr expense — net
      "1350": 5_000n,     // Dr recoverable input VAT
      "2000": -105_000n,  // Cr payable — gross
    });
  });

  it("routes a line to the account a caller codes it to", async () => {
    const r = await postBill({
      orgId: ORG,
      bill: bill({ number: "BILL-RENT" }, [line(80_000, 4_000)]),
      accountFor: () => "6100", // rent
    });
    const l = await linesOf(r.entryId);
    expect(l["6100"]).toBe(80_000n);
    expect(l["6900"]).toBeUndefined();
  });

  it("routes stock to inventory rather than to expense", async () => {
    const r = await postBill({
      orgId: ORG,
      bill: bill({ number: "BILL-STOCK" }, [line(60_000, 3_000)]),
      accountFor: () => "1200", // inventory is a control account…
    });
    const l = await linesOf(r.entryId);
    // …and the subledger is allowed through it, exactly as with 1100 and 2000.
    expect(l["1200"]).toBe(60_000n);
  });

  it("self-accounts for reverse charge on both sides", async () => {
    // An imported service: the supplier charges nothing, and the buyer books
    // both the output tax it owes and the input tax it reclaims. Getting this
    // wrong understates output VAT even though no cash moves.
    const r = await postBill({
      orgId: ORG,
      bill: bill({ number: "BILL-RC" }, [line(200_000, 0, "REVERSE_CHARGE")]),
    });
    const l = await linesOf(r.entryId);
    expect(l["6250"]).toBe(200_000n);    // Dr the imported service
    expect(l["2000"]).toBe(-200_000n);   // Cr the supplier — no VAT on their bill
    expect(l["2100"]).toBe(-10_000n);    // Cr output VAT — self-accounted, 5%
    expect(l["1350"]).toBe(10_000n);     // Dr input VAT — reclaimed
    expect(r.reverseChargeMinor).toBe("10000");
  });

  it("does not invent reverse charge on an ordinary bill", async () => {
    const r = await postBill({ orgId: ORG, bill: bill({ number: "BILL-PLAIN" }) });
    expect(r.reverseChargeMinor).toBe("0");
    expect((await linesOf(r.entryId))["2100"]).toBeUndefined();
  });

  it("handles a bill that mixes reverse charge with ordinary VAT", async () => {
    const r = await postBill({
      orgId: ORG,
      bill: bill({ number: "BILL-MIX" }, [line(100_000, 5_000), line(40_000, 0, "REVERSE_CHARGE")]),
    });
    const l = await linesOf(r.entryId);
    expect(l["2000"]).toBe(-145_000n);          // owed: 100,000 + 5,000 VAT + 40,000
    expect(l["2100"]).toBe(-2_000n);            // self-accounted on the 40,000 only
    expect(l["1350"]).toBe(5_000n + 2_000n);    // supplier's VAT plus the reclaim
  });

  it("posts the same bill twice without paying for it twice", async () => {
    const b = bill({ number: "BILL-DUP" });
    const first = await postBill({ orgId: ORG, bill: b });
    const second = await postBill({ orgId: ORG, bill: b });
    expect(second.alreadyPosted).toBe(true);
    expect(second.entryId).toBe(first.entryId);
  });

  it("flips every side for a supplier credit note", async () => {
    const r = await postBill({ orgId: ORG, bill: bill({ docType: "TAX_CREDIT_NOTE", number: "SCN-1" }) });
    expect(await linesOf(r.entryId)).toEqual({
      "6900": -100_000n,
      "1350": -5_000n,
      "2000": 105_000n,
    });
  });

  it("refuses a sales invoice through the payables subledger", async () => {
    await expect(postBill({ orgId: ORG, bill: bill({ direction: "OUTBOUND" }) })).rejects.toThrow(LedgerError);
  });

  it("refuses a bill whose lines do not add up", async () => {
    const b = bill({ number: "BILL-BAD" });
    b.totals.payableMinor = 999_999;
    await expect(postBill({ orgId: ORG, bill: b })).rejects.toThrow(/does not add up/i);
  });

  it("settles a supplier payment against the payable", async () => {
    const b = bill({ number: "BILL-PAY" });
    await postBill({ orgId: ORG, bill: b });
    const r = await postSupplierPayment({
      orgId: ORG, entityId: ENT, billId: b.id, billNumber: b.number,
      paymentId: "sp-1", paidOn: "2026-04-20", bankAmountMinor: 105_000,
    });
    expect(await linesOf(r.entryId)).toEqual({ "2000": 105_000n, "1010": -105_000n });
  });

  it("books the exchange difference when less leaves the bank than was owed", async () => {
    const b = bill({ number: "BILL-FX" });
    await postBill({ orgId: ORG, bill: b });
    const r = await postSupplierPayment({
      orgId: ORG, entityId: ENT, billId: b.id, billNumber: b.number,
      paymentId: "sp-fx", paidOn: "2026-04-21",
      bankAmountMinor: 104_800, clearedAmountMinor: 105_000,
    });
    const l = await linesOf(r.entryId);
    expect(l["4950"]).toBe(-200n); // paying less than owed is a gain
  });

  it("ages payables and drops what has been paid", async () => {
    const ageing = await payablesAgeing({ orgId: ORG, entityId: ENT, asOf: new Date("2026-04-30") });
    // Owed amounts are reported positive even though the ledger holds them
    // on the credit side.
    expect(BigInt(ageing.totalMinor)).toBeGreaterThan(0n);
    expect(ageing.open.some((o) => BigInt(o.outstandingMinor) > 0n)).toBe(true);
    // A bill that has been paid nets to zero and leaves the report.
    expect(ageing.open.find((o) => o.memo.includes("BILL-PAY"))).toBeUndefined();
    // An unapplied supplier credit note is a genuine debit on payables — the
    // supplier owes us. It belongs in the report as a negative, not hidden:
    // netting it away silently is how a credit goes unclaimed.
    const credit = ageing.open.find((o) => o.memo.includes("SCN-1"));
    expect(credit).toBeDefined();
    expect(BigInt(credit!.outstandingMinor)).toBe(-105_000n);
    const detail = ageing.open.reduce((a, o) => a + BigInt(o.outstandingMinor), 0n);
    expect(detail.toString()).toBe(ageing.totalMinor);
  });

  /*
   * The approval rules, as they bind on this subledger.
   *
   * Both thresholds sit far above every fixture above, so the rules written
   * here catch only the documents these tests raise — the rest of the file goes
   * on posting exactly as it did, which is itself the proof that a guard called
   * on every bill costs nothing where no rule covers the amount.
   */
  it("refuses a bill over the approval threshold and posts it once it is signed", async () => {
    // Bills over AED 50,000 need two directors.
    await setRule({
      orgId: ORG, entityId: ENT, subjectType: "BILL",
      thresholdMinor: 5_000_000, approverRole: "DIRECTOR", approversRequired: 2,
    });

    const b = bill({ number: "BILL-APPROVAL" }, [line(6_000_000, 300_000)]);
    const subject = {
      orgId: ORG, entityId: ENT, subjectType: "BILL" as const, subjectId: b.id,
      // The gross payable — what the supplier is owed, which is the figure the
      // rule is written against and the figure the guard tests.
      amountMinor: 6_300_000,
    };

    await expect(postBill({ orgId: ORG, bill: b })).rejects.toThrow(LedgerError);
    await expect(postBill({ orgId: ORG, bill: b })).rejects.toThrow(/Supplier bill BILL-APPROVAL has not been approved/i);
    await expect(postBill({ orgId: ORG, bill: b })).rejects.toThrow(/two more approvals from a director/i);
    // Refused before anything was written: no entry, not even a half-made one.
    expect(await db.journalEntry.count({ where: { orgId: ORG, externalKey: `bill:${b.id}` } })).toBe(0);

    // One signature is not two. The rule asks for both, and the guard says so
    // rather than letting the bill through on the first director's tick.
    await decide({ ...subject, decision: "APPROVED", decidedBy: "u-dir-1" });
    await expect(postBill({ orgId: ORG, bill: b })).rejects.toThrow(/one more approval from a director/i);
    expect(await db.journalEntry.count({ where: { orgId: ORG, externalKey: `bill:${b.id}` } })).toBe(0);

    await decide({ ...subject, decision: "APPROVED", decidedBy: "u-dir-2" });
    const posted = await postBill({ orgId: ORG, bill: b });
    expect(posted.alreadyPosted).toBe(false);
    expect(await linesOf(posted.entryId)).toEqual({
      "6900": 6_000_000n,
      "1350": 300_000n,
      "2000": -6_300_000n,
    });
  });

  it("lets a bill under every threshold through with nobody's signature on it", async () => {
    // The BILL rule from the test above is still in force. A 1,050.00 bill
    // meets none of it, so the guard returns quietly and the posting is exactly
    // what it was before any of this existed — which is what makes it safe to
    // call the guard on every bill rather than only on the large ones.
    const r = await postBill({ orgId: ORG, bill: bill({ number: "BILL-SMALL" }) });
    expect(r.alreadyPosted).toBe(false);
    expect((await linesOf(r.entryId))["2000"]).toBe(-105_000n);
  });

  it("does not count an approval given at some other figure", async () => {
    // The failure an approval workflow exists to catch: a bill signed at one
    // amount and posted at another. The signature on file is for a document
    // that no longer exists, so it counts for nothing.
    const b = bill({ number: "BILL-REKEYED" }, [line(6_000_000, 300_000)]);
    // Signed while the bill said 52,500.00, then re-keyed to 63,000.00 before
    // anybody posted it.
    await decide({
      orgId: ORG, entityId: ENT, subjectType: "BILL", subjectId: b.id,
      decision: "APPROVED", decidedBy: "u-dir-1", amountMinor: 5_250_000,
    });
    await expect(postBill({ orgId: ORG, bill: b })).rejects.toThrow(/An approval on file was given when this supplier bill was/i);
    await expect(postBill({ orgId: ORG, bill: b })).rejects.toThrow(/two more approvals from a director/i);
    expect(await db.journalEntry.count({ where: { orgId: ORG, externalKey: `bill:${b.id}` } })).toBe(0);
  });

  it("refuses a supplier payment over the approval threshold until it is signed", async () => {
    // Payments over AED 10,000 need a director. The bill being settled is well
    // under the bill threshold, so nothing but the payment is under control here.
    await setRule({
      orgId: ORG, entityId: ENT, subjectType: "PAYMENT",
      thresholdMinor: 1_000_000, approverRole: "DIRECTOR", approversRequired: 1,
    });

    const b = bill({ number: "BILL-BIGPAY" }, [line(2_000_000, 100_000)]);
    await postBill({ orgId: ORG, bill: b });

    const pay = {
      orgId: ORG, entityId: ENT, billId: b.id, billNumber: b.number,
      paymentId: "sp-approval", paidOn: "2026-04-22", bankAmountMinor: 2_100_000,
    };
    await expect(postSupplierPayment(pay)).rejects.toThrow(/Payment BILL-BIGPAY has not been approved/i);
    await expect(postSupplierPayment(pay)).rejects.toThrow(/one more approval from a director/i);
    expect(await db.journalEntry.count({ where: { orgId: ORG, externalKey: "supplier-payment:sp-approval" } })).toBe(0);

    await decide({
      orgId: ORG, entityId: ENT, subjectType: "PAYMENT", subjectId: "sp-approval",
      decision: "APPROVED", decidedBy: "u-dir-1", amountMinor: 2_100_000,
    });
    const posted = await postSupplierPayment(pay);
    expect(await linesOf(posted.entryId)).toEqual({ "2000": 2_100_000n, "1010": -2_100_000n });

    // A retry is not a second payment. It returns the original entry without
    // being sent back through the rules — refusing it would tell the caller the
    // money never moved when it has.
    await db.approvalDecision.deleteMany({ where: { orgId: ORG, subjectType: "PAYMENT", subjectId: "sp-approval" } });
    const again = await postSupplierPayment(pay);
    expect(again.alreadyPosted).toBe(true);
    expect(again.entryId).toBe(posted.entryId);
  });

  it("keeps the trial balance tied after everything above", async () => {
    const tb = await trialBalance({ orgId: ORG, entityId: ENT, periodLabel: "2026-04" });
    expect(tb.balanced).toBe(true);
    expect(tb.differenceMinor).toBe(0n);
  });
});

/*
 * The maturity ladder, on its own ledger.
 *
 * A separate entity because the bills above were raised to test posting and
 * carry no terms at all, and the whole question here is what the terms say. It
 * is the same organisation, so `wipe()` clears it with the rest.
 */
d("payables maturity", () => {
  const MAT = "t-ent-ap-mat";
  const AS_OF = new Date("2026-06-30");

  /** A bill for a round gross, on the terms given — or on none, deliberately. */
  const owe = (number: string, issueDate: string, dueDate: string | undefined, netMinor: number) =>
    postBill({
      orgId: ORG,
      bill: bill(
        { id: `mat-${number}`, entityId: MAT, number, issueDate, supplyDate: issueDate, dueDate },
        [line(netMinor, 0, "ZERO_OTHER")],
      ),
    });

  const bandsOf = (rows: { key: string; label: string; amountMinor: string }[]) =>
    Object.fromEntries(rows.map((b) => [b.key, b.amountMinor]));

  beforeAll(async () => {
    await openFiscalYear({ orgId: ORG, entityId: MAT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: MAT });

    // The case the old report got backwards: raised sixty days ago on ninety
    // day terms. It is in the third ageing band and it is not overdue — the
    // money is not needed for another month.
    await owe("BILL-M1", "2026-05-01", "2026-07-30", 100_000);
    // Genuinely late: raised in January on thirty day terms.
    await owe("BILL-M2", "2026-01-05", "2026-02-04", 200_000);
    // Raised five days ago, but not payable until October. The ageing calls it
    // current; the maturity ladder puts it furthest out, which is the truth.
    await owe("BILL-M3", "2026-06-25", "2026-10-23", 50_000);
    await owe("BILL-M4", "2026-06-10", "2026-08-15", 10_000);
    await owe("BILL-M5", "2026-06-15", "2026-09-20", 20_000);
    // No terms keyed at all.
    await owe("BILL-M6", "2026-06-01", undefined, 30_000);
  });

  it("ages on the day the bill was raised, which is a credit control report", async () => {
    const ageing = await payablesAgeing({ orgId: ORG, entityId: MAT, asOf: AS_OF });
    expect(ageing.buckets).toEqual({
      // M3 five days, M4 twenty, M5 fifteen, M6 twenty-nine.
      current: "110000",
      // M1, sixty days old.
      d31_60: "100000",
      d61_90: "0",
      d91_120: "0",
      // M2, a hundred and seventy-six days old.
      over120: "200000",
    });
    expect(ageing.totalMinor).toBe("410000");
    // Only M2 is actually late, and it is the only one the ageing's own
    // overdue figure counts — the bands beside it are ages, not lateness.
    expect(ageing.overdueMinor).toBe("200000");
  });

  it("cuts the maturity table on the due date, which is a liquidity report", async () => {
    const { maturity } = await payablesAgeing({ orgId: ORG, entityId: MAT, asOf: AS_OF });
    expect(bandsOf(maturity.bands)).toEqual({
      past_due: "200000",  // M2, due in February
      within_30: "100000", // M1, due in thirty days — sixty days old and not overdue
      d31_60: "10000",     // M4, due 15 August
      d61_90: "20000",     // M5, due 20 September
      over_90: "50000",    // M3, five days old and not payable until October
      undated: "30000",    // M6, no terms recorded
    });
    // The same money as the ageing, laid out by a different question.
    expect(maturity.totalMinor).toBe("410000");
    expect(maturity.pastDueMinor).toBe("200000");
    expect(maturity.asOf).toBe("2026-06-30");
  });

  it("keeps a bill with no terms out of the earliest band rather than assuming it is due now", async () => {
    const { maturity, open } = await payablesAgeing({ orgId: ORG, entityId: MAT, asOf: AS_OF });
    expect(maturity.undatedItems).toBe(1);
    expect(maturity.undatedMinor).toBe("30000");
    // IFRS 7.B11C would put an amount repayable on demand in the earliest
    // band. A bill with no terms keyed is not evidence that it is repayable on
    // demand, so it is shown apart rather than folded into the money that has
    // to be found this month.
    const undated = open.find((o) => o.memo.includes("BILL-M6"))!;
    expect(undated.dueDate).toBeNull();
    expect(undated.daysToMaturity).toBeNull();
    expect(undated.daysOverdue).toBe(0);
  });

  it("carries the days to maturity on each open item, signed, beside the days it is old", async () => {
    const { open } = await payablesAgeing({ orgId: ORG, entityId: MAT, asOf: AS_OF });
    const m1 = open.find((o) => o.memo.includes("BILL-M1"))!;
    expect(m1.daysOld).toBe(60);
    expect(m1.daysToMaturity).toBe(30);
    expect(m1.daysOverdue).toBe(0);

    const m2 = open.find((o) => o.memo.includes("BILL-M2"))!;
    expect(m2.daysOld).toBe(176);
    // Negative: it fell due a hundred and forty-six days ago.
    expect(m2.daysToMaturity).toBe(-146);
    expect(m2.daysOverdue).toBe(146);
  });
});
