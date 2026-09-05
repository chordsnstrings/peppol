import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { postInvoice, receivablesAgeing } from "@/lib/server/ledger/ar";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { trialBalance } from "@/lib/server/ledger/reports";
import { post } from "@/lib/server/ledger/post";
import {
  writeOffReceivable, adjustWriteOffVat, reverseWriteOff, writeOffsView,
} from "@/lib/server/ledger/write-offs";
import type { Invoice, InvoiceLine, TaxProfileCode } from "@/lib/domain/types";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-wo";
const ENT = "t-ent-wo";

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "ReceivableWriteOff" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Record" WHERE "orgId" = '${ORG}'`),
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
    id: `wl${++seq}`, lineNo: seq, description: "Consulting", qty: 1, unitCode: "C62",
    unitPriceMinor: net, taxProfileCode: profile, lineNetMinor: net, lineVatMinor: vat,
  };
}

/** A sales invoice, raised and posted, with the id it was posted under. */
async function raise(number: string, issueDate: string, lines: InvoiceLine[] = [line(100_000, 5_000)]): Promise<Invoice> {
  const net = lines.reduce((a, l) => a + l.lineNetMinor, 0);
  const vat = lines.reduce((a, l) => a + l.lineVatMinor, 0);
  const inv = {
    id: `winv-${++seq}`, orgId: ORG, entityId: ENT, direction: "OUTBOUND", docType: "TAX_INVOICE",
    number, issueDate, supplyDate: issueDate, currency: "AED",
    buyer: { nameEn: "Al Marri Trading LLC" }, seller: { nameEn: "Our Company" },
    lines,
    totals: { taxExclusiveMinor: net, vatMinor: vat, taxInclusiveMinor: net + vat, payableMinor: net + vat, perCategory: [] },
    lifecycleStatus: "SENT", exchangeStatus: "NOT_SENT", reportingStatusC2: "NOT_REPORTED",
    source: "EDITOR",
    compliance: { taxableEventDate: issueDate, daysRemaining: 14, breached: false },
    createdAt: `${issueDate}T00:00:00Z`, updatedAt: `${issueDate}T00:00:00Z`,
  } as Invoice;
  await postInvoice({ orgId: ORG, invoice: inv });
  return inv;
}

async function linesOf(entryId: string) {
  const rows = await db.journalLine.findMany({
    where: { entryId }, include: { account: true }, orderBy: { lineNo: "asc" },
  });
  return rows.map((r) => ({ code: r.account.code, amount: r.txnAmountMinor, settles: r.settlesId, taxCode: r.taxCode }));
}

async function openOn(sourceId: string, asOf: string) {
  const ageing = await receivablesAgeing({ orgId: ORG, entityId: ENT, asOf: new Date(asOf) });
  return ageing.open.filter((o) => o.sourceId === sourceId);
}

