import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { postInvoice, postReceipt, postCustomerReceipt, receivablesAgeing } from "@/lib/server/ledger/ar";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { trialBalance } from "@/lib/server/ledger/reports";
import { LedgerError } from "@/lib/server/ledger/post";
import type { Invoice, InvoiceLine, TaxProfileCode } from "@/lib/domain/types";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-ar";
const ENT = "t-ent-ar";

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
  ]);
}

let seq = 0;
function line(net: number, vat: number, profile: TaxProfileCode = "STANDARD_5"): InvoiceLine {
  return {
    id: `l${++seq}`, lineNo: seq, description: "Consulting", qty: 1, unitCode: "C62",
    unitPriceMinor: net, taxProfileCode: profile, lineNetMinor: net, lineVatMinor: vat,
  };
}

function invoice(over: Partial<Invoice> = {}, lines: InvoiceLine[] = [line(100_000, 5_000)]): Invoice {
  const net = lines.reduce((a, l) => a + l.lineNetMinor, 0);
  const vat = lines.reduce((a, l) => a + l.lineVatMinor, 0);
  return {
    id: `inv-${++seq}`, orgId: ORG, entityId: ENT, direction: "OUTBOUND", docType: "TAX_INVOICE",
    number: `INV-${seq}`, issueDate: "2026-03-10", supplyDate: "2026-03-10", currency: "AED",
    buyer: { nameEn: "Al Marri Trading LLC" }, seller: { nameEn: "Our Company" },
    lines,
    totals: { taxExclusiveMinor: net, vatMinor: vat, taxInclusiveMinor: net + vat, payableMinor: net + vat, perCategory: [] },
    lifecycleStatus: "SENT", exchangeStatus: "NOT_SENT", reportingStatusC2: "NOT_REPORTED",
    source: "EDITOR",
    compliance: { taxableEventDate: "2026-03-10", daysRemaining: 14, breached: false },
    createdAt: "2026-03-10T00:00:00Z", updatedAt: "2026-03-10T00:00:00Z",
    ...over,
  } as Invoice;
}

/** Every line as posted, in order — a multi-invoice receipt has several on one account. */
async function allLinesOf(entryId: string) {
  const rows = await db.journalLine.findMany({
    where: { entryId }, include: { account: true }, orderBy: { lineNo: "asc" },
  });
  return rows.map((r) => ({ code: r.account.code, amount: r.txnAmountMinor, settles: r.settlesId, memo: r.memo }));
}

async function linesOf(entryId: string) {
  const rows = await db.journalLine.findMany({
    where: { entryId }, include: { account: true }, orderBy: { lineNo: "asc" },
  });
  return Object.fromEntries(rows.map((r) => [r.account.code, r.txnAmountMinor]));
}

