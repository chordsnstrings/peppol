import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { postBill, postSupplierPayment, payablesAgeing } from "@/lib/server/ledger/ap";
import {
  proposeRun, excludeItem, includeItem, approveRun, releaseRun, cancelRun,
  bankFile, runList, runDetail,
} from "@/lib/server/ledger/payment-runs";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { trialBalance } from "@/lib/server/ledger/reports";
import { LedgerError } from "@/lib/server/ledger/post";
import type { Invoice, InvoiceLine, TaxProfileCode } from "@/lib/domain/types";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-run";
const ENT = "t-ent-run";

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "JournalLineDimension" WHERE "lineId" IN (SELECT id FROM "JournalLine" WHERE "orgId" = '${ORG}')`),
    db.$executeRawUnsafe(`DELETE FROM "JournalLine" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "JournalEntry" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "AccountBalance" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Account" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "AccountingPeriod" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "FiscalYear" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Book" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "DocumentSequence" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "PaymentRunItem" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "PaymentRun" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Record" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Counterparty" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "ApprovalDecision" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "ApprovalRule" WHERE "orgId" = '${ORG}'`),
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

/**
 * A bill as the business really has it: posted to the ledger AND kept as a
 * document, because the run reads the due date and the supplier from the
 * document and the amount from the ledger.
 */
async function receive(b: Invoice) {
  await postBill({ orgId: ORG, bill: b });
  await db.record.create({
    data: { store: "invoices", id: b.id, orgId: ORG, entityId: ENT, invoiceId: b.id, data: JSON.stringify(b) },
  });
  return b;
}

/** One approval on file for a bill, at the amount it was shown. */
async function approveBill(b: Invoice, who: string) {
  await db.approvalDecision.create({
    data: {
      orgId: ORG, entityId: ENT, subjectType: "BILL", subjectId: b.id,
      decision: "APPROVED", decidedBy: who, amountMinor: BigInt(b.totals.payableMinor),
    },
  });
}

/** Everything a run posted, netted by account code. */
async function linesOfRun(runId: string) {
  const rows = await db.journalLine.findMany({
    where: { entry: { orgId: ORG, sourceType: "PAYMENT_RUN", sourceId: runId } },
    include: { account: true },
  });
  const out: Record<string, bigint> = {};
  for (const r of rows) out[r.account.code] = (out[r.account.code] ?? 0n) + r.txnAmountMinor;
  return out;
}

type Ageing = Awaited<ReturnType<typeof payablesAgeing>>;
const openOf = (ageing: Ageing, number: string) => ageing.open.find((o) => o.memo.includes(number));

/* ------------------------------------------------------------------- fixtures */

let A1: Invoice;   // oldest, approved, due — pays
let A2: Invoice;   // supplier on hold
let A3: Invoice;   // nobody has approved it
let A4: Invoice;   // not due until the end of May
let A5: Invoice;   // approved, due — pays
let CN: Invoice;   // a supplier credit, not a bill
let CTRL: Invoice; // the control: settled one at a time, the old way

let run1 = "";
let run2 = "";
let run3 = "";
let run4 = "";
let item5 = "";

d("supplier payment runs", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });

    A1 = await receive(bill({ number: "BILL-A1", issueDate: "2026-03-05", dueDate: "2026-04-05" }, [line(100_000, 5_000)]));
    A2 = await receive(bill({
      number: "BILL-A2", issueDate: "2026-03-20", dueDate: "2026-04-19",
      seller: { nameEn: "Al Marri Trading" },
    }, [line(60_000, 3_000)]));
    A3 = await receive(bill({
      number: "BILL-A3", issueDate: "2026-04-01", dueDate: "2026-04-21",
      seller: { nameEn: "Desert Rock FZE" },
    }, [line(40_000, 2_000)]));
    A4 = await receive(bill({ number: "BILL-A4", issueDate: "2026-04-10", dueDate: "2026-05-30" }, [line(20_000, 1_000)]));
    A5 = await receive(bill({
      number: "BILL-A5", issueDate: "2026-04-03", dueDate: "2026-04-20",
      seller: { nameEn: "Palm Tools LLC" },
    }, [line(30_000, 1_500)]));
    CN = await receive(bill({
      number: "SCN-A1", docType: "TAX_CREDIT_NOTE", issueDate: "2026-04-02", dueDate: "2026-04-02",
    }, [line(10_000, 500)]));
    CTRL = await receive(bill({
      number: "BILL-CTRL", issueDate: "2026-04-04", dueDate: "2026-04-20",
      seller: { nameEn: "Palm Tools LLC" },
    }, [line(12_000, 600)]));

    // Al Marri is on hold; the others are ordinary suppliers on 30 days.
    await db.counterparty.createMany({
      data: [
        { orgId: ORG, entityId: ENT, code: "SUP-1", name: "Gulf Supplies LLC", kind: "SUPPLIER", paymentTerms: 30 },
        {
          orgId: ORG, entityId: ENT, code: "SUP-2", name: "Al Marri Trading", kind: "SUPPLIER", paymentTerms: 30,
          onHold: true, holdReason: "a quality dispute on the March deliveries",
        },
        { orgId: ORG, entityId: ENT, code: "SUP-3", name: "Palm Tools LLC", kind: "SUPPLIER", paymentTerms: 30 },
        { orgId: ORG, entityId: ENT, code: "SUP-4", name: "Desert Rock FZE", kind: "SUPPLIER", paymentTerms: 30 },
      ],
    });

    // Every bill needs one approval; A3 is the one nobody has signed.
    await db.approvalRule.create({
      data: { orgId: ORG, entityId: ENT, subjectType: "BILL", thresholdMinor: 0n, approversRequired: 1 },
    });
    for (const b of [A1, A2, A4, A5, CN, CTRL]) await approveBill(b, "farah");
  });

  afterAll(async () => { await wipe(); await db.$disconnect(); });

  /* ------------------------------------------------------------- the proposal */

  it("proposes every bill due by the date, worst first", async () => {
    const run = await proposeRun({ orgId: ORG, entityId: ENT, runDate: "2026-04-25", dueBy: "2026-04-25" });
    run1 = run.id;

    expect(run.status).toBe("draft");
    expect(run.reference).toBe("PR-2026-04-25");
    const paying = run.items.filter((i) => !i.excluded);
    // A1 (5 March), then A5 (3 April), then the control bill (4 April): a run
    // pays the worst first, which is the order the ageing already ranks them in.
    expect(paying.map((i) => i.billNumber)).toEqual(["BILL-A1", "BILL-A5", "BILL-CTRL"]);
    expect(BigInt(run.totalMinor)).toBe(105_000n + 31_500n + 12_600n);
    expect(paying.map((i) => i.supplierName)).toEqual(["Gulf Supplies LLC", "Palm Tools LLC", "Palm Tools LLC"]);
  });

  it("says what it left out and why, one reason each", async () => {
    const run = await runDetail({ orgId: ORG, runId: run1 });
    const left = run.items.filter((i) => i.excluded);
    expect(left).toHaveLength(3);
    // Nothing is dropped without a reason — the database CHECKs it, and so does
    // the person the supplier rings up.
    expect(left.every((i) => (i.excludeReason ?? "").length > 20)).toBe(true);

    const hold = left.find((i) => i.billNumber === "BILL-A2");
    expect(hold?.excludeReason).toContain("Al Marri Trading is on hold");
    expect(hold?.excludeReason).toContain("quality dispute");

    const unapproved = left.find((i) => i.billNumber === "BILL-A3");
    expect(unapproved?.excludeReason).toContain("nobody has approved it");

    const credit = left.find((i) => i.billNumber === "SCN-A1");
    expect(credit?.excludeReason).toContain("supplier credit");
    expect(credit?.excludeReason).toContain("nothing to pay");
    // A credit is recorded at its face value, positive, because the table
    // refuses a non-positive amount — the reason says which way round it is.
    expect(BigInt(credit?.amountMinor ?? "0")).toBe(10_500n);
    expect(BigInt(run.excludedMinor)).toBe(63_000n + 42_000n + 10_500n);
  });

  it("leaves a bill that is not due yet out of the run and says when it is due", async () => {
    const run = await proposeRun({
      orgId: ORG, entityId: ENT, runDate: "2026-04-26", dueBy: "2026-04-26", reference: "PR-DRY-RUN",
    });
    expect(run.items.some((i) => i.billNumber === "BILL-A4")).toBe(false);
    expect(run.notDue.map((n) => n.billNumber)).toEqual(["BILL-A4"]);
    expect(run.notDue[0].dueDate).toBe("2026-05-30");
    // A dry run is still a run: it holds the bills, so throw it away again.
    await cancelRun({ orgId: ORG, runId: run.id, reason: "a dry run, proposed to see what was due" });
  });

  /* ------------------------------------------------------- editing the batch */

  it("refuses to drop a payment without a reason", async () => {
    const run = await runDetail({ orgId: ORG, runId: run1 });
    const item = run.items.find((i) => i.billNumber === "BILL-A5")!;
    item5 = item.id;
    await expect(excludeItem({ orgId: ORG, runId: run1, itemId: item5, reason: "   " }))
      .rejects.toThrow(/Say why BILL-A5 is being left out/i);
  });

  it("drops a payment with a reason and takes it out of the total", async () => {
    const run = await excludeItem({
      orgId: ORG, runId: run1, itemId: item5,
      reason: "the goods went back on 20 April and a credit note is coming",
    });
    expect(BigInt(run.totalMinor)).toBe(105_000n + 12_600n);
    const item = run.items.find((i) => i.id === item5);
    expect(item?.excluded).toBe(true);
    expect(item?.excludeReason).toContain("credit note is coming");
  });

  it("puts a payment back, recording why it came back", async () => {
    const run = await includeItem({ orgId: ORG, runId: run1, itemId: item5, reason: "the credit note never arrived" });
    expect(BigInt(run.totalMinor)).toBe(105_000n + 12_600n + 31_500n);
    const item = run.items.find((i) => i.id === item5);
    expect(item?.excluded).toBe(false);
    expect(item?.excludeReason).toBe("Put back: the credit note never arrived");
  });

  /* ------------------------------------------------------------- the control */

  it("refuses to release a run nobody has approved, naming the state it is in", async () => {
    await expect(releaseRun({ orgId: ORG, runId: run1 })).rejects.toThrow(LedgerError);
    await expect(releaseRun({ orgId: ORG, runId: run1 }))
      .rejects.toThrow(/still a draft — nobody has approved it/i);
  });

  it("refuses to let the person who prepared the run approve it", async () => {
    await expect(approveRun({ orgId: ORG, runId: run1, approvedBy: "farah", submittedBy: "Farah" }))
      .rejects.toThrow(/cannot also approve it/i);
    await expect(approveRun({ orgId: ORG, runId: run1, approvedBy: "farah", submittedBy: " farah " }))
      .rejects.toThrow(/two different people/i);
    // Refused, not quietly ignored: the run is still a draft.
    expect((await runDetail({ orgId: ORG, runId: run1 })).status).toBe("draft");
  });

  it("believes the run about who prepared it, not the person approving it", async () => {
    // The whole point of recording the preparer: an approver cannot get past
    // the control by naming somebody else.
    await db.paymentRun.update({ where: { id: run1 }, data: { preparedBy: "farah" } });
    await expect(approveRun({ orgId: ORG, runId: run1, approvedBy: "Farah", submittedBy: "someone else" }))
      .rejects.toThrow(/cannot also approve it/i);
    expect((await runDetail({ orgId: ORG, runId: run1 })).preparedBy).toBe("farah");
  });

  it("approves when somebody other than the preparer signs it", async () => {
    const run = await approveRun({ orgId: ORG, runId: run1, approvedBy: "omar", submittedBy: "farah" });
    expect(run.status).toBe("approved");
    expect(run.approvedBy).toBe("omar");
    expect(run.approvedAt).not.toBeNull();
  });

  it("holds the same rule in the database, so no other writer can get round it", async () => {
    // Application checks protect the paths that call them. This one is on the
    // row, so a script, an import or a future module cannot write a run that
    // the same person prepared and approved.
    await expect(
      db.paymentRun.update({ where: { id: run1 }, data: { approvedBy: "  FARAH " } }),
    ).rejects.toThrow(/PaymentRun_separation_check/);
  });

  it("refuses a second approval and says who already gave one", async () => {
    await expect(approveRun({ orgId: ORG, runId: run1, approvedBy: "layla", submittedBy: "farah" }))
      .rejects.toThrow(/already approved by omar/i);
  });

  it("refuses to change what an approved run pays", async () => {
    await expect(excludeItem({ orgId: ORG, runId: run1, itemId: item5, reason: "changed my mind" }))
      .rejects.toThrow(/signature for a different batch/i);
  });

  it("refuses a bank file for a run nobody has approved", async () => {
    const draft = await proposeRun({
      orgId: ORG, entityId: ENT, runDate: "2026-04-27", dueBy: "2026-04-27", reference: "PR-UNAPPROVED",
    });
    await expect(bankFile({ orgId: ORG, runId: draft.id, beneficiaries: [] }))
      .rejects.toThrow(/has not been approved, so no bank file/i);
    await cancelRun({ orgId: ORG, runId: draft.id, reason: "proposed only to prove the bank file is refused" });
  });

  /* ---------------------------------------------------------------- release */

  it("posts one debit to payables per bill and one credit to the bank for the transfer", async () => {
    const before = await payablesAgeing({ orgId: ORG, entityId: ENT, asOf: new Date("2026-04-25") });
    const r = await releaseRun({ orgId: ORG, runId: run1, releasedOn: "2026-04-25" });

    expect(r.status).toBe("released");
    expect(r.alreadyReleased).toBe(false);
    // One entry, because one transfer left the bank. A separate entry per bill
    // would credit the bank three times against a statement showing one debit,
    // and the reconciliation would have nothing to match.
    expect(r.entryIds).toHaveLength(1);
    expect(r.entryId).toBe(r.entryIds[0]);

    const total = 105_000n + 12_600n + 31_500n;
    expect(await linesOfRun(run1)).toEqual({ "2000": total, "1010": -total });

    const entries = await db.journalEntry.findMany({
      where: { orgId: ORG, sourceType: "PAYMENT_RUN", sourceId: run1 },
      include: { lines: { include: { account: true } } },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].series).toBe("PR");

    // Settlement is on the line, so one entry discharges all three bills.
    const payableLines = entries[0].lines.filter((l) => l.account.code === "2000");
    expect(payableLines).toHaveLength(3);
    expect(new Set(payableLines.map((l) => l.settlesId))).toEqual(new Set([A1.id, A5.id, CTRL.id]));
    expect(payableLines.every((l) => l.txnAmountMinor > 0n)).toBe(true);

    const bankLines = entries[0].lines.filter((l) => l.account.code === "1010");
    expect(bankLines).toHaveLength(1);
    expect(bankLines[0].txnAmountMinor).toBe(-total);

    expect(BigInt(before.totalMinor)).toBeGreaterThan(0n);
  });

  it("clears the payables ageing exactly as settling one bill at a time would", async () => {
    // The control bill is in the run; settle a bill of the same shape the old
    // way and the ageing has to treat them identically.
    const solo = await receive(bill({
      number: "BILL-SOLO", issueDate: "2026-04-04", dueDate: "2026-04-20",
      seller: { nameEn: "Palm Tools LLC" },
    }, [line(12_000, 600)]));
    await postSupplierPayment({
      orgId: ORG, entityId: ENT, billId: solo.id, billNumber: solo.number,
      paymentId: "sp-solo", paidOn: "2026-04-25", bankAmountMinor: 12_600,
    });

    const ageing = await payablesAgeing({ orgId: ORG, entityId: ENT, asOf: new Date("2026-04-30") });
    // Paid in a batch, or paid on its own — both vanish from the report.
    expect(openOf(ageing, "BILL-CTRL")).toBeUndefined();
    expect(openOf(ageing, "BILL-SOLO")).toBeUndefined();
    expect(openOf(ageing, "BILL-A1")).toBeUndefined();
    expect(openOf(ageing, "BILL-A5")).toBeUndefined();

    // What was not paid is still owed, to the fils.
    expect(BigInt(openOf(ageing, "BILL-A2")!.outstandingMinor)).toBe(63_000n);
    expect(BigInt(openOf(ageing, "BILL-A3")!.outstandingMinor)).toBe(42_000n);
    expect(BigInt(openOf(ageing, "BILL-A4")!.outstandingMinor)).toBe(21_000n);
    expect(BigInt(openOf(ageing, "SCN-A1")!.outstandingMinor)).toBe(-10_500n);
    expect(BigInt(ageing.totalMinor)).toBe(63_000n + 42_000n + 21_000n - 10_500n);
  });

  it("releases twice without paying twice", async () => {
    const again = await releaseRun({ orgId: ORG, runId: run1, releasedOn: "2026-04-25" });
    expect(again.alreadyReleased).toBe(true);
    expect(again.entryIds).toHaveLength(1);

    const total = 105_000n + 12_600n + 31_500n;
    expect(await linesOfRun(run1)).toEqual({ "2000": total, "1010": -total });
    const count = await db.journalEntry.count({ where: { orgId: ORG, sourceType: "PAYMENT_RUN", sourceId: run1 } });
    expect(count).toBe(1);
  });

  it("refuses to cancel a released run and says to reverse the entries instead", async () => {
    await expect(cancelRun({ orgId: ORG, runId: run1, reason: "we changed our mind" }))
      .rejects.toThrow(/reverse the entries it posted instead/i);
    expect((await runDetail({ orgId: ORG, runId: run1 })).status).toBe("released");
  });

  /* -------------------------------------------------------------- bank file */

  it("names every beneficiary without an IBAN at once", async () => {
    let message = "";
    try {
      await bankFile({ orgId: ORG, runId: run1, beneficiaries: [] });
    } catch (e) {
      message = (e as Error).message;
    }
    // A bank rejects the whole file for one bad row, so all of them by name.
    expect(message).toContain("Gulf Supplies LLC (BILL-A1) has no IBAN");
    expect(message).toContain("Palm Tools LLC (BILL-CTRL) has no IBAN");
    expect(message).toContain("Palm Tools LLC (BILL-A5) has no IBAN");
    expect(message).toMatch(/fix all of these before generating it/i);
  });

  it("refuses an IBAN that fails its own check digits", async () => {
    await expect(bankFile({
      orgId: ORG, runId: run1,
      beneficiaries: [
        { name: "Gulf Supplies LLC", iban: "AE07 0331 2345 6789 0123 456" },
        { name: "Palm Tools LLC", iban: "AE99 9331 2345 6789 0123 456" },
      ],
    })).rejects.toThrow(/AE999331234567890123456", which is not a valid IBAN/);
  });

  it("builds the payment instruction file once every beneficiary is known", async () => {
    const file = await bankFile({
      orgId: ORG, runId: run1,
      beneficiaries: [
        { name: "gulf supplies llc", iban: "AE07 0331 2345 6789 0123 456" },
        { name: "Palm Tools LLC", iban: "AE460090000000123456789" },
      ],
      createdAt: new Date("2026-04-25T09:00:00Z"),
    });

    const rows = file.csv.trim().split("\n");
    expect(rows[0]).toBe("Beneficiary,IBAN,Amount,Currency,Reference");
    expect(rows).toHaveLength(4);
    expect(rows).toContain("Gulf Supplies LLC,AE070331234567890123456,1050.00,AED,PR-2026-04-25 BILL-A1");
    expect(rows).toContain("Palm Tools LLC,AE460090000000123456789,315.00,AED,PR-2026-04-25 BILL-A5");
    expect(file.rows).toBe(3);
    expect(BigInt(file.totalMinor)).toBe(105_000n + 12_600n + 31_500n);
    expect(file.filename).toBe("PAYMENTS_PR20260425_20260425.csv");
    expect(file.csv.endsWith("\n")).toBe(true);
  });

  /* ------------------------------------------------- the next run, and cancelling */

  it("picks up a bill once its due date has arrived", async () => {
    const run = await proposeRun({ orgId: ORG, entityId: ENT, runDate: "2026-06-01", dueBy: "2026-06-01" });
    run2 = run.id;
    const paying = run.items.filter((i) => !i.excluded);
    expect(paying.map((i) => i.billNumber)).toEqual(["BILL-A4"]);
    expect(BigInt(run.totalMinor)).toBe(21_000n);
    expect(run.notDue).toHaveLength(0);
    // The bills that were excluded last time are excluded again, for the same
    // reasons — an exclusion is a fact about the bill, not about the run.
    expect(run.items.filter((i) => i.excluded).map((i) => i.billNumber).sort())
      .toEqual(["BILL-A2", "BILL-A3", "SCN-A1"]);
  });

  it("will not put a bill into two unreleased runs at once", async () => {
    const run = await proposeRun({ orgId: ORG, entityId: ENT, runDate: "2026-06-02", dueBy: "2026-06-02" });
    run3 = run.id;
    const a4 = run.items.find((i) => i.billNumber === "BILL-A4")!;
    expect(a4.excluded).toBe(true);
    expect(a4.excludeReason).toContain("already on payment run PR-2026-06-01");
    expect(BigInt(run.totalMinor)).toBe(0n);
  });

  it("refuses to approve a run with nothing left in it to pay", async () => {
    await expect(approveRun({ orgId: ORG, runId: run3, approvedBy: "omar", submittedBy: "farah" }))
      .rejects.toThrow(/has nothing in it to pay/i);
  });

  it("cancels a run before it is released, and every payment on it keeps the reason", async () => {
    const run = await cancelRun({ orgId: ORG, runId: run2, reason: "the bank moved the run to Thursday" });
    expect(run.status).toBe("cancelled");
    expect(run.items.every((i) => i.excluded)).toBe(true);
    expect(run.items.find((i) => i.billNumber === "BILL-A4")?.excludeReason)
      .toContain("cancelled: the bank moved the run to Thursday");
    expect(BigInt(run.totalMinor)).toBe(0n);
    await expect(cancelRun({ orgId: ORG, runId: run2, reason: "again" })).rejects.toThrow(/was already cancelled/i);
    await expect(releaseRun({ orgId: ORG, runId: run2 })).rejects.toThrow(/was cancelled, so it cannot be released/i);
  });

  it("frees the bill again once the run holding it is cancelled", async () => {
    // run2 held BILL-A4 and has been cancelled; run3 only ever held it as an
    // exclusion, which reserves nothing. So the bill is payable again.
    const run = await proposeRun({ orgId: ORG, entityId: ENT, runDate: "2026-06-03", dueBy: "2026-06-03" });
    run4 = run.id;
    const a4 = run.items.find((i) => i.billNumber === "BILL-A4")!;
    expect(a4.excluded).toBe(false);
    expect(BigInt(run.totalMinor)).toBe(21_000n);

    // And while THIS run holds it, the next proposal will not take it again.
    const shadow = await proposeRun({ orgId: ORG, entityId: ENT, runDate: "2026-06-04", dueBy: "2026-06-04" });
    expect(shadow.items.find((i) => i.billNumber === "BILL-A4")?.excludeReason)
      .toContain("already on payment run PR-2026-06-03");

    await cancelRun({ orgId: ORG, runId: shadow.id, reason: "superseded" });
    await cancelRun({ orgId: ORG, runId: run4, reason: "superseded" });
    await cancelRun({ orgId: ORG, runId: run3, reason: "superseded" });
  });

  it("refuses a second run under a reference somebody has already used", async () => {
    await expect(proposeRun({
      orgId: ORG, entityId: ENT, runDate: "2026-06-05", dueBy: "2026-06-05", reference: "PR-2026-06-01",
    })).rejects.toThrow(/already exists for this entity/i);
  });

  /* ------------------------------------------------------------------ reading */

  it("lists the runs with what each is holding", async () => {
    const list = await runList({ orgId: ORG, entityId: ENT });
    const released = list.runs.find((r) => r.reference === "PR-2026-04-25")!;
    expect(released.status).toBe("released");
    expect(released.includedCount).toBe(3);
    expect(released.excludedCount).toBe(3);
    expect(BigInt(released.totalMinor)).toBe(105_000n + 12_600n + 31_500n);
    expect(released.approvedBy).toBe("omar");
    // Nothing is approved and unreleased, and nothing is sitting in a draft.
    expect(BigInt(list.awaitingReleaseMinor)).toBe(0n);
    expect(BigInt(list.awaitingApprovalMinor)).toBe(0n);
    expect((await runList({ orgId: ORG, entityId: ENT, status: "released" })).runs).toHaveLength(1);
  });

  it("gives one run back in full, with the entries it posted", async () => {
    const run = await runDetail({ orgId: ORG, runId: run1 });
    expect(run.entries).toHaveLength(1);
    expect(run.entries[0].reference.startsWith("PR-")).toBe(true);
    expect(run.entries[0].entryDate).toBe("2026-04-25");
    await expect(runDetail({ orgId: ORG, runId: "no-such-run" })).rejects.toThrow(/does not exist/i);
  });

  it("keeps the trial balance tied after everything above", async () => {
    for (const period of ["2026-03", "2026-04", "2026-06"]) {
      const tb = await trialBalance({ orgId: ORG, entityId: ENT, periodLabel: period });
      expect(tb.balanced).toBe(true);
      expect(tb.differenceMinor).toBe(0n);
    }
  });
});