d("receivable write-offs", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("charges an irrecoverable debt to 6260 and closes the open item", async () => {
    // 100,000 net plus 5,000 tax = 105,000 owed, and none of it is coming.
    const inv = await raise("INV-WO-1", "2026-01-10");
    expect((await openOn(inv.id, "2026-07-14"))[0]?.outstandingMinor).toBe("105000");

    const r = await writeOffReceivable({
      orgId: ORG, entityId: ENT, documentId: inv.id,
      writtenOffOn: "2026-07-15", reason: "Customer liquidated, no distribution expected",
    });
    expect(r.chargedMinor).toBe(105_000n);
    expect(r.vatHeldMinor).toBe(0n);

    const l = await linesOf(r.entryId);
    expect(l).toEqual([
      { code: "6260", amount: 105_000n, settles: null, taxCode: null },
      // On the LINE, which is what makes the open item close.
      { code: "1100", amount: -105_000n, settles: inv.id, taxCode: null },
    ]);

    const entry = await db.journalEntry.findUnique({ where: { id: r.entryId } });
    expect(entry?.source).toBe("write_off");
    expect(await openOn(inv.id, "2026-07-31")).toEqual([]);
  });

  it("reaches the control account that refuses a hand-keyed journal", async () => {
    const ar = await db.account.findFirst({ where: { orgId: ORG, entityId: ENT, code: "1100" } });
    expect(ar?.isControl).toBe(true);
    // The same posting by hand is refused — which is the whole reason a
    // subledger had to own writing a receivable off.
    await expect(post({
      orgId: ORG, entityId: ENT, entryDate: "2026-07-15",
      lines: [{ account: "6260", debit: 1_000 }, { account: "1100", credit: 1_000 }],
    })).rejects.toThrow(/control account/i);
  });

  it("writes off against the allowance where one is carried, and refuses to use more than there is", async () => {
    // An allowance of 20,000 raised in February: Dr 6260 / Cr 1150.
    await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-02-01", memo: "Allowance for doubtful debts",
      lines: [{ account: "6260", debit: 20_000 }, { account: "1150", credit: 20_000 }],
    });

    const inv = await raise("INV-WO-ALLOW", "2026-01-15", [line(20_000, 1_000)]);

    // 21,000 against a 20,000 allowance would charge a period that never took
    // the expense.
    await expect(writeOffReceivable({
      orgId: ORG, entityId: ENT, documentId: inv.id, against: "allowance",
      writtenOffOn: "2026-07-16", reason: "Gone away, no forwarding address",
    })).rejects.toThrow(/allowance on 1150 carries 20000/i);

    const r = await writeOffReceivable({
      orgId: ORG, entityId: ENT, documentId: inv.id, amountMinor: 20_000, against: "allowance",
      writtenOffOn: "2026-07-16", reason: "Gone away, no forwarding address",
    });
    expect(await linesOf(r.entryId)).toEqual([
      // No expense: it was taken when the allowance was raised.
      { code: "1150", amount: 20_000n, settles: null, taxCode: null },
      { code: "1100", amount: -20_000n, settles: inv.id, taxCode: null },
    ]);

    const view = await writeOffsView({ orgId: ORG, entityId: ENT, asOf: "2026-07-31" });
    expect(view.allowanceMinor).toBe(0n);
    // 21,000 raised less 20,000 written off leaves 1,000 still open.
    expect((await openOn(inv.id, "2026-07-31"))[0]?.outstandingMinor).toBe("1000");
  });

  it("refuses the tax adjustment by naming the condition that is not met", async () => {
    const inv = await raise("INV-WO-EARLY", "2026-06-01");
    await writeOffReceivable({
      orgId: ORG, entityId: ENT, documentId: inv.id, vatMinor: 5_000,
      writtenOffOn: "2026-07-01", reason: "Disputed and abandoned",
    });

    // Supplied 2026-06-01, so Article 64(1)(c) is not satisfied until
    // 2026-11-28 — 180 days later — and the customer has not been told either.
    await expect(adjustWriteOffVat({
      orgId: ORG, entityId: ENT, documentId: inv.id, adjustedOn: "2026-07-31",
    })).rejects.toThrow(/2026-11-28/);
    await expect(adjustWriteOffVat({
      orgId: ORG, entityId: ENT, documentId: inv.id, adjustedOn: "2026-07-31",
    })).rejects.toThrow(/notified/i);

    // And nothing was posted while it was refused.
    const posted = await db.journalEntry.count({ where: { orgId: ORG, sourceType: "BAD_DEBT_RELIEF" } });
    expect(posted).toBe(0);
  });

  it("holds the tax element on the open item until the relief is taken, then closes it", async () => {
    // Supplied 2026-01-05, so the six months are up on 2026-07-04.
    const inv = await raise("INV-WO-RELIEF", "2026-01-05");
    const w = await writeOffReceivable({
      orgId: ORG, entityId: ENT, documentId: inv.id, vatMinor: 5_000,
      writtenOffOn: "2026-08-01", notifiedOn: "2026-07-20",
      reason: "Liquidator confirmed no dividend",
    });
    // 105,000 less the 5,000 of tax leaves 100,000 charged to the expense.
    expect(w.chargedMinor).toBe(100_000n);
    expect((await openOn(inv.id, "2026-08-15"))[0]?.outstandingMinor).toBe("5000");

    const a = await adjustWriteOffVat({
      orgId: ORG, entityId: ENT, documentId: inv.id, adjustedOn: "2026-08-01",
    });
    expect(a.vatMinor).toBe(5_000n);
    expect(await linesOf(a.entryId)).toEqual([
      // Tagged so the return reads it: box 1's tax falls by 5,000 and the
      // supplies figure does not move, because a bad debt does not undo a sale.
      { code: "2100", amount: 5_000n, settles: null, taxCode: "OUTPUT_VAT" },
      { code: "1100", amount: -5_000n, settles: inv.id, taxCode: null },
    ]);
    expect(await openOn(inv.id, "2026-08-31")).toEqual([]);

    // Asking twice claims it once.
    const again = await adjustWriteOffVat({ orgId: ORG, entityId: ENT, documentId: inv.id });
    expect(again.alreadyAdjusted).toBe(true);
    expect(await db.journalEntry.count({ where: { orgId: ORG, sourceType: "BAD_DEBT_RELIEF" } })).toBe(1);
  });

  it("puts a reversed write-off back on the same open item, tax and all", async () => {
    const target = await db.receivableWriteOff.findFirst({
      // No document-store record for it, so the reference fell back to the
      // entry memo — which still names the invoice.
      where: { orgId: ORG, entityId: ENT, documentRef: { contains: "INV-WO-RELIEF" } },
    });
    expect(target?.vatAdjusted).toBe(true);

    const r = await reverseWriteOff({
      orgId: ORG, entityId: ENT, writeOffId: target!.id, reversedOn: "2026-09-01",
      reason: "Paid in full after all",
    });
    // The relief first, then the write-off: 5,000 of tax plus 100,000 of expense.
    expect(r.entryIds).toHaveLength(2);
    expect(r.restoredMinor).toBe(105_000n);

    const open = await openOn(target!.documentId, "2026-09-30");
    // ONE item, not the old one plus a new one beside it.
    expect(open).toHaveLength(1);
    expect(open[0].outstandingMinor).toBe("105000");
    // And it ages from the invoice, not from the reversal.
    expect(open[0].date).toBe("2026-01-05");

    // The record is gone, so the debt can be written off again if it goes bad
    // a second time.
    expect(await db.receivableWriteOff.findFirst({ where: { id: target!.id } })).toBeNull();
  });

  it("refuses to write the same debt off twice", async () => {
    const inv = await raise("INV-WO-DUP", "2026-01-12");
    await writeOffReceivable({
      orgId: ORG, entityId: ENT, documentId: inv.id,
      writtenOffOn: "2026-08-05", reason: "Struck off the register",
    });
    await expect(writeOffReceivable({
      orgId: ORG, entityId: ENT, documentId: inv.id,
      writtenOffOn: "2026-08-06", reason: "Struck off the register",
    })).rejects.toThrow(/already written off/i);
  });

  it("takes a proportional slice of the tax on a partial write-off", async () => {
    const inv = await raise("INV-WO-PART", "2026-01-20");

    // 5,000 of tax sits inside 105,000, so 63,000 of it carries 3,000 —
    // 5,000 x 63,000 / 105,000, worked once and rounded once.
    const view = await writeOffsView({ orgId: ORG, entityId: ENT, asOf: "2026-08-10" });
    const candidate = view.candidates.find((c) => c.documentId === inv.id);
    expect(candidate?.outstandingMinor).toBe(105_000n);
    expect(candidate?.vatMinor).toBe(5_000n);
    expect(candidate?.reliefEligibleOn).toBe("2026-07-19");

    await expect(writeOffReceivable({
      orgId: ORG, entityId: ENT, documentId: inv.id, amountMinor: 63_000, vatMinor: 4_000,
      writtenOffOn: "2026-08-10", reason: "Part settled, the rest abandoned",
    })).rejects.toThrow(/only 3000 of output tax/i);

    const r = await writeOffReceivable({
      orgId: ORG, entityId: ENT, documentId: inv.id, amountMinor: 63_000, vatMinor: 3_000,
      writtenOffOn: "2026-08-10", notifiedOn: "2026-08-01",
      reason: "Part settled, the rest abandoned",
    });
    // 63,000 written off less 3,000 of tax held back = 60,000 of expense.
    expect(r.chargedMinor).toBe(60_000n);
    // 105,000 raised less the 60,000 posted leaves 45,000 open, of which 3,000
    // is the tax waiting on the Article 64 adjustment.
    expect((await openOn(inv.id, "2026-08-31"))[0]?.outstandingMinor).toBe("45000");

    await adjustWriteOffVat({ orgId: ORG, entityId: ENT, documentId: inv.id, adjustedOn: "2026-08-31" });
    expect((await openOn(inv.id, "2026-08-31"))[0]?.outstandingMinor).toBe("42000");
  });

  it("offers no relief on a supply that bore no tax", async () => {
    const inv = await raise("INV-WO-ZERO", "2026-01-25", [line(100_000, 0, "ZERO_EXPORT")]);
    const view = await writeOffsView({ orgId: ORG, entityId: ENT, asOf: "2026-08-20" });
    expect(view.candidates.find((c) => c.documentId === inv.id)?.vatMinor).toBe(0n);

    // There is no output tax on an export to give back.
    await expect(writeOffReceivable({
      orgId: ORG, entityId: ENT, documentId: inv.id, vatMinor: 100,
      writtenOffOn: "2026-08-20", reason: "Buyer insolvent overseas",
    })).rejects.toThrow(/only 0 of output tax/i);
  });

  it("names the customer and the invoice number from the document store", async () => {
    const inv = await raise("INV-WO-DOC", "2026-02-10");
    await db.record.create({
      data: { store: "invoices", id: inv.id, orgId: ORG, entityId: ENT, data: JSON.stringify(inv) },
    });
    const view = await writeOffsView({ orgId: ORG, entityId: ENT, asOf: "2026-08-25" });
    const c = view.candidates.find((x) => x.documentId === inv.id);
    expect(c?.reference).toBe("INV-WO-DOC");
    expect(c?.partyName).toBe("Al Marri Trading LLC");
  });

  it("refuses a write-off larger than the debt, or with no reason", async () => {
    const inv = await raise("INV-WO-BIG", "2026-02-12");
    await expect(writeOffReceivable({
      orgId: ORG, entityId: ENT, documentId: inv.id, amountMinor: 200_000,
      writtenOffOn: "2026-08-26", reason: "Optimistic",
    })).rejects.toThrow(/cannot be written off/i);
    await expect(writeOffReceivable({
      orgId: ORG, entityId: ENT, documentId: inv.id,
      writtenOffOn: "2026-08-26", reason: "  ",
    })).rejects.toThrow(/why the debt is irrecoverable/i);
  });

  it("keeps the trial balance tied through every month it touched", async () => {
    for (const period of ["2026-07", "2026-08", "2026-09"]) {
      const tb = await trialBalance({ orgId: ORG, entityId: ENT, periodLabel: period });
      expect(tb.balanced).toBe(true);
      expect(tb.differenceMinor).toBe(0n);
    }
  });
});
