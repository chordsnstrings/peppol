import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  recordCheque, depositCheque, clearCheque, bounceCheque, representCheque,
  returnCheque, cancelCheque, chequeRegister, dueSoon, chequeDetail,
} from "@/lib/server/ledger/cheques";
import { postInvoice, receivablesAgeing } from "@/lib/server/ledger/ar";
import { postBill, payablesAgeing } from "@/lib/server/ledger/ap";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { trialBalance } from "@/lib/server/ledger/reports";
import { post, LedgerError } from "@/lib/server/ledger/post";
import type { Invoice, InvoiceLine, TaxProfileCode } from "@/lib/domain/types";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-chq";
const ENT = "t-ent-chq";
const OTHER_ORG = "t-org-chq-other";
const OTHER_ENT = "t-ent-chq-other";

async function wipe() {
  for (const org of [ORG, OTHER_ORG]) {
    await db.$transaction([
      db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
      db.$executeRawUnsafe(`DELETE FROM "Cheque" WHERE "orgId" = '${org}'`),
      db.$executeRawUnsafe(`DELETE FROM "JournalLineDimension" WHERE "lineId" IN (SELECT id FROM "JournalLine" WHERE "orgId" = '${org}')`),
      db.$executeRawUnsafe(`DELETE FROM "JournalLine" WHERE "orgId" = '${org}'`),
      db.$executeRawUnsafe(`DELETE FROM "JournalEntry" WHERE "orgId" = '${org}'`),
      db.$executeRawUnsafe(`DELETE FROM "AccountBalance" WHERE "orgId" = '${org}'`),
      db.$executeRawUnsafe(`DELETE FROM "Account" WHERE "orgId" = '${org}'`),
      db.$executeRawUnsafe(`DELETE FROM "AccountingPeriod" WHERE "orgId" = '${org}'`),
      db.$executeRawUnsafe(`DELETE FROM "FiscalYear" WHERE "orgId" = '${org}'`),
      db.$executeRawUnsafe(`DELETE FROM "Book" WHERE "orgId" = '${org}'`),
      db.$executeRawUnsafe(`DELETE FROM "DocumentSequence" WHERE "orgId" = '${org}'`),
    ]);
  }
}

let seq = 0;
function line(net: number, vat: number, profile: TaxProfileCode = "STANDARD_5"): InvoiceLine {
  return {
    id: `l${++seq}`, lineNo: seq, description: "Supply", qty: 1, unitCode: "C62",
    unitPriceMinor: net, taxProfileCode: profile, lineNetMinor: net, lineVatMinor: vat,
  };
}

function doc(direction: "OUTBOUND" | "INBOUND", over: Partial<Invoice> = {}, lines = [line(100_000, 5_000)]): Invoice {
  const net = lines.reduce((a, l) => a + l.lineNetMinor, 0);
  const vat = lines.reduce((a, l) => a + l.lineVatMinor, 0);
  return {
    id: `${direction === "OUTBOUND" ? "inv" : "bill"}-${++seq}`, orgId: ORG, entityId: ENT,
    direction, docType: "TAX_INVOICE",
    number: `${direction === "OUTBOUND" ? "INV" : "BILL"}-${seq}`,
    issueDate: "2026-03-05", supplyDate: "2026-03-05", currency: "AED",
    buyer: { nameEn: direction === "OUTBOUND" ? "Al Marri Trading LLC" : "Our Company" },
    seller: { nameEn: direction === "OUTBOUND" ? "Our Company" : "Gulf Supplies LLC" },
    lines,
    totals: { taxExclusiveMinor: net, vatMinor: vat, taxInclusiveMinor: net + vat, payableMinor: net + vat, perCategory: [] },
    lifecycleStatus: "SENT", exchangeStatus: "NOT_SENT", reportingStatusC2: "NOT_REPORTED",
    source: direction === "OUTBOUND" ? "EDITOR" : "INGEST",
    compliance: { taxableEventDate: "2026-03-05", daysRemaining: 14, breached: false },
    createdAt: "2026-03-05T00:00:00Z", updatedAt: "2026-03-05T00:00:00Z",
    ...over,
  } as Invoice;
}

