import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  expandPrefix, formatNumber, splitNumber, checkConfig,
  numberingOverview, previewSeries, configureSeries, currentCycle, seriesCatalogue,
} from "@/lib/server/ledger/numbering";
import { post, reverse } from "@/lib/server/ledger/post";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-num";
const ENT = "t-ent-num";
const S = { orgId: ORG, entityId: ENT };

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "SalesOrderLine" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "SalesOrder" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "JournalLineDimension" WHERE "lineId" IN (SELECT id FROM "JournalLine" WHERE "orgId" = '${ORG}')`),
    db.$executeRawUnsafe(`DELETE FROM "JournalLine" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "JournalEntry" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "AccountBalance" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Account" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "AccountingPeriod" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "FiscalYear" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Book" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "DocumentSequenceChange" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "DocumentSequence" WHERE "orgId" = '${ORG}'`),
  ]);
}

/** A balanced two-line journal, so a test can say what it is about instead. */
const journal = (memo: string, series: string, amount = 10_000n) =>
  post({
    ...S,
    entryDate: "2026-03-15",
    memo,
    series,
    lines: [
      { account: "6900", debit: amount, memo },
      { account: "1000", credit: amount, memo },
    ],
  });

const seriesOf = async (scope: string) => {
  const o = await numberingOverview(S);
  return o.series.find((s) => s.scope === scope)!;
};

/* ------------------------------------------------------------- the format */

describe("how a number is written", () => {
  it("writes the year into the number rather than beside it", () => {
    expect(expandPrefix("INV-{YYYY}-", "2026-01-01")).toBe("INV-2026-");
    expect(expandPrefix("INV/{YY}/", "2026-04-01")).toBe("INV/26/");
    expect(expandPrefix("JV-", "2026-01-01")).toBe("JV-");
  });

  it("pads to the minimum width and never truncates past it", () => {
    expect(formatNumber("JV-", 7, 5)).toBe("JV-00007");
    expect(formatNumber("", 123456, 5)).toBe("123456");
  });

  it("reads a number back as a format and a counter", () => {
    expect(splitNumber("INV-2026-00042")).toEqual({ prefix: "INV-2026-", n: 42, width: 5 });
    expect(splitNumber("00042")).toEqual({ prefix: "", n: 42, width: 5 });
    expect(splitNumber("DRAFT")).toBeNull();
  });
});

describe("what a series may be configured to do", () => {
  const ok = { prefix: "JV-", padding: 5, restartYearly: false };

  it("accepts a plain prefix and a width", () => {
    expect(() => checkConfig("GJ", ok)).not.toThrow();
    expect(() => checkConfig("GJ", { prefix: "INV-{YYYY}-", padding: 4, restartYearly: true })).not.toThrow();
  });

  it("refuses a yearly restart that does not carry the year, and cites why", () => {
    expect(() => checkConfig("SI", { prefix: "INV-", padding: 5, restartYearly: true }))
      .toThrow(/Article 65/);
    expect(() => checkConfig("SI", { prefix: "INV-", padding: 5, restartYearly: true }))
      .toThrow(/already belongs to another document/);
  });

  it("refuses a prefix that runs into its own digits", () => {
    expect(() => checkConfig("GJ", { ...ok, prefix: "INV2026" })).toThrow(/cannot end in a digit/);
    expect(() => checkConfig("GJ", { ...ok, prefix: "INV-{YYYY}" })).toThrow(/cannot end in a digit/);
  });

  it("refuses a placeholder the numbering cannot fill in", () => {
    expect(() => checkConfig("GJ", { ...ok, prefix: "INV-{MM}-" })).toThrow(/only placeholders/);
  });

  it("refuses characters a reference cannot be traced through", () => {
    expect(() => checkConfig("GJ", { ...ok, prefix: "IN#V-" })).toThrow(/letters, digits, spaces/);
  });

  it("refuses a width that is not a width", () => {
    expect(() => checkConfig("GJ", { ...ok, padding: 0 })).toThrow(/between 1 and 12/);
    expect(() => checkConfig("GJ", { ...ok, padding: 13 })).toThrow(/between 1 and 12/);
    expect(() => checkConfig("GJ", { ...ok, padding: 2.5 })).toThrow(/between 1 and 12/);
  });

  it("refuses something that is not the shape of a series code", () => {
    expect(() => checkConfig("gj", ok)).toThrow(/not the shape of a series code/);
    expect(() => checkConfig("G", ok)).toThrow(/not the shape of a series code/);
  });
});

/* ----------------------------------------------------------- against a database */

d("document numbering administration", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ ...S, label: "2026", startsOn: "2026-01-01" });
    await openBooks(S);
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("hands out 1 to 20 with no gap and no repeat when twenty postings race", async () => {
    const entries = await Promise.all(
      Array.from({ length: 20 }, (_, i) => journal(`Race ${i + 1}`, "GJ", BigInt(1000 + i))),
    );
    const numbers = entries.map((e) => e.number).sort();
    expect(numbers).toEqual(Array.from({ length: 20 }, (_, i) => String(i + 1).padStart(5, "0")));
    expect(new Set(numbers).size).toBe(20);

    // And the counter agrees: it is sitting on the next one, not past it.
    const gj = await seriesOf("GJ");
    expect(gj.allocated).toBe(20);
    expect(gj.nextReference).toBe("GJ-00021");
  });

  it("lists every series the code posts under, including ones that have never posted", async () => {
    const o = await numberingOverview(S);
    const scopes = o.series.map((s) => s.scope);
    expect(o.catalogue.scanned).toBe(true);
    // Read out of the source, not out of the data: nothing in this test has
    // ever posted a sales invoice, a quotation or a corporate tax provision.
    for (const scope of ["GJ", "SI", "CR", "PI", "PR", "SQ", "SO", "CT", "WP"]) {
      expect(scopes).toContain(scope);
    }
    const cat = await seriesCatalogue();
    expect(cat.entries.find((e) => e.scope === "SI")?.modules).toContain("ar.ts");
  });

  it("reports what a series has issued and what it will issue next", async () => {
    const gj = await seriesOf("GJ");
    expect(gj.integrity.issued).toBe(20);
    expect(gj.integrity.verdict).toBe("clean");
    expect(gj.integrity.gapCount).toBe(0);
    expect(gj.integrity.firstReference).toBe("GJ-00001");
    expect(gj.integrity.lastReference).toBe("GJ-00020");
    expect(gj.lastIssued?.reference).toBe("GJ-00020");
    expect(gj.lastIssued?.date).toBe("2026-03-15");

    // A series nothing has used yet says so rather than showing a nought.
    const ct = await seriesOf("CT");
    expect(ct.configured).toBe(false);
    expect(ct.integrity.verdict).toBe("empty");
    expect(ct.nextReference).toBe("CT-00001");
  });

  it("previews a proposed format without saving it", async () => {
    const p = await previewSeries({ ...S, scope: "GJ", patch: { prefix: "JV-", padding: 6 } });
    expect(p.current).toBe("GJ-00021");
    expect(p.next).toBe("GJ-JV-000021");
    expect(p.following).toBe("GJ-JV-000022");
    expect(p.changes).toEqual([`prefix "" → "JV-"`, "minimum width 5 → 6"]);

    // Nothing was written: the series still numbers the old way.
    const gj = await seriesOf("GJ");
    expect(gj.prefix).toBe("");
    expect(gj.nextReference).toBe("GJ-00021");
  });

  it("refuses a proposal before it is saved, not after", async () => {
    await expect(previewSeries({ ...S, scope: "GJ", patch: { restartYearly: true } }))
      .rejects.toThrow(/Article 65/);
  });

  it("changes the prefix mid-year and records the number it took effect from", async () => {
    const r = await configureSeries({
      ...S, scope: "GJ",
      patch: { prefix: "JV-", padding: 6, note: "Bank asked for a format they can read." },
      actorId: "u-num-1",
    });
    expect(r.changed).toBe(true);
    expect(r.series.changes[0].effectiveFromNo).toBe(21);
    expect(r.series.changes[0].from).toEqual({ prefix: "", padding: 5, restartYearly: false });
    expect(r.series.changes[0].to).toEqual({ prefix: "JV-", padding: 6, restartYearly: false });
    expect(r.series.changes[0].note).toMatch(/Bank asked/);
    expect(r.series.changes[0].actorId).toBe("u-num-1");

    // The counter did not move: the next document takes the number it was due,
    // written the new way.
    const e = await journal("First under the new format", "GJ");
    expect(e.number).toBe("JV-000021");

    // Both formats are reported as runs, and neither is a gap.
    const gj = await seriesOf("GJ");
    expect(gj.integrity.gapCount).toBe(0);
    expect(gj.integrity.runs.map((x) => x.prefix)).toEqual(["", "JV-"]);
    expect(gj.integrity.runs[1].from).toBe("GJ-JV-000021");
  });

  it("says nothing changed rather than writing a second identical history line", async () => {
    const r = await configureSeries({ ...S, scope: "GJ", patch: { prefix: "JV-", padding: 6 } });
    expect(r.changed).toBe(false);
    expect(r.series.changes.length).toBe(1);
  });

  it("refuses to move the counter, whatever the field is called", async () => {
    for (const patch of [{ nextNo: 1 }, { nextNumber: 500 }, { currentNumber: 3 }, { reset: true }]) {
      await expect(configureSeries({ ...S, scope: "GJ", patch }))
        .rejects.toThrow(/will not let you set/);
    }
    const gj = await seriesOf("GJ");
    expect(gj.allocated).toBe(21);
  });

  it("refuses a prefix another series already numbers with", async () => {
    await expect(configureSeries({ ...S, scope: "SI", patch: { prefix: "JV-" } }))
      .rejects.toThrow(/Series GJ already numbers with "JV-"/);
  });

  it("refuses to configure a series nothing posts under", async () => {
    await expect(configureSeries({ ...S, scope: "ZZ", patch: { prefix: "ZZ-" } }))
      .rejects.toThrow(/Nothing in this product posts under "ZZ"/);
  });

  it("keeps a reversed document's number, and does not call it a gap", async () => {
    const original = await journal("To be reversed", "GJ");
    const reversal = await reverse({ orgId: ORG, entryId: original.id, memo: "Wrong account" });
    expect(reversal.number).toBe("JV-000023");

    const gj = await seriesOf("GJ");
    expect(gj.integrity.retired).toBe(1);
    expect(gj.integrity.live).toBe(gj.integrity.issued - 1);
    expect(gj.integrity.gapCount).toBe(0);
    expect(gj.integrity.verdict).toBe("clean");
    expect(gj.integrity.note).toMatch(/reversed or cancelled, which keep their numbers/);
  });

  it("reports a number no document carries as a finding, and says what it means", async () => {
    await journal("First opening entry", "OB");
    const middle = await journal("Second opening entry", "OB");
    await journal("Third opening entry", "OB");

    // Removed from outside the posting path, which is the only way to make a
    // hole. The guard is turned off deliberately: the point of the test is
    // that the report notices what the ledger will not let anybody do.
    await db.$transaction([
      db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
      db.$executeRawUnsafe(`DELETE FROM "JournalLine" WHERE "entryId" = '${middle.id}'`),
      db.$executeRawUnsafe(`DELETE FROM "JournalEntry" WHERE id = '${middle.id}'`),
    ]);

    const ob = await seriesOf("OB");
    expect(ob.integrity.verdict).toBe("gap");
    expect(ob.integrity.gapCount).toBe(1);
    expect(ob.integrity.gaps).toEqual(["OB-00002"]);
    expect(ob.integrity.issued).toBe(2);
    expect(ob.integrity.note).toMatch(/removed from the ledger outside the posting path/);

    // The whole overview still renders. A gap is a finding, not a failure.
    const o = await numberingOverview(S);
    expect(o.series.find((s) => s.scope === "GJ")!.integrity.verdict).toBe("clean");
  });

  it("counts a cancelled sales order as issued, not as missing", async () => {
    const take = async () => {
      const [{ n }] = await db.$queryRaw<{ n: string }[]>`SELECT gl_next_number(${ORG}, ${ENT}, 'SQ') AS n`;
      return `SQ-${n}`;
    };
    const first = await take();
    const second = await take();
    await db.salesOrder.create({ data: { ...S, number: first, customerName: "Al Noor Trading", issuedOn: new Date("2026-03-01") } });
    await db.salesOrder.create({ data: { ...S, number: second, customerName: "Gulf Fit-out", issuedOn: new Date("2026-03-02"), status: "cancelled" } });
    // And one somebody typed in by hand, which belongs to no series.
    await db.salesOrder.create({ data: { ...S, number: "MANUAL-7", customerName: "Walk-in", issuedOn: new Date("2026-03-03") } });

    const sq = await seriesOf("SQ");
    expect(sq.integrity.issued).toBe(2);
    expect(sq.integrity.retired).toBe(1);
    expect(sq.integrity.gapCount).toBe(0);
    expect(sq.integrity.verdict).toBe("clean");

    const o = await numberingOverview(S);
    expect(o.unattributed).toContain("MANUAL-7");
  });

  it("reports numbers taken from a counter that no document carries, without guessing", async () => {
    await db.$queryRaw`SELECT gl_next_number(${ORG}, ${ENT}, 'PC') AS n`;
    const pc = await seriesOf("PC");
    expect(pc.integrity.verdict).toBe("unchecked");
    expect(pc.integrity.note).toMatch(/no document carrying one was found/);
  });

  it("restarts the counter when the financial year turns, and the year is in the number", async () => {
    await configureSeries({ ...S, scope: "SI", patch: { prefix: "INV-{YYYY}-", padding: 4, restartYearly: true } });

    const take = async () => {
      const [{ n }] = await db.$queryRaw<{ n: string }[]>`SELECT gl_next_number(${ORG}, ${ENT}, 'SI') AS n`;
      return n;
    };

    // The clock cannot be moved, so the financial calendar is moved under it:
    // both years below contain today, so each is in turn the year a number
    // issued now belongs to.
    await db.$executeRawUnsafe(`UPDATE "FiscalYear" SET "endsOn" = DATE '2026-01-31' WHERE "orgId" = '${ORG}' AND label = '2026'`);
    await db.$executeRawUnsafe(
      `INSERT INTO "FiscalYear" (id, "orgId", "entityId", label, "startsOn", "endsOn", status)
       VALUES ('fy-num-prior', '${ORG}', '${ENT}', 'prior', DATE '2025-10-01', DATE '2026-09-30', 'open')`,
    );
    const before = await currentCycle(ORG, ENT);
    expect(before.year).toBe("2025");
    expect(await take()).toBe("INV-2025-0001");
    expect(await take()).toBe("INV-2025-0002");

    // The year turns.
    await db.$executeRawUnsafe(`UPDATE "FiscalYear" SET "endsOn" = DATE '2026-12-31' WHERE "orgId" = '${ORG}' AND label = '2026'`);
    const after = await currentCycle(ORG, ENT);
    expect(after.year).toBe("2026");
    expect(await take()).toBe("INV-2026-0001");
    expect(await take()).toBe("INV-2026-0002");

    // Which is the whole point of refusing a restart without the year: the
    // counter came back to 1 and the reference did not.
    expect("INV-2026-0001").not.toBe("INV-2025-0001");

    await db.$executeRawUnsafe(`DELETE FROM "FiscalYear" WHERE id = 'fy-num-prior'`);
  });

  it("refuses a yearly restart the database would refuse too", async () => {
    await expect(configureSeries({ ...S, scope: "PR", patch: { prefix: "PAY-", restartYearly: true } }))
      .rejects.toThrow(/Article 65/);
    const pr = await seriesOf("PR");
    expect(pr.restartYearly).toBe(false);

    // And directly, with the application's checks bypassed entirely.
    await expect(
      db.$executeRawUnsafe(`UPDATE "DocumentSequence" SET "restartYearly" = true WHERE "orgId" = '${ORG}' AND scope = 'GJ'`),
    ).rejects.toThrow(/DocumentSequence_restart_needs_year_check/);
  });

  it("does not read another organisation's series", async () => {
    const o = await numberingOverview({ orgId: "someone-else", entityId: ENT });
    for (const s of o.series) {
      expect(s.configured).toBe(false);
      expect(s.integrity.issued).toBe(0);
    }
  });
});