d("receivables subledger", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("nets a credit note against the one invoice it names", async () => {
    const inv = invoice({ number: "INV-CR-BASE" });
    await postInvoice({ orgId: ORG, invoice: inv });

    const note = invoice({
      number: "CRN-1",
      docType: "TAX_CREDIT_NOTE",
      precedingInvoices: [{ number: inv.number, invoiceId: inv.id }],
    }, [line(40_000, 2_000)]);
    await postInvoice({ orgId: ORG, invoice: note });

    const ageing = await receivablesAgeing({ orgId: ORG, entityId: ENT, asOf: new Date("2026-04-30") });
    const item = ageing.open.find((i) => i.sourceId === inv.id);
    // 105,000 invoiced less the 42,000 credit note leaves 63,000 outstanding
    // on one open item, not two items of 105,000 and (42,000).
    expect(item?.outstandingMinor).toBe("63000");
    expect(ageing.open.some((i) => i.outstandingMinor === "-42000")).toBe(false);
  });

  it("leaves a credit note standing alone where it names more than one invoice", async () => {
    const a = invoice({ number: "INV-CR-A" });
    const b = invoice({ number: "INV-CR-B" });
    await postInvoice({ orgId: ORG, invoice: a });
    await postInvoice({ orgId: ORG, invoice: b });

    // Spreading it across two invoices would be arithmetic presented as a
    // decision. It stands alone, which is visibly incomplete rather than
    // confidently wrong.
    const note = invoice({
      number: "CRN-2",
      docType: "TAX_CREDIT_NOTE",
      precedingInvoices: [
        { number: a.number, invoiceId: a.id },
        { number: b.number, invoiceId: b.id },
      ],
    }, [line(10_000, 500)]);
    await postInvoice({ orgId: ORG, invoice: note });

    const ageing = await receivablesAgeing({ orgId: ORG, entityId: ENT, asOf: new Date("2026-04-30") });
    expect(ageing.open.some((i) => i.outstandingMinor === "-10500")).toBe(true);
  });

  it("does not guess from an invoice named only by number", async () => {
    const c = invoice({ number: "INV-CR-C" });
    await postInvoice({ orgId: ORG, invoice: c });
    const note = invoice({
      number: "CRN-3",
      docType: "TAX_CREDIT_NOTE",
      precedingInvoices: [{ number: c.number }],
    }, [line(5_000, 250)]);
    await postInvoice({ orgId: ORG, invoice: note });

    const ageing = await receivablesAgeing({ orgId: ORG, entityId: ENT, asOf: new Date("2026-04-30") });
    // Two documents can carry the same number in different years, so a number
    // alone is not an identity.
    expect(ageing.open.some((i) => i.outstandingMinor === "-5250")).toBe(true);
  });

  it("posts margin-scheme tax out of revenue, never on top of the invoice", async () => {
    // A used car bought for AED 30,000 and sold for AED 35,000. Executive
    // Regulation Article 43 forbids the invoice showing any tax, so the
    // customer pays 3,500,000 fils and nothing more — but Article 29 still
    // makes the business owe 5/105 of the 500,000 margin, which is 23,810.
    // That has to come out of the revenue, not be added to the payable amount.
    const margin: InvoiceLine = {
      id: "lm", lineNo: 1, description: "Used vehicle", qty: 1, unitCode: "C62",
      unitPriceMinor: 3_500_000, taxProfileCode: "MARGIN_SCHEME",
      lineNetMinor: 3_500_000, lineVatMinor: 0, marginPurchaseMinor: 3_000_000,
    };
    const inv = invoice({ number: "INV-MARGIN", docType: "COMMERCIAL_INVOICE" }, [margin]);
    const r = await postInvoice({ orgId: ORG, invoice: inv });
    const l = await linesOf(r.entryId);

    expect(l["1100"]).toBe(3_500_000n);        // the customer owes the whole price
    expect(l["4000"]).toBe(-3_476_190n);       // revenue is the price less the tax in it
    expect(l["2100"]).toBe(-23_810n);          // and the FTA is owed the rest
    // Which is the same total: nothing was added to what the customer pays.
    expect(-(l["4000"] + l["2100"])).toBe(3_500_000n);
  });

  it("takes the margin tax only off the accounts the margin lines credit", async () => {
    const margin: InvoiceLine = {
      id: "lm2", lineNo: 1, description: "Used vehicle", qty: 1, unitCode: "C62",
      unitPriceMinor: 3_500_000, taxProfileCode: "MARGIN_SCHEME",
      lineNetMinor: 3_500_000, lineVatMinor: 0, marginPurchaseMinor: 3_000_000,
    };
    // An export line credits 4200, and the margin tax must not touch it.
    const exportLine = line(200_000, 0, "ZERO_EXPORT");
    const inv = invoice({ number: "INV-MARGIN-MIX", docType: "COMMERCIAL_INVOICE" }, [margin, exportLine]);
    const r = await postInvoice({ orgId: ORG, invoice: inv });
    const l = await linesOf(r.entryId);

    expect(l["1100"]).toBe(3_700_000n);
    expect(l["4200"]).toBe(-200_000n);
    expect(l["4000"]).toBe(-3_476_190n);
    expect(l["2100"]).toBe(-23_810n);
  });

  it("posts nothing extra where the margin is nil or the cost is unknown", async () => {
    const atCost: InvoiceLine = {
      id: "lm3", lineNo: 1, description: "Used vehicle", qty: 1, unitCode: "C62",
      unitPriceMinor: 3_000_000, taxProfileCode: "MARGIN_SCHEME",
      lineNetMinor: 3_000_000, lineVatMinor: 0, marginPurchaseMinor: 3_000_000,
    };
    const sold = await postInvoice({
      orgId: ORG, invoice: invoice({ number: "INV-MARGIN-NIL", docType: "COMMERCIAL_INVOICE" }, [atCost]),
    });
    const l = await linesOf(sold.entryId);
    expect(l["4000"]).toBe(-3_000_000n);
    expect(l["2100"]).toBeUndefined();

    // An unrecorded purchase cost is not a cost of nought. Nothing is posted,
    // and the return warns rather than this inventing a margin.
    const unknown: InvoiceLine = { ...atCost, id: "lm4", marginPurchaseMinor: undefined };
    const guess = await postInvoice({
      orgId: ORG, invoice: invoice({ number: "INV-MARGIN-UNK", docType: "COMMERCIAL_INVOICE" }, [unknown]),
    });
    const g = await linesOf(guess.entryId);
    expect(g["4000"]).toBe(-3_000_000n);
    expect(g["2100"]).toBeUndefined();
  });

  it("turns a sales invoice into receivable, revenue and output VAT", async () => {
    const r = await postInvoice({ orgId: ORG, invoice: invoice() });
    expect(r.alreadyPosted).toBe(false);
    expect(await linesOf(r.entryId)).toEqual({
      "1100": 105_000n,   // Dr receivable — gross
      "4000": -100_000n,  // Cr revenue — net
      "2100": -5_000n,    // Cr VAT output
    });
  });

  it("posts the same invoice twice without doubling the revenue", async () => {
    const inv = invoice();
    const first = await postInvoice({ orgId: ORG, invoice: inv });
    const second = await postInvoice({ orgId: ORG, invoice: inv });
    expect(second.alreadyPosted).toBe(true);
    expect(second.entryId).toBe(first.entryId);
    const count = await db.journalEntry.count({ where: { orgId: ORG, sourceId: inv.id } });
    expect(count).toBe(1);
  });

  it("reaches a control account that refuses manual journals", async () => {
    // 1100 is a control account: a hand-written journal is refused, but the
    // subledger that owns it must get through. That distinction is the whole
    // reason control accounts exist.
    const ar = await db.account.findFirst({ where: { orgId: ORG, entityId: ENT, code: "1100" } });
    expect(ar?.isControl).toBe(true);
    const r = await postInvoice({ orgId: ORG, invoice: invoice() });
    const entry = await db.journalEntry.findUnique({ where: { id: r.entryId } });
    expect(entry?.source).toBe("invoice");
  });

  it("splits revenue by tax treatment and collapses repeats", async () => {
    // Four lines, two treatments — the ledger should show two revenue lines,
    // because it records what happened to the business, not the document.
    const r = await postInvoice({
      orgId: ORG,
      invoice: invoice({}, [
        line(50_000, 2_500, "STANDARD_5"),
        line(30_000, 1_500, "STANDARD_5"),
        line(20_000, 0, "ZERO_EXPORT"),
        line(10_000, 0, "ZERO_EXPORT"),
      ]),
    });
    expect(await linesOf(r.entryId)).toEqual({
      "1100": 114_000n,
      "4000": -80_000n,   // the two standard-rated lines, summed
      "4200": -30_000n,   // the two export lines, summed
      "2100": -4_000n,
    });
  });

  it("flips every side for a credit note", async () => {
    const r = await postInvoice({
      orgId: ORG,
      invoice: invoice({ docType: "TAX_CREDIT_NOTE", number: "CN-1" }),
    });
    expect(await linesOf(r.entryId)).toEqual({
      "1100": -105_000n,  // Cr receivable — the customer owes less
      "4000": 100_000n,   // Dr revenue — reversed
      "2100": 5_000n,     // Dr VAT output — reclaimed
    });
  });

  it("refuses a document whose lines do not add up to its total", async () => {
    const bad = invoice({}, [line(100_000, 5_000)]);
    bad.totals.payableMinor = 200_000; // the document contradicts itself
    await expect(postInvoice({ orgId: ORG, invoice: bad })).rejects.toThrow(/does not add up/i);
  });

  it("refuses a foreign-currency invoice with no exchange rate", async () => {
    const usd = invoice({ currency: "USD", number: "INV-USD" });
    await expect(postInvoice({ orgId: ORG, invoice: usd })).rejects.toThrow(/exchange rate/i);
  });

  it("refuses to post a purchase invoice through the receivables subledger", async () => {
    const bill = invoice({ direction: "INBOUND" });
    await expect(postInvoice({ orgId: ORG, invoice: bill })).rejects.toThrow(LedgerError);
  });

  it("settles a receipt against the receivable", async () => {
    const inv = invoice({ number: "INV-PAY" });
    await postInvoice({ orgId: ORG, invoice: inv });
    const r = await postReceipt({
      orgId: ORG, entityId: ENT, invoiceId: inv.id, invoiceNumber: inv.number,
      paymentId: "pay-1", receivedOn: "2026-03-20", bankAmountMinor: 105_000,
    });
    expect(await linesOf(r.entryId)).toEqual({ "1010": 105_000n, "1100": -105_000n });
  });

  it("books a realised exchange difference when the bank and the invoice disagree", async () => {
    const inv = invoice({ number: "INV-FX" });
    await postInvoice({ orgId: ORG, invoice: inv });
    // The receivable carried 105,000 fils; 105,250 arrived.
    const r = await postReceipt({
      orgId: ORG, entityId: ENT, invoiceId: inv.id, invoiceNumber: inv.number,
      paymentId: "pay-fx", receivedOn: "2026-03-25",
      bankAmountMinor: 105_250, clearedAmountMinor: 105_000,
    });
    expect(await linesOf(r.entryId)).toEqual({
      "1010": 105_250n,
      "1100": -105_000n,
      "4950": -250n,   // the gain is booked, not hidden in the bank line
    });
  });

  it("does not post the same receipt twice", async () => {
    const inv = invoice({ number: "INV-DUP" });
    await postInvoice({ orgId: ORG, invoice: inv });
    const args = {
      orgId: ORG, entityId: ENT, invoiceId: inv.id, invoiceNumber: inv.number,
      paymentId: "pay-dup", receivedOn: "2026-03-26", bankAmountMinor: 105_000,
    };
    const a = await postReceipt(args);
    const b = await postReceipt(args);
    expect(b.alreadyPosted).toBe(true);
    expect(b.entryId).toBe(a.entryId);
  });

  it("leaves the unpaid balance of a partly-settled invoice open", async () => {
    // The case open-item ageing exists for: pay half, and half is still owed.
    const inv = invoice({ number: "INV-PART" });
    await postInvoice({ orgId: ORG, invoice: inv });
    await postReceipt({
      orgId: ORG, entityId: ENT, invoiceId: inv.id, invoiceNumber: inv.number,
      paymentId: "pay-part", receivedOn: "2026-03-22", bankAmountMinor: 40_000,
    });
    const ageing = await receivablesAgeing({ orgId: ORG, entityId: ENT, asOf: new Date("2026-03-31") });
    const open = ageing.open.find((o) => o.sourceId === inv.id);
    expect(open?.outstandingMinor).toBe("65000"); // 105,000 raised less 40,000 received
    // The item ages from the invoice date, not from the date of the receipt.
    expect(open?.date).toBe("2026-03-10");
    expect(open?.daysOld).toBe(21);
  });

  it("ages the receivable and drops what has been settled", async () => {
    const ageing = await receivablesAgeing({ orgId: ORG, entityId: ENT, asOf: new Date("2026-03-31") });
    // Every invoice above is dated 2026-03-10 — 21 days old, so current.
    expect(ageing.buckets.over120).toBe("0");
    expect(ageing.buckets.current).not.toBe("0");
    // Settled invoices net to zero and must not appear as open items.
    const settled = ageing.open.find((o) => o.memo.includes("INV-PAY"));
    expect(settled).toBeUndefined();
    // Unpaid ones must.
    expect(ageing.open.length).toBeGreaterThan(0);
    // The bucket totals have to equal the sum of the open items — an ageing
    // report whose buckets disagree with its own detail is worse than none.
    const detail = ageing.open.reduce((a, o) => a + BigInt(o.outstandingMinor), 0n);
    expect(detail.toString()).toBe(ageing.totalMinor);
  });

  it("ages an old invoice into the right bucket", async () => {
    const old = invoice({ number: "INV-OLD", issueDate: "2026-01-05", supplyDate: "2026-01-05" });
    await postInvoice({ orgId: ORG, invoice: old });
    const ageing = await receivablesAgeing({ orgId: ORG, entityId: ENT, asOf: new Date("2026-05-20") });
    const row = ageing.open.find((o) => o.sourceId === old.id);
    expect(row?.daysOld).toBe(135);
    expect(BigInt(ageing.buckets.over120)).toBeGreaterThanOrEqual(105_000n);
  });

  it("keeps the trial balance tied after everything above", async () => {
    const tb = await trialBalance({ orgId: ORG, entityId: ENT, periodLabel: "2026-03" });
    expect(tb.balanced).toBe(true);
    expect(tb.differenceMinor).toBe(0n);
  });

  /* -------------------------------------- one receipt, several invoices */

  it("posts ONE bank line for a transfer that settles five invoices", async () => {
    // Five invoices of 105,000 fils each — 525,000 in one transfer.
    const invs = [];
    for (let i = 0; i < 5; i++) {
      const inv = invoice({ number: `INV-MULTI-${i}` });
      await postInvoice({ orgId: ORG, invoice: inv });
      invs.push(inv);
    }

    const r = await postCustomerReceipt({
      orgId: ORG, entityId: ENT, paymentId: "pay-multi", receivedOn: "2026-03-28",
      bankAmountMinor: 525_000,
      allocations: invs.map((inv) => ({ invoiceId: inv.id, invoiceNumber: inv.number, clearedMinor: 105_000 })),
    });

    const lines = await allLinesOf(r.entryId);
    // The whole point: the bank statement shows one debit of 525,000, so the
    // ledger shows one line of 525,000. Five would never reconcile.
    const bank = lines.filter((l) => l.code === "1010");
    expect(bank).toHaveLength(1);
    expect(bank[0].amount).toBe(525_000n);

    // And five receivable lines, each naming the invoice it discharges.
    const ar = lines.filter((l) => l.code === "1100");
    expect(ar).toHaveLength(5);
    expect(ar.every((l) => l.amount === -105_000n)).toBe(true);
    expect(new Set(ar.map((l) => l.settles))).toEqual(new Set(invs.map((i) => i.id)));

    // Which is what closes them: five open items gone, not one.
    const ageing = await receivablesAgeing({ orgId: ORG, entityId: ENT, asOf: new Date("2026-03-31") });
    for (const inv of invs) expect(ageing.open.some((o) => o.sourceId === inv.id)).toBe(false);
  });

  it("puts an over-payment on account rather than onto an invoice it does not belong to", async () => {
    const a = invoice({ number: "INV-OVER-A" });
    const b = invoice({ number: "INV-OVER-B" });
    await postInvoice({ orgId: ORG, invoice: a });
    await postInvoice({ orgId: ORG, invoice: b });

    // 210,000 owed, 250,000 arrived. The extra 40,000 is the customer's, and
    // it belongs to no document until somebody says which.
    const r = await postCustomerReceipt({
      orgId: ORG, entityId: ENT, paymentId: "pay-over", receivedOn: "2026-03-29",
      bankAmountMinor: 250_000,
      allocations: [
        { invoiceId: a.id, invoiceNumber: a.number, clearedMinor: 105_000 },
        { invoiceId: b.id, invoiceNumber: b.number, clearedMinor: 105_000 },
      ],
    });
    expect(r.onAccountMinor).toBe(40_000n);

    const lines = await allLinesOf(r.entryId);
    expect(lines.filter((l) => l.code === "1010")).toHaveLength(1);
    const onAccount = lines.filter((l) => l.code === "1100" && l.settles === null);
    expect(onAccount).toHaveLength(1);
    expect(onAccount[0].amount).toBe(-40_000n);

    const ageing = await receivablesAgeing({ orgId: ORG, entityId: ENT, asOf: new Date("2026-03-31") });
    expect(ageing.open.some((o) => o.sourceId === a.id)).toBe(false);
    expect(ageing.open.some((o) => o.sourceId === b.id)).toBe(false);
    // The credit stands as its own open item, keyed on the receipt.
    expect(ageing.open.find((o) => o.sourceId === "pay-over")?.outstandingMinor).toBe("-40000");
  });

  it("leaves a short-paid invoice open for the remainder", async () => {
    const inv = invoice({ number: "INV-SHORT" });
    await postInvoice({ orgId: ORG, invoice: inv });
    await postCustomerReceipt({
      orgId: ORG, entityId: ENT, paymentId: "pay-short", receivedOn: "2026-03-29",
      bankAmountMinor: 60_000,
      allocations: [{ invoiceId: inv.id, invoiceNumber: inv.number, clearedMinor: 60_000 }],
    });
    const ageing = await receivablesAgeing({ orgId: ORG, entityId: ENT, asOf: new Date("2026-03-31") });
    // 105,000 raised less 60,000 received leaves 45,000 on the same item.
    expect(ageing.open.find((o) => o.sourceId === inv.id)?.outstandingMinor).toBe("45000");
  });

  it("books an exchange difference per invoice where each was raised at its own rate", async () => {
    // USD 1,000.00 twice, raised at 3.60 and at 3.70, so the receivable carries
    // 360,000 and 370,000 fils. The customer sends USD 2,000.00 when the rate
    // is 3.75, and AED 750,000 lands — 375,000 against each invoice.
    const usd = (number: string, rate: string) =>
      invoice(
        { number, currency: "USD", fx: { rateToAED: rate, source: "CBUAE", rateDate: "2026-03-10" } },
        [line(100_000, 0, "ZERO_EXPORT")],
      );
    const x = usd("INV-FX-X", "3.60");
    const y = usd("INV-FX-Y", "3.70");
    await postInvoice({ orgId: ORG, invoice: x });
    await postInvoice({ orgId: ORG, invoice: y });

    const r = await postCustomerReceipt({
      orgId: ORG, entityId: ENT, paymentId: "pay-fx-multi", receivedOn: "2026-03-30",
      bankAmountMinor: 750_000,
      allocations: [
        { invoiceId: x.id, invoiceNumber: x.number, clearedMinor: 360_000, receivedMinor: 375_000 },
        { invoiceId: y.id, invoiceNumber: y.number, clearedMinor: 370_000, receivedMinor: 375_000 },
      ],
    });

    const lines = await allLinesOf(r.entryId);
    expect(lines.filter((l) => l.code === "1010")).toHaveLength(1);
    // 375,000 - 360,000 = 15,000 gained on the first; 375,000 - 370,000 = 5,000
    // on the second. Two differences, because there were two rates.
    const gains = lines.filter((l) => l.code === "4950").map((l) => l.amount);
    expect(gains).toEqual([-15_000n, -5_000n]);
    expect(lines.reduce((a, l) => a + l.amount, 0n)).toBe(0n);

    const ageing = await receivablesAgeing({ orgId: ORG, entityId: ENT, asOf: new Date("2026-03-31") });
    expect(ageing.open.some((o) => o.sourceId === x.id)).toBe(false);
    expect(ageing.open.some((o) => o.sourceId === y.id)).toBe(false);
  });

  it("does not net a gain on one invoice against a loss on another", async () => {
    const usd = (number: string, rate: string) =>
      invoice(
        { number, currency: "USD", fx: { rateToAED: rate, source: "CBUAE", rateDate: "2026-03-10" } },
        [line(100_000, 0, "ZERO_EXPORT")],
      );
    const x = usd("INV-FX-G", "3.60");
    const y = usd("INV-FX-L", "3.70");
    await postInvoice({ orgId: ORG, invoice: x });
    await postInvoice({ orgId: ORG, invoice: y });

    // 375,000 applied against a 360,000 receivable is a 15,000 gain; 365,000
    // against 370,000 is a 5,000 loss. Netting them would post 10,000 of gain,
    // which is neither figure and hides both.
    const r = await postCustomerReceipt({
      orgId: ORG, entityId: ENT, paymentId: "pay-fx-mixed", receivedOn: "2026-03-30",
      bankAmountMinor: 740_000,
      allocations: [
        { invoiceId: x.id, invoiceNumber: x.number, clearedMinor: 360_000, receivedMinor: 375_000 },
        { invoiceId: y.id, invoiceNumber: y.number, clearedMinor: 370_000, receivedMinor: 365_000 },
      ],
    });
    const lines = await allLinesOf(r.entryId);
    expect(lines.filter((l) => l.code === "4950").map((l) => l.amount)).toEqual([-15_000n]);
    expect(lines.filter((l) => l.code === "6800").map((l) => l.amount)).toEqual([5_000n]);
    expect(lines.reduce((a, l) => a + l.amount, 0n)).toBe(0n);
  });

  it("refuses to allocate more than arrived, and refuses one invoice twice", async () => {
    const inv = invoice({ number: "INV-BAD-ALLOC" });
    await postInvoice({ orgId: ORG, invoice: inv });

    await expect(postCustomerReceipt({
      orgId: ORG, entityId: ENT, paymentId: "pay-too-much", receivedOn: "2026-03-30",
      bankAmountMinor: 50_000,
      allocations: [{ invoiceId: inv.id, invoiceNumber: inv.number, clearedMinor: 105_000, receivedMinor: 105_000 }],
    })).rejects.toThrow(/only 50000 arrived/i);

    await expect(postCustomerReceipt({
      orgId: ORG, entityId: ENT, paymentId: "pay-dupe-alloc", receivedOn: "2026-03-30",
      bankAmountMinor: 105_000,
      allocations: [
        { invoiceId: inv.id, invoiceNumber: inv.number, clearedMinor: 50_000 },
        { invoiceId: inv.id, invoiceNumber: inv.number, clearedMinor: 55_000 },
      ],
    })).rejects.toThrow(/appears twice/i);
  });

  it("keeps the single-invoice receipt naming its invoice on the entry as well as the line", async () => {
    // Every existing reader was written against the entry-level column. A
    // receipt for one document still fills it, so nothing that read it before
    // stops working; the line-level stamp is what the multi form adds.
    const inv = invoice({ number: "INV-ONE" });
    await postInvoice({ orgId: ORG, invoice: inv });
    const r = await postReceipt({
      orgId: ORG, entityId: ENT, invoiceId: inv.id, invoiceNumber: inv.number,
      paymentId: "pay-one", receivedOn: "2026-03-30", bankAmountMinor: 105_000,
    });
    const entry = await db.journalEntry.findUnique({ where: { id: r.entryId } });
    expect(entry?.settlesId).toBe(inv.id);
    const ar = (await allLinesOf(r.entryId)).filter((l) => l.code === "1100");
    expect(ar).toHaveLength(1);
    expect(ar[0].settles).toBe(inv.id);
  });

  it("keeps the trial balance tied after the multi-invoice receipts", async () => {
    const tb = await trialBalance({ orgId: ORG, entityId: ENT, periodLabel: "2026-03" });
    expect(tb.balanced).toBe(true);
    expect(tb.differenceMinor).toBe(0n);
  });
});
