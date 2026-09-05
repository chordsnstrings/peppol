import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { postInvoice } from "@/lib/server/ledger/ar";
import { postBill } from "@/lib/server/ledger/ap";
import { post, reverse } from "@/lib/server/ledger/post";
import { vatReturn } from "@/lib/server/ledger/vat";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { recordFiling, recordRegistration } from "@/lib/server/ledger/tax-periods";
import type { Invoice, InvoiceLine, TaxProfileCode } from "@/lib/domain/types";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-vat";
const ENT = "t-ent-vat";

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
    db.$executeRawUnsafe(`DELETE FROM "TaxFiling" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "TaxRegistration" WHERE "orgId" = '${ORG}'`),
  ]);
}

let seq = 0;
const line = (net: number, vat: number, profile: TaxProfileCode = "STANDARD_5"): InvoiceLine => ({
  id: `l${++seq}`, lineNo: seq, description: "Item", qty: 1, unitCode: "C62",
  unitPriceMinor: net, taxProfileCode: profile, lineNetMinor: net, lineVatMinor: vat,
});

function doc(direction: "OUTBOUND" | "INBOUND", lines: InvoiceLine[], over: Partial<Invoice> = {}): Invoice {
  const net = lines.reduce((a, l) => a + l.lineNetMinor, 0);
  const vat = lines.reduce((a, l) => a + l.lineVatMinor, 0);
  return {
    id: `d-${++seq}`, orgId: ORG, entityId: ENT, direction, docType: "TAX_INVOICE",
    number: `DOC-${seq}`, issueDate: "2026-05-15", supplyDate: "2026-05-15", currency: "AED",
    buyer: { nameEn: "Buyer" }, seller: { nameEn: "Seller", address: { emirate: "DU" } },
    lines,
    totals: { taxExclusiveMinor: net, vatMinor: vat, taxInclusiveMinor: net + vat, payableMinor: net + vat, perCategory: [] },
    lifecycleStatus: "SENT", exchangeStatus: "NOT_SENT", reportingStatusC2: "NOT_REPORTED", source: "EDITOR",
    compliance: { taxableEventDate: "2026-05-15", daysRemaining: 14, breached: false },
    createdAt: "2026-05-15T00:00:00Z", updatedAt: "2026-05-15T00:00:00Z",
    ...over,
  } as Invoice;
}

const box = (r: Awaited<ReturnType<typeof vatReturn>>, which: "sales" | "expenses", n: string) =>
  r[which].find((b) => b.box === n)!;