/** The journal as the ledger actually holds it: account code → signed minor units. */
async function linesOf(entryId: string) {
  const rows = await db.journalLine.findMany({ where: { entryId }, include: { account: true }, orderBy: { lineNo: "asc" } });
  const out: Record<string, bigint> = {};
  for (const r of rows) out[r.account.code] = (out[r.account.code] ?? 0n) + r.txnAmountMinor;
  return out;
}

/** What one account carries across the whole entity, straight off the lines. */
async function balanceOf(code: string, orgId = ORG) {
  const rows = await db.journalLine.findMany({
    where: { orgId, account: { code } },
    select: { txnAmountMinor: true },
  });
  return rows.reduce((a, r) => a + r.txnAmountMinor, 0n);
}

/** One document's open item as the ageing sees it, or null once it has cleared. */
async function openItem(sourceId: string, asOf: string, side: "AR" | "AP" = "AR") {
  const report = side === "AR"
    ? await receivablesAgeing({ orgId: ORG, entityId: ENT, asOf: new Date(asOf) })
    : await payablesAgeing({ orgId: ORG, entityId: ENT, asOf: new Date(asOf) });
  return report.open.find((o) => o.sourceId === sourceId) ?? null;
}

const scope = { orgId: ORG, entityId: ENT };

d("post-dated cheques", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });
    await openFiscalYear({ orgId: OTHER_ORG, entityId: OTHER_ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: OTHER_ORG, entityId: OTHER_ENT });

    // Money in the bank, so the diary has something to measure an issued
    // cheque against. Capital introduced, which is where an SMB's first
    // balance actually comes from.
    await post({
      ...scope, entryDate: "2026-01-02", memo: "Capital introduced", series: "GJ",
      lines: [{ account: "1010", debit: 500_000 }, { account: "3000", credit: 500_000 }],
    });
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("moves the debt out of receivables and into the paper, dated", async () => {
    const inv = doc("OUTBOUND", { id: "inv-held", number: "INV-HELD", dueDate: "2026-04-04" });
    await postInvoice({ orgId: ORG, invoice: inv });
    expect((await openItem("inv-held", "2026-03-11"))?.outstandingMinor).toBe("105000");

    const r = await recordCheque({
      ...scope, direction: "RECEIVED", number: "100477", counterparty: "Al Marri Trading LLC",
      bankName: "Emirates NBD", writtenOn: "2026-03-12", dueOn: "2026-06-10",
      amountMinor: 105_000, settlesId: inv.id,
    });
    expect(r.alreadyRecorded).toBe(false);
    expect(r.reference.startsWith("CQ-")).toBe(true);

    // Not cash, and not an ordinary receivable either: a receivable whose form
    // has changed.
    expect(await linesOf(r.entryId)).toEqual({
      "1060": 105_000n,   // Dr cheques in hand — the paper
      "1100": -105_000n,  // Cr trade receivables — no longer owed in the ordinary way
    });

    // The journal carries the day it may be presented, not only the register.
    const entry = await db.journalEntry.findUniqueOrThrow({ where: { id: r.entryId } });
    expect(entry.dueDate?.toISOString().slice(0, 10)).toBe("2026-06-10");
    expect(entry.source).toBe("cheque");
    expect(entry.sourceType).toBe("CHEQUE_RECEIVED");
    expect(entry.settlesId).toBe("inv-held");

    // The ageing clears, because the debt is no longer in trade receivables.
    expect(await openItem("inv-held", "2026-03-31")).toBeNull();

    expect(r.cheque.status).toBe("held");
    expect(r.cheque.dueOn).toBe("2026-06-10");
    expect(r.cheque.amountMinor).toBe(105_000n);
  });

  it("records one piece of paper once, and refuses a second cheque under the same number", async () => {
    const again = await recordCheque({
      ...scope, direction: "RECEIVED", number: "100477", counterparty: "Al Marri Trading LLC",
      writtenOn: "2026-03-12", dueOn: "2026-06-10", amountMinor: 105_000,
    });
    expect(again.alreadyRecorded).toBe(true);
    expect(await db.journalEntry.count({ where: { orgId: ORG, sourceId: again.chequeId } })).toBe(1);

    await expect(recordCheque({
      ...scope, direction: "RECEIVED", number: "100477", counterparty: "Al Marri Trading LLC",
      writtenOn: "2026-03-12", dueOn: "2026-06-10", amountMinor: 105_500,
    })).rejects.toThrow(/transposed digit/i);

    // A cheque cannot fall due before it was written — that is a typo, and it
    // would present at once.
    await expect(recordCheque({
      ...scope, direction: "RECEIVED", number: "100999", counterparty: "Al Marri Trading LLC",
      writtenOn: "2026-06-10", dueOn: "2026-03-12", amountMinor: 1_000,
    })).rejects.toThrow(/other way round is a typo/i);
  });

  it("banks the cheque without pretending anything reached the ledger", async () => {
    const before = await db.journalEntry.count({ where: { orgId: ORG } });
    const c = await db.cheque.findFirstOrThrow({ where: { orgId: ORG, number: "100477" } });

    const r = await depositCheque({ ...scope, chequeId: c.id, on: "2026-06-08", reference: "Deposit slip 4471" });
    expect(r.status).toBe("deposited");
    expect(r.entryId).toBeNull();
    // The paper moved from a drawer to a counter; nothing the business owns changed.
    expect(await db.journalEntry.count({ where: { orgId: ORG } })).toBe(before);
    expect(await balanceOf("1060")).toBe(105_000n);
  });

  it("clears through the same open item, so the money lands and nothing re-opens", async () => {
    const c = await db.cheque.findFirstOrThrow({ where: { orgId: ORG, number: "100477" } });
    const r = await clearCheque({ ...scope, chequeId: c.id, on: "2026-06-11" });

    expect(await linesOf(r.entryId!)).toEqual({
      "1010": 105_000n,   // Dr bank — the money arrived
      "1060": -105_000n,  // Cr cheques in hand — the paper is spent
    });
    expect(r.status).toBe("cleared");

    // Every line raised against that invoice, from the sale to the bank, nets
    // to nothing: the open item is settled exactly as an ordinary receipt
    // settles one.
    const arLines = await db.journalLine.findMany({
      where: { orgId: ORG, account: { code: "1100" }, entry: { OR: [{ settlesId: "inv-held" }, { sourceId: "inv-held" }] } },
      select: { txnAmountMinor: true },
    });
    expect(arLines.reduce((a, l) => a + l.txnAmountMinor, 0n)).toBe(0n);
    expect(await openItem("inv-held", "2026-06-30")).toBeNull();
    expect(await balanceOf("1060")).toBe(0n);

    // The paper is spent, so the register holds nothing against it.
    const reg = await chequeRegister({ ...scope, asOf: "2026-06-30" });
    expect(reg.received.outstandingMinor).toBe(0n);
    expect(reg.received.clearedMinor).toBe(105_000n);
    expect(reg.received.reconciled).toBe(true);
  });

  it("puts a bounced cheque back into receivables and leaves the customer exactly where they were", async () => {
    const inv = doc("OUTBOUND", { id: "inv-bounce", number: "INV-BOUNCE", issueDate: "2026-03-05", dueDate: "2026-04-04" },
      [line(50_000, 2_500)]);
    await postInvoice({ orgId: ORG, invoice: inv });
    const beforeCheque = await openItem("inv-bounce", "2026-05-31");
    expect(beforeCheque?.outstandingMinor).toBe("52500");

    const r = await recordCheque({
      ...scope, direction: "RECEIVED", number: "200310", counterparty: "Al Marri Trading LLC",
      bankName: "Mashreq", writtenOn: "2026-03-08", dueOn: "2026-05-15",
      amountMinor: 52_500, settlesId: inv.id,
    });
    expect(await openItem("inv-bounce", "2026-05-14")).toBeNull();

    const c = await db.cheque.findFirstOrThrow({ where: { orgId: ORG, number: "200310" } });
    const b = await bounceCheque({ ...scope, chequeId: c.id, on: "2026-05-20", reason: "insufficient funds" });

    expect(await linesOf(b.entryId!)).toEqual({
      "1100": 52_500n,   // Dr trade receivables — the customer owes it again
      "1060": -52_500n,  // Cr cheques in hand — the paper was worthless
    });

    // Exactly where they were: same document, same date, same band — plus a
    // bounced cheque on the record.
    const after = await openItem("inv-bounce", "2026-05-31");
    expect(after?.outstandingMinor).toBe("52500");
    expect(after?.date).toBe(beforeCheque?.date);
    expect(after?.dueDate).toBe("2026-04-04");
    expect(after?.daysOld).toBe(beforeCheque?.daysOld);
    expect(after?.daysOverdue).toBeGreaterThan(0);

    const saved = await db.cheque.findUniqueOrThrow({ where: { id: c.id } });
    expect(saved.status).toBe("bounced");
    expect(saved.bounceReason).toBe("insufficient funds");
    expect(saved.statusOn?.toISOString().slice(0, 10)).toBe("2026-05-20");
    expect(saved.bouncedEntryId).toBe(b.entryId);
    expect(r.cheque.bounceCount).toBe(0);
  });

  it("refuses a bounce with no reason, and leaves the cheque where it was", async () => {
    const inv = doc("OUTBOUND", { id: "inv-noreason", number: "INV-NOREASON" }, [line(10_000, 500)]);
    await postInvoice({ orgId: ORG, invoice: inv });
    const r = await recordCheque({
      ...scope, direction: "RECEIVED", number: "200311", counterparty: "Al Marri Trading LLC",
      writtenOn: "2026-03-08", dueOn: "2026-05-18", amountMinor: 10_500, settlesId: inv.id,
    });

    await expect(bounceCheque({ ...scope, chequeId: r.chequeId, on: "2026-05-20", reason: "  " }))
      .rejects.toThrow(/reason the bank gave/i);
    await expect(bounceCheque({ ...scope, chequeId: r.chequeId, on: "2026-05-20", reason: "" }))
      .rejects.toThrow(LedgerError);

    // Nothing was posted and nothing moved: the cheque is still in hand.
    const still = await db.cheque.findUniqueOrThrow({ where: { id: r.chequeId } });
    expect(still.status).toBe("held");
    expect(still.bouncedEntryId).toBeNull();
    expect(await db.journalEntry.count({ where: { orgId: ORG, sourceId: r.chequeId } })).toBe(1);
  });

  it("refuses an illegal transition by naming where the cheque actually is", async () => {
    const cleared = await db.cheque.findFirstOrThrow({ where: { orgId: ORG, number: "100477" } });
    await expect(depositCheque({ ...scope, chequeId: cleared.id, on: "2026-06-20" }))
      .rejects.toThrow(/cleared.*nothing further is possible/is);
    await expect(clearCheque({ ...scope, chequeId: cleared.id, on: "2026-06-20" }))
      .rejects.toThrow(LedgerError);

    // A cheque with the bank cannot be handed back across the counter.
    const inv = doc("OUTBOUND", { id: "inv-illegal", number: "INV-ILLEGAL" }, [line(20_000, 1_000)]);
    await postInvoice({ orgId: ORG, invoice: inv });
    const held = await recordCheque({
      ...scope, direction: "RECEIVED", number: "200312", counterparty: "Al Marri Trading LLC",
      writtenOn: "2026-03-09", dueOn: "2026-05-25", amountMinor: 21_000, settlesId: inv.id,
    });
    await depositCheque({ ...scope, chequeId: held.chequeId, on: "2026-05-23" });
    await expect(returnCheque({ ...scope, chequeId: held.chequeId, on: "2026-05-24" }))
      .rejects.toThrow(/with the bank.*can only be cleared, bounced/is);

    // And the cheque that has not bounced cannot be re-presented.
    await expect(representCheque({ ...scope, chequeId: held.chequeId, on: "2026-05-26" }))
      .rejects.toThrow(/cannot be re-presented/i);
  });

  it("re-presents the same piece of paper rather than inventing a second one", async () => {
    const c = await db.cheque.findFirstOrThrow({ where: { orgId: ORG, number: "200310" } });
    const again = await representCheque({ ...scope, chequeId: c.id, on: "2026-06-01" });

    expect(again.status).toBe("held");
    expect(await linesOf(again.entryId!)).toEqual({
      "1060": 52_500n,    // the paper goes back out of receivables
      "1100": -52_500n,
    });
    expect(await openItem("inv-bounce", "2026-06-02")).toBeNull();

    // One record, one number, the whole history on it.
    expect(await db.cheque.count({ where: { orgId: ORG, number: "200310" } })).toBe(1);
    const saved = await db.cheque.findUniqueOrThrow({ where: { id: c.id } });
    expect(saved.bounceReason).toBe("insufficient funds");

    const detail = await chequeDetail({ ...scope, chequeId: c.id, asOf: "2026-06-02" });
    expect(detail.history.map((h) => h.kind)).toEqual(["received", "bounced", "re-presented"]);
    expect(detail.history[1].detail).toBe("insufficient funds");
    expect(detail.history[1].reference?.startsWith("CQ-")).toBe(true);
    expect(detail.cheque.bounceCount).toBe(1);

    // Second time lucky: the clearing gets its own entry rather than being
    // mistaken for a retry of the first presentation.
    const cleared = await clearCheque({ ...scope, chequeId: c.id, on: "2026-06-04" });
    expect(cleared.alreadyPosted).toBe(false);
    expect(await linesOf(cleared.entryId!)).toEqual({ "1010": 52_500n, "1060": -52_500n });
    expect(await db.journalEntry.count({ where: { orgId: ORG, sourceId: c.id } })).toBe(4);

    // Sale, cheque, bounce, cheque again, bank: nothing left against the customer.
    expect(await openItem("inv-bounce", "2026-06-30")).toBeNull();
  });

  it("gives a supplier cheque the mirror-image journals", async () => {
    const bill = doc("INBOUND", { id: "bill-issued", number: "BILL-ISSUED", issueDate: "2026-04-02", dueDate: "2026-05-02" });
    await postBill({ orgId: ORG, bill });
    expect((await openItem("bill-issued", "2026-04-30", "AP"))?.outstandingMinor).toBe("105000");

    const r = await recordCheque({
      ...scope, direction: "ISSUED", number: "550001", counterparty: "Gulf Supplies LLC",
      bankName: "Emirates NBD", writtenOn: "2026-04-03", dueOn: "2026-07-02",
      amountMinor: 105_000, settlesId: bill.id,
    });
    expect(await linesOf(r.entryId)).toEqual({
      "2000": 105_000n,   // Dr trade payables — off the supplier's open account
      "2060": -105_000n,  // Cr cheques issued — committed to a dated cheque
    });
    expect(await openItem("bill-issued", "2026-06-30", "AP")).toBeNull();

    const cleared = await clearCheque({ ...scope, chequeId: r.chequeId, on: "2026-07-02" });
    expect(await linesOf(cleared.entryId!)).toEqual({
      "2060": 105_000n,   // Dr cheques issued
      "1010": -105_000n,  // Cr bank — the money left
    });

    // Our own cheque can bounce too, and the supplier is owed again.
    const bill2 = doc("INBOUND", { id: "bill-bounced", number: "BILL-BOUNCED", issueDate: "2026-04-06", dueDate: "2026-05-06" },
      [line(40_000, 2_000)]);
    await postBill({ orgId: ORG, bill: bill2 });
    const own = await recordCheque({
      ...scope, direction: "ISSUED", number: "550002", counterparty: "Gulf Supplies LLC",
      writtenOn: "2026-04-07", dueOn: "2026-05-30", amountMinor: 42_000, settlesId: bill2.id,
    });
    expect(await openItem("bill-bounced", "2026-05-10", "AP")).toBeNull();

    const bounced = await bounceCheque({
      ...scope, chequeId: own.chequeId, on: "2026-05-30", reason: "insufficient funds — our account",
    });
    expect(await linesOf(bounced.entryId!)).toEqual({
      "2060": 42_000n,    // Dr cheques issued — the commitment is gone
      "2000": -42_000n,   // Cr trade payables — we owe the supplier again
    });
    expect((await openItem("bill-bounced", "2026-05-31", "AP"))?.outstandingMinor).toBe("42000");

    // Handing back or cancelling a cheque that has already bounced posts
    // nothing: the debt went back to the supplier when it bounced.
    const closed = await cancelCheque({ ...scope, chequeId: own.chequeId, on: "2026-06-01", reason: "replaced by transfer" });
    expect(closed.entryId).toBeNull();
    expect(await db.journalEntry.count({ where: { orgId: ORG, sourceId: own.chequeId } })).toBe(2);
    // Both issued cheques are settled one way or the other, so nothing is
    // committed on the holding account.
    expect(await balanceOf("2060")).toBe(0n);
  });

  it("hands an unpresented cheque back by undoing the journal that took it in", async () => {
    const inv = doc("OUTBOUND", { id: "inv-returned", number: "INV-RETURNED" }, [line(30_000, 1_500)]);
    await postInvoice({ orgId: ORG, invoice: inv });
    const r = await recordCheque({
      ...scope, direction: "RECEIVED", number: "200400", counterparty: "Al Marri Trading LLC",
      writtenOn: "2026-03-15", dueOn: "2026-06-15", amountMinor: 31_500, settlesId: inv.id,
    });
    expect(await openItem("inv-returned", "2026-04-01")).toBeNull();

    const back = await returnCheque({
      ...scope, chequeId: r.chequeId, on: "2026-04-20", reason: "customer paid by transfer instead",
    });
    expect(await linesOf(back.entryId!)).toEqual({
      "1100": 31_500n,   // the debt is back on the customer's account
      "1060": -31_500n,
    });
    expect((await openItem("inv-returned", "2026-04-30"))?.outstandingMinor).toBe("31500");
    expect(back.status).toBe("returned");
    await expect(clearCheque({ ...scope, chequeId: r.chequeId, on: "2026-06-15" }))
      .rejects.toThrow(/returned to the counterparty/i);
  });

  it("ages the register by the day it may be presented, not the day it was written", async () => {
    // Written in January, dated for July: four months away, not five months old.
    const inv = doc("OUTBOUND", { id: "inv-longdated", number: "INV-LONGDATED", issueDate: "2026-01-05" },
      [line(200_000, 10_000)]);
    await postInvoice({ orgId: ORG, invoice: inv });
    const r = await recordCheque({
      ...scope, direction: "RECEIVED", number: "300100", counterparty: "Al Marri Trading LLC",
      writtenOn: "2026-01-06", dueOn: "2026-07-06", amountMinor: 210_000, settlesId: inv.id,
    });

    const reg = await chequeRegister({ ...scope, asOf: "2026-03-01" });
    const row = reg.received.held.find((x) => x.number === "300100");
    expect(row).toBeDefined();
    expect(row!.bucket).toBe("over90");        // 127 days to run
    expect(row!.daysToDue).toBe(127);
    // The same cheque aged the ordinary way would be 54 days old and look
    // overdue; the whole point of a post-dated cheque is that it is not.
    expect(row!.writtenOn).toBe("2026-01-06");
    expect(reg.received.buckets.over90).toBeGreaterThanOrEqual(210_000n);
    expect(reg.received.buckets.overdue).toBe(0n);

    // Wind the clock past the date and it is the one to chase today.
    const later = await chequeRegister({ ...scope, asOf: "2026-07-20" });
    const then = later.received.held.find((x) => x.number === "300100");
    expect(then!.bucket).toBe("overdue");
    expect(then!.daysToDue).toBe(-14);
    expect(later.received.buckets.overdue).toBeGreaterThanOrEqual(210_000n);
    expect(r.cheque.status).toBe("held");
  });

  it("ties the register to the ledger, and says so when they drift", async () => {
    const asOf = "2026-07-31";
    const reg = await chequeRegister({ ...scope, asOf });

    // The register total comes from the cheques; the balance comes from the
    // journal lines. They are computed from different places on purpose.
    expect(reg.received.ledgerMinor).toBe(await balanceOf("1060"));
    expect(reg.received.differenceMinor).toBe(0n);
    expect(reg.received.reconciled).toBe(true);
    expect(reg.issued.ledgerMinor).toBe(-(await balanceOf("2060")));
    expect(reg.issued.reconciled).toBe(true);
    expect(reg.reconciled).toBe(true);
    expect(reg.received.outstandingMinor).toBe(
      reg.received.held.reduce((a, r) => a + r.amountMinor, 0n) +
      reg.received.deposited.reduce((a, r) => a + r.amountMinor, 0n),
    );
    expect(reg.outstandingMinor).toBe(reg.received.outstandingMinor + reg.issued.outstandingMinor);

    // Somebody posts to the cheques account by hand. The register is not fooled
    // into agreeing with it.
    await post({
      ...scope, entryDate: "2026-07-30", memo: "Stray journal against cheques in hand", series: "GJ",
      lines: [{ account: "1060", debit: 5_000 }, { account: "1010", credit: 5_000 }],
    });
    const drifted = await chequeRegister({ ...scope, asOf });
    expect(drifted.received.differenceMinor).toBe(5_000n);
    expect(drifted.received.reconciled).toBe(false);
    expect(drifted.reconciled).toBe(false);
    expect(drifted.received.outstandingMinor).toBe(reg.received.outstandingMinor);
  });

  it("flags an issued cheque the bank cannot meet, and does not count incoming cheques as cover", async () => {
    const bank = await balanceOf("1010");
    expect(bank).toBeGreaterThan(0n);

    const bill1 = doc("INBOUND", { id: "bill-due-1", number: "BILL-DUE-1", issueDate: "2026-08-01" }, [line(20_000, 1_000)]);
    const bill2 = doc("INBOUND", { id: "bill-due-2", number: "BILL-DUE-2", issueDate: "2026-08-01" },
      [line(Number(bank), 0, "OUT_OF_SCOPE")]);
    await postBill({ orgId: ORG, bill: bill1 });
    await postBill({ orgId: ORG, bill: bill2 });

    // One small cheque the account can meet, then one that takes the running
    // total past the balance.
    await recordCheque({
      ...scope, direction: "ISSUED", number: "770001", counterparty: "Gulf Supplies LLC",
      writtenOn: "2026-08-02", dueOn: "2026-08-10", amountMinor: 21_000, settlesId: bill1.id,
    });
    await recordCheque({
      ...scope, direction: "ISSUED", number: "770002", counterparty: "Gulf Supplies LLC",
      writtenOn: "2026-08-02", dueOn: "2026-08-20", amountMinor: bank, settlesId: bill2.id,
    });
    // And one coming the other way, due in the same window.
    const inv = doc("OUTBOUND", { id: "inv-due-1", number: "INV-DUE-1", issueDate: "2026-08-01" }, [line(300_000, 15_000)]);
    await postInvoice({ orgId: ORG, invoice: inv });
    await recordCheque({
      ...scope, direction: "RECEIVED", number: "880001", counterparty: "Al Marri Trading LLC",
      writtenOn: "2026-08-02", dueOn: "2026-08-15", amountMinor: 315_000, settlesId: inv.id,
    });

    const diary = await dueSoon({ ...scope, asOf: "2026-08-05", days: 30 });
    expect(diary.until).toBe("2026-09-04");
    expect(diary.issued.map((c) => c.number)).toContain("770001");
    expect(diary.received.map((c) => c.number)).toContain("880001");

    const first = diary.issued.find((c) => c.number === "770001")!;
    const second = diary.issued.find((c) => c.number === "770002")!;
    expect(first.covered).toBe(true);
    expect(first.cumulativeMinor).toBe(21_000n);
    // The second one is met out of what the first left, not out of the opening
    // balance — and there is not enough.
    expect(second.cumulativeMinor).toBe(21_000n + bank);
    expect(second.covered).toBe(false);
    expect(second.shortfallMinor).toBe(21_000n);
    expect(diary.uncoveredCount).toBe(1);
    expect(diary.firstShortDay).toBe("2026-08-20");
    expect(diary.shortfallMinor).toBe(21_000n);

    // The 315,000 due in from a customer is shown but is not treated as cover:
    // a business that meets its own cheques out of cheques it has been handed
    // is one dishonour away from dishonouring its own.
    expect(diary.received.find((c) => c.number === "880001")!.amountMinor).toBe(315_000n);
    expect(diary.receivedMinor).toBeGreaterThan(diary.shortfallMinor);
    expect(second.covered).toBe(false);
    expect(diary.issuedMinor).toBe(21_000n + bank);

    // A cheque past its date and still not cleared is more urgent than
    // anything in the window, so it is in the diary rather than filtered out.
    const late = await dueSoon({ ...scope, asOf: "2026-09-01", days: 7 });
    expect(late.issued.some((c) => c.number === "770001" && c.daysToDue < 0)).toBe(true);
  });

  it("never lets one organisation or entity reach another's cheques", async () => {
    const mine = await db.cheque.findFirstOrThrow({ where: { orgId: ORG, number: "300100" } });

    // A cheque id is not authority: the same id, read as another tenant, is not there.
    await expect(chequeDetail({ orgId: OTHER_ORG, entityId: OTHER_ENT, chequeId: mine.id }))
      .rejects.toThrow(/does not exist/i);
    await expect(chequeDetail({ orgId: OTHER_ORG, entityId: ENT, chequeId: mine.id }))
      .rejects.toThrow(/does not exist/i);
    // Right org, wrong entity — a group's other company cannot bank this cheque.
    await expect(chequeDetail({ orgId: ORG, entityId: OTHER_ENT, chequeId: mine.id }))
      .rejects.toThrow(/does not exist/i);
    await expect(clearCheque({ orgId: ORG, entityId: OTHER_ENT, chequeId: mine.id, on: "2026-07-06" }))
      .rejects.toThrow(/does not exist/i);
    await expect(bounceCheque({ orgId: OTHER_ORG, entityId: OTHER_ENT, chequeId: mine.id, on: "2026-07-06", reason: "not ours" }))
      .rejects.toThrow(/does not exist/i);

    // The other org's register is its own, and the same cheque number is free there.
    const theirs = await chequeRegister({ orgId: OTHER_ORG, entityId: OTHER_ENT, asOf: "2026-07-31" });
    expect(theirs.received.count + theirs.issued.count).toBe(0);
    expect(theirs.received.ledgerMinor).toBe(0n);

    const clash = await recordCheque({
      orgId: OTHER_ORG, entityId: OTHER_ENT, direction: "RECEIVED", number: "300100",
      counterparty: "Someone else", writtenOn: "2026-01-06", dueOn: "2026-07-06", amountMinor: 1_000,
    });
    expect(clash.chequeId).not.toBe(mine.id);
    expect(await balanceOf("1060", OTHER_ORG)).toBe(1_000n);
    expect(await balanceOf("1060", ORG)).not.toBe(1_000n);
  });

  it("keeps the trial balance tied after everything above", async () => {
    for (const label of ["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"]) {
      const tb = await trialBalance({ orgId: ORG, entityId: ENT, periodLabel: label });
      expect(tb.balanced).toBe(true);
      expect(tb.differenceMinor).toBe(0n);
    }
  });
});