d("VAT 201 return", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });

    // A quarter's trading: standard-rated sales, an export, a standard-rated
    // purchase, and an imported service under reverse charge.
    await postInvoice({ orgId: ORG, invoice: doc("OUTBOUND", [line(1_000_000, 50_000)]) });
    await postInvoice({ orgId: ORG, invoice: doc("OUTBOUND", [line(400_000, 0, "ZERO_EXPORT")]) });
    await postBill({ orgId: ORG, bill: doc("INBOUND", [line(200_000, 10_000)]) });
    await postBill({ orgId: ORG, bill: doc("INBOUND", [line(100_000, 0, "REVERSE_CHARGE")]) });
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("puts standard-rated sales and their tax on the emirate row of box 1", async () => {
    const r = await vatReturn({ orgId: ORG, entityId: ENT, from: "2026-05-01", to: "2026-05-31" });
    // The seller is registered in Dubai, so the supply is on row 1b. The FTA
    // splits box 1 seven ways because the tax is distributed between the
    // emirates on that basis.
    expect(box(r, "sales", "1b").amountMinor).toBe("1000000");
    expect(box(r, "sales", "1b").vatMinor).toBe("50000");
    // And on none of the other six.
    for (const b of ["1a", "1c", "1d", "1e", "1f", "1g", "1x"]) {
      expect(box(r, "sales", b).amountMinor).toBe("0");
      expect(box(r, "sales", b).vatMinor).toBe("0");
    }
  });

  it("puts zero-rated exports in box 4 with no tax figure at all", async () => {
    const r = await vatReturn({ orgId: ORG, entityId: ENT, from: "2026-05-01", to: "2026-05-31" });
    expect(box(r, "sales", "4").amountMinor).toBe("400000");
    // Not "0.00" — a zero-rated box has no tax, and saying so is different
    // from reporting a computed zero.
    expect(box(r, "sales", "4").vatMinor).toBeNull();
  });

  it("reports reverse-charge purchases on both sides, as the FTA requires", async () => {
    const r = await vatReturn({ orgId: ORG, entityId: ENT, from: "2026-05-01", to: "2026-05-31" });
    // Box 3 — the supply the buyer must self-account for.
    expect(box(r, "sales", "3").vatMinor).toBe("5000");
    // Box 10 — the same amount, recoverable.
    expect(box(r, "expenses", "10").amountMinor).toBe("100000");
    expect(box(r, "expenses", "10").vatMinor).toBe("5000");
  });

  it("puts standard-rated purchases and their recoverable tax in box 9", async () => {
    const r = await vatReturn({ orgId: ORG, entityId: ENT, from: "2026-05-01", to: "2026-05-31" });
    expect(box(r, "expenses", "9").amountMinor).toBe("200000");
    expect(box(r, "expenses", "9").vatMinor).toBe("10000");
  });

  it("computes the net position", async () => {
    const r = await vatReturn({ orgId: ORG, entityId: ENT, from: "2026-05-01", to: "2026-05-31" });
    // Output: 50,000 on sales + 5,000 self-accounted. Input: 10,000 charged +
    // 5,000 reclaimed. Net 40,000 payable.
    expect(r.totalOutputVatMinor).toBe("55000");
    expect(r.totalInputVatMinor).toBe("15000");
    expect(r.netVatMinor).toBe("40000");
    expect(r.payable).toBe(true);
  });

  it("reconciles to the VAT control accounts", async () => {
    const r = await vatReturn({ orgId: ORG, entityId: ENT, from: "2026-05-01", to: "2026-05-31" });
    expect(r.reconciliation.outputMatches).toBe(true);
    expect(r.reconciliation.inputMatches).toBe(true);
    expect(r.reconciliation.outputVatPerLedgerMinor).toBe(r.totalOutputVatMinor);
    expect(r.warnings).toEqual([]);
  });

  it("excludes anything outside the period", async () => {
    const r = await vatReturn({ orgId: ORG, entityId: ENT, from: "2026-06-01", to: "2026-06-30" });
    expect(r.totalOutputVatMinor).toBe("0");
    expect(r.netVatMinor).toBe("0");
  });

  it("warns about revenue posted without a tax treatment rather than hiding it", async () => {
    // A hand-written journal straight to revenue carries no tax code. Silently
    // leaving it out of the return is how output tax gets understated.
    await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-05-20", source: "manual",
      memo: "Miscellaneous income",
      lines: [{ account: "1010", debit: 30_000 }, { account: "4900", credit: 30_000 }],
    });
    const r = await vatReturn({ orgId: ORG, entityId: ENT, from: "2026-05-01", to: "2026-05-31" });
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings[0]).toMatch(/no tax treatment/i);
    expect(r.warnings[0]).toMatch(/4900/);
  });

  it("reports a reclaim as a negative net rather than as a payment", async () => {
    await postBill({
      orgId: ORG,
      bill: doc("INBOUND", [line(2_000_000, 100_000)], { issueDate: "2026-07-10", supplyDate: "2026-07-10" }),
    });
    const r = await vatReturn({ orgId: ORG, entityId: ENT, from: "2026-07-01", to: "2026-07-31" });
    expect(r.netVatMinor).toBe("-100000");
    expect(r.payable).toBe(false);
  });

  it("takes a reversed invoice off the return along with its reversal", async () => {
    // A reversed entry's lines are real postings; the reversing entry offsets
    // them. Counting only "posted" drops the original and keeps the reversal,
    // so reversing a sale would leave NEGATIVE output tax on the return — an
    // understatement that looks like a legitimate credit.
    const before = await vatReturn({ orgId: ORG, entityId: ENT, from: "2026-08-01", to: "2026-08-31" });
    expect(before.totalOutputVatMinor).toBe("0");

    const e = await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-08-10", source: "invoice", memo: "Sale to reverse",
      lines: [
        { account: "1010", debit: 105_000 },
        { account: "4000", credit: 100_000, taxCode: "STANDARD_5" },
        { account: "2100", credit: 5_000, taxCode: "OUTPUT_VAT" },
      ],
    });
    const withSale = await vatReturn({ orgId: ORG, entityId: ENT, from: "2026-08-01", to: "2026-08-31" });
    expect(withSale.totalOutputVatMinor).toBe("5000");

    await reverse({ orgId: ORG, entryId: e.id, entryDate: "2026-08-12" });
    const after = await vatReturn({ orgId: ORG, entityId: ENT, from: "2026-08-01", to: "2026-08-31" });
    expect(after.totalOutputVatMinor).toBe("0");
    expect(after.reconciliation.outputMatches).toBe(true);
  });

  it("keeps a designated-zone supply of goods off box 4 and reports it separately", async () => {
    // Article 51 of Federal Decree-Law 8/2017 and Article 51 of the Executive
    // Regulation treat a designated zone as outside the State for goods, so the
    // supply is outside the scope. Box 4 is zero-rated supplies, which are IN
    // scope at a rate of nothing — putting the zone figure there overstates the
    // taxable supplies the business declares it made.
    //
    // AED 4,000 zero-rated export and AED 2,500 of goods sold inside a zone.
    // Box 4 must read 400,000 fils, not 650,000.
    await postInvoice({
      orgId: ORG,
      invoice: doc("OUTBOUND", [line(400_000, 0, "ZERO_EXPORT")], { issueDate: "2026-09-05", supplyDate: "2026-09-05" }),
    });
    await postInvoice({
      orgId: ORG,
      invoice: doc("OUTBOUND", [line(250_000, 0, "DESIGNATED_ZONE")], { issueDate: "2026-09-08", supplyDate: "2026-09-08" }),
    });

    const r = await vatReturn({ orgId: ORG, entityId: ENT, from: "2026-09-01", to: "2026-09-30" });
    expect(box(r, "sales", "4").amountMinor).toBe("400000");
    expect(box(r, "sales", "4").vatMinor).toBeNull();
    // On no other box either.
    expect(box(r, "sales", "1b").amountMinor).toBe("0");
    expect(box(r, "sales", "3").amountMinor).toBe("0");
    expect(box(r, "sales", "5").amountMinor).toBe("0");

    const dz = r.outsideTheReturn.find((o) => o.taxCode === "DESIGNATED_ZONE")!;
    expect(dz.amountMinor).toBe("250000");
    // And it says the thing a bookkeeper has to know: services in a zone are
    // not out of scope at all.
    expect(dz.note).toMatch(/SERVICES/);
    expect(dz.note).toMatch(/standard rated/i);
    expect(dz.note).toMatch(/Article 51/);
  });

  it("puts a capital asset adjustment in box 9's adjustment column, not its VAT column", async () => {
    // AED 2,000 of standard-rated purchases bearing AED 100 of tax, and an
    // AED 300 capital asset adjustment under Executive Regulation Articles 57
    // and 58, which restates tax on a supply years old and no supply of this
    // period. Box 9 must read 200,000 net, 10,000 VAT and 30,000 adjustment —
    // and 40,000 of input tax in total, which is what it was before.
    await postBill({
      orgId: ORG,
      bill: doc("INBOUND", [line(200_000, 10_000)], { issueDate: "2026-10-04", supplyDate: "2026-10-04" }),
    });
    await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-10-20",
      // Not "manual": 1350 is a control account and the database refuses a
      // manual journal against one. This is the shape `vat-schemes.ts` posts.
      source: "vat",
      sourceType: "CAPITAL_ASSET_ADJUSTMENT",
      memo: "Capital asset adjustment — interval 3",
      lines: [
        { account: "1350", debit: 30_000, taxCode: "INPUT_VAT" },
        { account: "6900", credit: 30_000 },
      ],
    });

    const r = await vatReturn({ orgId: ORG, entityId: ENT, from: "2026-10-01", to: "2026-10-31" });
    const box9 = box(r, "expenses", "9");
    expect(box9.amountMinor).toBe("200000");
    expect(box9.vatMinor).toBe("10000");
    expect(box9.adjustmentMinor).toBe("30000");
    // The layout changed; the total did not.
    expect(r.totalInputVatMinor).toBe("40000");
    expect(BigInt(box9.vatMinor!) + BigInt(box9.adjustmentMinor!)).toBe(40_000n);
    expect(r.reconciliation.inputMatches).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it("says which boxes it does not report an adjustment column for, rather than reporting a nil", async () => {
    const r = await vatReturn({ orgId: ORG, entityId: ENT, from: "2026-10-01", to: "2026-10-31" });
    // The real VAT 201 carries an Adjustment column on more boxes than box 9.
    // Nothing in this codebase establishes which, and nothing posts into one,
    // so they report null — "not reported here" — instead of a nought that
    // would read as "there were no adjustments".
    for (const b of r.sales) expect(b.adjustmentMinor).toBeNull();
    expect(box(r, "expenses", "10").adjustmentMinor).toBeNull();
  });

  it("warns that a margin-scheme supply carries tax the ledger never saw", async () => {
    // A used car sold for AED 35,000, bought for AED 30,000. The invoice states
    // no tax (Executive Regulation Article 43), so nothing reaches 2100 — but
    // AED 238.10 of output tax is still due on the margin under Article 29.
    // The return can see the supply and cannot see the purchase price, so it
    // says so rather than reporting a nil and letting it be filed.
    await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-11-09", source: "invoice",
      memo: "Used vehicle — profit margin scheme",
      lines: [
        { account: "1010", debit: 3_500_000 },
        { account: "4000", credit: 3_500_000, taxCode: "MARGIN_SCHEME" },
      ],
    });
    const r = await vatReturn({ orgId: ORG, entityId: ENT, from: "2026-11-01", to: "2026-11-30" });
    // Not silently folded into box 1 with the standard-rated supplies.
    expect(box(r, "sales", "1b").amountMinor).toBe("0");
    const w = r.warnings.find((x) => /profit margin scheme/i.test(x))!;
    expect(w).toMatch(/5\/105/);
    expect(w).toMatch(/Article 29/);
    // It names the input that is actually missing, which is the purchase price
    // on the line — not a manual journal to 2100, which the ledger refuses.
    expect(w).toMatch(/purchase price/i);
  });

  it("says nothing about the margin scheme once the tax on the margin has been posted", async () => {
    // The same used car, sold in a month of its own, with the purchase price
    // entered so `postInvoice` works the tax out: 5/105 of the 5,000 margin is
    // 238.10, taken out of revenue rather than added to the invoice, because
    // the customer was told the document carries no tax.
    //
    // Warning on the presence of margin supplies alone would cry wolf on every
    // correctly handled period from here on, and a return whose warnings are
    // usually wrong is a return whose warnings are not read.
    await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-10-09", source: "invoice",
      memo: "Used vehicle — profit margin scheme",
      lines: [
        { account: "1010", debit: 3_500_000 },
        { account: "4000", credit: 3_476_190, taxCode: "MARGIN_SCHEME" },
        {
          account: "2100", credit: 23_810, taxCode: "OUTPUT_VAT",
          memo: "VAT on the margin — not charged to the customer",
        },
      ],
    });
    const r = await vatReturn({ orgId: ORG, entityId: ENT, from: "2026-10-01", to: "2026-10-31" });
    expect(r.warnings.find((x) => /profit margin scheme/i.test(x))).toBeUndefined();
    // And the tax is on the return, because it is output tax like any other.
    expect(BigInt(r.totalOutputVatMinor)).toBe(23_810n);
  });

  it("refuses a period that ends before it starts", async () => {
    await expect(vatReturn({ orgId: ORG, entityId: ENT, from: "2026-05-31", to: "2026-05-01" }))
      .rejects.toThrow(/ends before it starts/i);
  });

  it("splits box 1 between the emirates the supplies were made in", async () => {
    // The VAT 201 splits standard-rated supplies seven ways because the tax on
    // them is distributed between the emirates on that basis, so this is not
    // presentation — it decides where the money goes.
    //
    // April: AED 10,000 supplied from Dubai, AED 4,000 from Sharjah and
    // AED 2,000 from an establishment whose emirate nobody recorded. Rows
    // 1b, 1c and the unattributed row read 1,000,000, 400,000 and 200,000, and
    // the tax on them 50,000, 20,000 and 10,000 — 80,000 in all, which is what
    // one flat box 1 used to report on its own.
    const april = { issueDate: "2026-04-10", supplyDate: "2026-04-10" };
    await postInvoice({ orgId: ORG, invoice: doc("OUTBOUND", [line(1_000_000, 50_000)], april) });
    await postInvoice({
      orgId: ORG,
      invoice: doc("OUTBOUND", [line(400_000, 20_000)], {
        ...april,
        seller: { nameEn: "Seller", address: { emirate: "SH", country: "AE" } },
      }),
    });
    await postInvoice({
      orgId: ORG,
      invoice: doc("OUTBOUND", [line(200_000, 10_000)], { ...april, seller: { nameEn: "Seller" } }),
    });

    const r = await vatReturn({ orgId: ORG, entityId: ENT, from: "2026-04-01", to: "2026-04-30" });
    expect(box(r, "sales", "1b").label).toBe("Standard rated supplies in Dubai");
    expect(box(r, "sales", "1b").amountMinor).toBe("1000000");
    expect(box(r, "sales", "1b").vatMinor).toBe("50000");
    expect(box(r, "sales", "1c").label).toBe("Standard rated supplies in Sharjah");
    expect(box(r, "sales", "1c").amountMinor).toBe("400000");
    expect(box(r, "sales", "1c").vatMinor).toBe("20000");

    // The unattributed supplies are shown as their own row and are NOT spread
    // across the seven. Spreading them would move real money between real
    // emirates on the strength of an assumption.
    expect(box(r, "sales", "1x").amountMinor).toBe("200000");
    expect(box(r, "sales", "1x").vatMinor).toBe("10000");
    expect(box(r, "sales", "1a").amountMinor).toBe("0");

    // The split is a split: the rows still add to the whole.
    const rows = ["1a", "1b", "1c", "1d", "1e", "1f", "1g", "1x"];
    const supplies = rows.reduce((a, b) => a + BigInt(box(r, "sales", b).amountMinor), 0n);
    const tax = rows.reduce((a, b) => a + BigInt(box(r, "sales", b).vatMinor!), 0n);
    expect(supplies).toBe(1_600_000n);
    expect(tax).toBe(80_000n);
    expect(r.totalOutputVatMinor).toBe("80000");

    const w = r.warnings.find((x) => /none of the seven rows of box 1/.test(x))!;
    expect(w).toMatch(/200000/);
    expect(w).toMatch(/has not been spread/i);
  });

  it("says an emirate it does not recognise is unrecognised rather than picking one", async () => {
    // A typo that lands in Ajman is a typo that sends Ajman money.
    await postInvoice({
      orgId: ORG,
      invoice: doc("OUTBOUND", [line(100_000, 5_000)], {
        issueDate: "2026-02-09", supplyDate: "2026-02-09",
        seller: { nameEn: "Seller", address: { emirate: "XX", country: "AE" } },
      }),
    });
    const r = await vatReturn({ orgId: ORG, entityId: ENT, from: "2026-02-01", to: "2026-02-28" });
    expect(box(r, "sales", "1x").amountMinor).toBe("100000");
    for (const b of ["1a", "1b", "1c", "1d", "1e", "1f", "1g"]) {
      expect(box(r, "sales", b).amountMinor).toBe("0");
    }
    expect(r.warnings.find((x) => /XX/.test(x))).toMatch(/not an emirate/i);
  });

  it("reports imported goods in box 6 and recovers the tax in box 10", async () => {
    // AED 5,000 of goods imported. The overseas supplier charges no UAE VAT;
    // Article 48 of Federal Decree-Law 8/2017 puts the tax on the importer, who
    // declares AED 250 of output tax and reclaims the same AED 250 — so the
    // return moves by nothing and the transaction still appears on both sides.
    // Before this the treatment had no tax code at all and the transaction could
    // not be reported at any figure.
    await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-12-04",
      // Not "manual": 2000, 2100 and 1350 are control accounts and the ledger
      // refuses a manual journal against one. This is the shape a bill posts.
      source: "bill", memo: "Import of goods — customs declaration 12345",
      lines: [
        { account: "6900", debit: 500_000, taxCode: "IMPORT_GOODS" },
        { account: "1350", debit: 25_000, taxCode: "IMPORT_INPUT_VAT" },
        { account: "2000", credit: 500_000 },
        { account: "2100", credit: 25_000, taxCode: "IMPORT_OUTPUT_VAT" },
      ],
    });
    // And AED 1,000 of adjustment to an earlier import. Box 6 is pre-populated
    // by the FTA from customs and cannot be edited, so a correction to it has
    // to go in box 7 — which is what the source type on the entry says it is.
    await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-12-18",
      source: "bill", sourceType: "IMPORT_ADJUSTMENT",
      memo: "Adjustment to an earlier import",
      lines: [
        { account: "6900", debit: 100_000, taxCode: "IMPORT_GOODS" },
        { account: "1350", debit: 5_000, taxCode: "IMPORT_INPUT_VAT" },
        { account: "2000", credit: 100_000 },
        { account: "2100", credit: 5_000, taxCode: "IMPORT_OUTPUT_VAT" },
      ],
    });

    const r = await vatReturn({ orgId: ORG, entityId: ENT, from: "2026-12-01", to: "2026-12-31" });
    expect(box(r, "sales", "6").amountMinor).toBe("500000");
    expect(box(r, "sales", "6").vatMinor).toBe("25000");
    expect(box(r, "sales", "7").amountMinor).toBe("100000");
    expect(box(r, "sales", "7").vatMinor).toBe("5000");
    // Not in box 9 with the ordinary standard-rated expenses.
    expect(box(r, "expenses", "9").amountMinor).toBe("0");
    // Recovered in box 10 with the rest of the reverse-charge input tax.
    expect(box(r, "expenses", "10").amountMinor).toBe("600000");
    expect(box(r, "expenses", "10").vatMinor).toBe("30000");

    expect(r.totalOutputVatMinor).toBe("30000");
    expect(r.totalInputVatMinor).toBe("30000");
    expect(r.netVatMinor).toBe("0");
    // The point of the whole exercise: the self-reconciliation used to report
    // that the return agreed with 2100 and 1350 while carrying no import box at
    // all, so it confirmed a return that could not be filed.
    expect(r.reconciliation.outputMatches).toBe(true);
    expect(r.reconciliation.inputMatches).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it("warns when goods are coded as imported and nobody accounted for the tax", async () => {
    await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-01-15", source: "bill",
      memo: "Import with no self-accounted tax",
      lines: [
        { account: "6900", debit: 300_000, taxCode: "IMPORT_GOODS" },
        { account: "2000", credit: 300_000 },
      ],
    });
    const r = await vatReturn({ orgId: ORG, entityId: ENT, from: "2026-01-01", to: "2026-01-31" });
    expect(box(r, "sales", "6").amountMinor).toBe("300000");
    expect(box(r, "sales", "6").vatMinor).toBe("0");
    const w = r.warnings.find((x) => /coded as imported/.test(x))!;
    expect(w).toMatch(/Article 48/);
    expect(w).toMatch(/pre-populated/);
  });

  it("uses the registration's own tax period rather than the dates it was asked for", async () => {
    // Registered on the FTA's February stagger: periods end in February, May,
    // August and November. A caller asking for calendar May is asking for a
    // period this registrant does not have — and every reminder in the product
    // used to ask for exactly that.
    await recordRegistration({
      orgId: ORG, entityId: ENT, regime: "VAT",
      trn: "100123456700003", frequency: "QUARTERLY", firstPeriodEndMonth: 2,
      registeredOn: "2026-01-01",
    });

    const r = await vatReturn({ orgId: ORG, entityId: ENT, from: "2026-05-01", to: "2026-05-31" });
    expect(r.taxPeriod).toEqual({
      label: "Mar-May 2026",
      from: "2026-03-01",
      to: "2026-05-31",
      dueOn: "2026-06-28",
      matchesRequest: false,
      filedOn: null,
    });
    // The figures are for the period, and the return says which period.
    expect(r.periodFrom).toBe("2026-03-01");
    expect(r.periodTo).toBe("2026-05-31");
    expect(r.warnings.find((x) => /is not a tax period of this registration/.test(x)))
      .toMatch(/Mar-May 2026/);

    // Asked for the real period, it says so and says nothing more.
    const exact = await vatReturn({ orgId: ORG, entityId: ENT, from: "2026-03-01", to: "2026-05-31" });
    expect(exact.taxPeriod?.matchesRequest).toBe(true);
    expect(exact.warnings.find((x) => /is not a tax period/.test(x))).toBeUndefined();
    expect(exact.totalOutputVatMinor).toBe(r.totalOutputVatMinor);

    // And once a filing is recorded, "is this filed" stops being an inference
    // from whether somebody happened to close a month.
    await recordFiling({
      orgId: ORG, entityId: ENT, periodLabel: "Mar-May 2026",
      filedOn: "2026-06-25", filedBy: "u-1", reference: "FTA-1", asOf: "2026-07-01",
    });
    const filed = await vatReturn({ orgId: ORG, entityId: ENT, from: "2026-03-01", to: "2026-05-31" });
    expect(filed.taxPeriod?.filedOn).toBe("2026-06-25");
  });

  it("says nothing about tax periods for an entity with no registration", async () => {
    // Every entity that existed before registrations did, which is all of them.
    // The dates asked for are the dates computed, and the return claims nothing
    // it cannot know.
    await db.$executeRawUnsafe(`DELETE FROM "TaxFiling" WHERE "orgId" = '${ORG}'`);
    await db.$executeRawUnsafe(`DELETE FROM "TaxRegistration" WHERE "orgId" = '${ORG}'`);
    const plain = await vatReturn({ orgId: ORG, entityId: ENT, from: "2026-05-01", to: "2026-05-31" });
    expect(plain.taxPeriod).toBeNull();
    expect(plain.periodFrom).toBe("2026-05-01");
    expect(plain.periodTo).toBe("2026-05-31");
    expect(plain.warnings.find((x) => /tax period/.test(x))).toBeUndefined();
  });
  /* ------------------------------- Article 10: corrections to filed returns */

  describe("corrections to a return already filed", () => {
    // Its own registration, so the periods are known rather than assumed, and
    // its own months, so nothing above is disturbed.
    beforeAll(async () => {
      await recordRegistration({
        orgId: ORG, entityId: ENT, regime: "VAT",
        trn: "100000000000003", frequency: "QUARTERLY", firstPeriodEndMonth: 3,
      });
    });

    it("reports a reversal of a filed quarter, grouped by the return it belongs to", async () => {
      // A January sale carrying 12,000 of output tax, in a quarter that is then
      // filed. In April somebody reverses it. `reverse()` refuses a closed
      // period, so the correction necessarily lands in an open one and flows
      // into the CURRENT return as ordinary movement — the tax quietly moving
      // from the quarter it belonged to into the quarter somebody noticed,
      // which is the thing Article 10 exists to stop.
      const original = await post({
        orgId: ORG, entityId: ENT, entryDate: "2026-01-20", source: "invoice",
        memo: "Sale later found to be wrong",
        lines: [
          { account: "1010", debit: 252_000 },
          { account: "4000", credit: 240_000, taxCode: "STANDARD_5", taxEmirate: "DU" },
          { account: "2100", credit: 12_000, taxCode: "OUTPUT_VAT", taxEmirate: "DU" },
        ],
      });
      await recordFiling({
        orgId: ORG, entityId: ENT, periodLabel: "Jan-Mar 2026",
        filedOn: "2026-04-20", filedBy: "u-1", reference: "FTA-Q1", asOf: "2026-05-01",
      });

      const rev = await reverse({ orgId: ORG, entryId: original.id, entryDate: "2026-04-15" });

      const r = await vatReturn({ orgId: ORG, entityId: ENT, from: "2026-04-01", to: "2026-06-30" });
      const vd = r.voluntaryDisclosure;

      expect(vd.corrections).toHaveLength(1);
      expect(vd.corrections[0]).toMatchObject({
        reference: `${rev.series}-${rev.number}`,
        originalReference: `${original.series}-${original.number}`,
        originalPeriodLabel: "Jan-Mar 2026",
        filedOn: "2026-04-20",
        netMinor: "-12000",
      });

      // Grouped by the period the ORIGINAL belongs to, because Article 10
      // measures per return and not in aggregate.
      expect(vd.byPeriod).toHaveLength(1);
      expect(vd.byPeriod[0].label).toBe("Jan-Mar 2026");
      // 120.00 of tax is nowhere near AED 10,000.
      expect(vd.byPeriod[0].overThreshold).toBe(false);
      expect(r.warnings.find((x) => /Article 10/.test(x))).toBeUndefined();
      expect(vd.note).toMatch(/Articles 61 or 62/);
    });

    it("warns once the movement on a filed return passes AED 10,000", async () => {
      const big = await post({
        orgId: ORG, entityId: ENT, entryDate: "2026-02-10", source: "invoice",
        memo: "Large sale later found to be wrong",
        lines: [
          { account: "1010", debit: 21_000_000 },
          { account: "4000", credit: 20_000_000, taxCode: "STANDARD_5", taxEmirate: "DU" },
          { account: "2100", credit: 1_000_000, taxCode: "OUTPUT_VAT", taxEmirate: "DU" },
        ],
      });
      await reverse({ orgId: ORG, entryId: big.id, entryDate: "2026-04-16" });

      const r = await vatReturn({ orgId: ORG, entityId: ENT, from: "2026-04-01", to: "2026-06-30" });
      const q1 = r.voluntaryDisclosure.byPeriod.find((p) => p.label === "Jan-Mar 2026")!;
      // 10,000.00 of tax plus the 120.00 above, and the threshold is 10,000.00.
      expect(BigInt(q1.netMinor)).toBe(-1_012_000n);
      expect(q1.overThreshold).toBe(true);
      expect(q1.corrections).toBe(2);

      const w = r.warnings.find((x) => /Article 10/.test(x))!;
      expect(w).toMatch(/Jan-Mar 2026/);
      expect(w).toMatch(/20 business days/);
      // The population, never a verdict.
      expect(w).toMatch(/not a verdict/);
      expect(w).toMatch(/61 and 62/);
    });

    it("says nothing about a reversal of a period nobody has filed or closed", async () => {
      // A correction to a return that has not gone anywhere is bookkeeping.
      const open = await post({
        orgId: ORG, entityId: ENT, entryDate: "2026-08-05", source: "invoice",
        memo: "Sale corrected before the return went",
        lines: [
          { account: "1010", debit: 21_000_000 },
          { account: "4000", credit: 20_000_000, taxCode: "STANDARD_5", taxEmirate: "DU" },
          { account: "2100", credit: 1_000_000, taxCode: "OUTPUT_VAT", taxEmirate: "DU" },
        ],
      });
      await reverse({ orgId: ORG, entryId: open.id, entryDate: "2026-08-20" });

      const r = await vatReturn({ orgId: ORG, entityId: ENT, from: "2026-07-01", to: "2026-09-30" });
      expect(r.voluntaryDisclosure.corrections).toEqual([]);
      expect(r.voluntaryDisclosure.note).toMatch(/nothing here calls for a voluntary disclosure/);
      expect(r.warnings.find((x) => /Article 10/.test(x))).toBeUndefined();
    });
  });
});
