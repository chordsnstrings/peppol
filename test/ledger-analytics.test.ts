import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { ledgerAnalytics, type Finding, type TestRun } from "@/lib/server/ledger/analytics";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { post } from "@/lib/server/ledger/post";
import { postInvoice } from "@/lib/server/ledger/ar";
import type { Invoice, InvoiceLine, TaxProfileCode } from "@/lib/domain/types";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-an";
/** The entity with something wrong in it — one deliberate case per test. */
const ENT = "t-ent-an";
/** Books in good order. The empty state has to be reachable or it is decoration. */
const CLEAN = "t-ent-an-clean";
/** Enough entries for Benford to be allowed an opinion, and a shape it will dislike. */
const MANY = "t-ent-an-benford";
/** Rows that reached the ledger outside the posting path. */
const BROKEN = "t-ent-an-broken";

/** Every entry ENT holds. Asserted, so a stray posting in the seed is caught. */
const ENT_ENTRIES = 62;

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
const invLine = (net: number, vat: number, profile: TaxProfileCode = "STANDARD_5"): InvoiceLine => ({
  id: `l${++seq}`, lineNo: seq, description: "Consulting", qty: 1, unitCode: "C62",
  unitPriceMinor: net, taxProfileCode: profile, lineNetMinor: net, lineVatMinor: vat,
});

function doc(entityId: string, issueDate: string, lines: InvoiceLine[], number: string): Invoice {
  const net = lines.reduce((a, l) => a + l.lineNetMinor, 0);
  const vat = lines.reduce((a, l) => a + l.lineVatMinor, 0);
  return {
    id: `an-${number}`, orgId: ORG, entityId, direction: "OUTBOUND", docType: "TAX_INVOICE",
    number, issueDate, supplyDate: issueDate, currency: "AED",
    buyer: { nameEn: "Al Noor Trading" },
    seller: { nameEn: "Seller", address: { emirate: "DU", country: "AE" } },
    lines,
    totals: { taxExclusiveMinor: net, vatMinor: vat, taxInclusiveMinor: net + vat, payableMinor: net + vat, perCategory: [] },
    lifecycleStatus: "SENT", exchangeStatus: "NOT_SENT", reportingStatusC2: "NOT_REPORTED", source: "EDITOR",
    compliance: { taxableEventDate: issueDate, daysRemaining: 14, breached: false },
    createdAt: `${issueDate}T00:00:00Z`, updatedAt: `${issueDate}T00:00:00Z`,
  } as Invoice;
}

/** A cost paid out of the current account — the shape nearly every seed entry takes. */
const spend = (opts: {
  entityId: string;
  date: string;
  minor: number;
  account?: string;
  memo?: string;
  settlesId?: string;
  actorId?: string;
}) =>
  post({
    orgId: ORG,
    entityId: opts.entityId,
    entryDate: opts.date,
    ...(opts.memo === undefined ? {} : { memo: opts.memo }),
    ...(opts.settlesId === undefined ? {} : { settlesId: opts.settlesId }),
    ...(opts.actorId === undefined ? {} : { actorId: opts.actorId }),
    lines: [
      { account: opts.account ?? "6900", debit: opts.minor },
      { account: "1010", credit: opts.minor },
    ],
  });

/**
 * Weekday dates from a start, skipping Saturday and Sunday. The bulk seeds have
 * to avoid the weekend or they would move the weekend count, which is a figure
 * two other assertions depend on being exactly two.
 */
function weekdays(startIso: string, n: number): string[] {
  const out: string[] = [];
  const cursor = new Date(`${startIso}T00:00:00Z`);
  while (out.length < n) {
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

const read = (entityId: string, window?: { from?: string; to?: string }) =>
  ledgerAnalytics({ orgId: ORG, entityId, from: window?.from, to: window?.to ?? "2026-12-31" });

const find = (findings: Finding[], key: string) => findings.find((f) => f.key === key);
const keys = (findings: Finding[]) => findings.map((f) => f.key);
const run = (runs: TestRun[], key: string) => runs.find((r) => r.key === key)!;
/** Every entry named anywhere in the findings, so a "must not be found" is checkable. */
const referenced = (findings: Finding[]) => new Set(findings.flatMap((f) => f.entries.map((e) => e.reference)));

d("ledger analytics", () => {
  beforeAll(async () => {
    await wipe();

    /* ---- the entity with one deliberate case per test --------------------- */

    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });

    // A genuine duplicate: the same bill settled twice, two days apart. This is
    // the pair the whole module exists for.
    await spend({ entityId: ENT, date: "2026-03-03", minor: 1_250_000, memo: "Gulf Steel LLC — bill GS-9981", settlesId: "BILL-GS-7781" });
    await spend({ entityId: ENT, date: "2026-03-05", minor: 1_250_000, memo: "Gulf Steel LLC — bill GS-9981", settlesId: "BILL-GS-7781" });

    // A legitimate near-duplicate: the same rent, the same words, every month.
    // Identical on every axis the duplicate test looks at except the one that
    // matters — a month apart is what a standing charge looks like.
    for (const date of ["2026-01-26", "2026-02-25", "2026-03-25"]) {
      await spend({ entityId: ENT, date, minor: 800_000, account: "6100", memo: "Office rent — Al Quoz" });
    }

    // A second legitimate case: equal amounts on the same day, for two plainly
    // different things. Equality alone must not be a finding.
    await spend({ entityId: ENT, date: "2026-04-10", minor: 330_000, memo: "Etisalat — April" });
    await spend({ entityId: ENT, date: "2026-04-10", minor: 330_000, memo: "DEWA — April" });

    // Round numbers above the threshold, and one large cost that is not round.
    await spend({ entityId: ENT, date: "2026-02-10", minor: 2_500_000, memo: "Annual retainer — Barakat Consulting" });
    await spend({ entityId: ENT, date: "2026-04-15", minor: 5_000_000, memo: "Marketing campaign — spring" });
    await spend({ entityId: ENT, date: "2026-05-20", minor: 1_200_000, memo: "Fit-out contribution" });
    await spend({ entityId: ENT, date: "2026-05-21", minor: 1_347_255, memo: "Warehouse racking" });

    // Manual journals with nothing written on them: one over the threshold, one
    // an order of magnitude over it, and one too small to ask about.
    await spend({ entityId: ENT, date: "2026-05-05", minor: 750_000 });
    await spend({ entityId: ENT, date: "2026-06-08", minor: 6_345_000 });
    await spend({ entityId: ENT, date: "2026-06-09", minor: 20_000 });

    // Dated at the weekend — a Saturday and a Sunday.
    await spend({ entityId: ENT, date: "2026-06-13", minor: 45_000, memo: "Saturday delivery charge" });
    await spend({ entityId: ENT, date: "2026-06-14", minor: 55_000, memo: "Sunday courier" });

    // Keyed in the middle of the night; the hour is forced below, because the
    // clock these were actually seeded at is the clock the test ran at.
    await spend({ entityId: ENT, date: "2026-02-17", minor: 91_000, memo: "Late night reclass one" });
    await spend({ entityId: ENT, date: "2026-02-18", minor: 92_000, memo: "Late night reclass two" });

    // Keyed months after the month they were posted into.
    await spend({ entityId: ENT, date: "2026-01-20", minor: 410_000, memo: "Accrual trued up after January closed" });
    await spend({ entityId: ENT, date: "2026-02-11", minor: 220_000, memo: "Supplier invoice arrived in April" });

    // The only pairing these books make once: FX loss against FX gain.
    await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-06-10", memo: "Reclassify the June revaluation",
      lines: [{ account: "6800", debit: 130_000 }, { account: "4950", credit: 130_000 }],
    });

    // One clerk's own pattern: forty small entries and one that is not.
    const clerkDays = weekdays("2026-04-20", 41);
    for (let i = 0; i < 40; i++) {
      await spend({ entityId: ENT, date: clerkDays[i], minor: 10_000, account: "6400", memo: `Site visit ${i + 1}`, actorId: "u-clerk" });
    }
    await spend({ entityId: ENT, date: clerkDays[40], minor: 4_321_000, account: "6400", memo: "Client hospitality — Abu Dhabi", actorId: "u-clerk" });

    /* ---- books in good order --------------------------------------------- */

    await openFiscalYear({ orgId: ORG, entityId: CLEAN, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: CLEAN });
    // Forty-five is past the history every frequency test needs, so those tests
    // run and report "nothing" rather than declining — which is the difference
    // this entity exists to prove.
    const cleanDays = weekdays("2026-01-05", 45);
    for (let i = 0; i < 45; i++) {
      await spend({
        entityId: CLEAN, date: cleanDays[i], minor: 123_456 + i * 911, account: "6400",
        memo: `Client visit ${i + 1}`, actorId: "u-book",
      });
    }

    /* ---- enough entries for Benford, shaped so it will object ------------- */

    await openFiscalYear({ orgId: ORG, entityId: MANY, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: MANY });
    for (let i = 0; i < 320; i++) {
      // Every amount between 500.00 and 522.33, so every leading digit is a 5.
      const date = `2026-0${1 + (i % 6)}-${String(1 + (i % 28)).padStart(2, "0")}`;
      await spend({ entityId: MANY, date, minor: 50_000 + i * 7, memo: `Handling fee ${i + 1}` });
    }

    /* ---- rows that got in outside the posting path ------------------------ */

    await openFiscalYear({ orgId: ORG, entityId: BROKEN, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: BROKEN });
    await spend({ entityId: BROKEN, date: "2026-03-02", minor: 111_000, memo: "First" });
    await spend({ entityId: BROKEN, date: "2026-03-03", minor: 222_000, memo: "Second" });
    await spend({ entityId: BROKEN, date: "2026-03-04", minor: 333_000, memo: "Third" });
    await postInvoice({ orgId: ORG, invoice: doc(BROKEN, "2026-03-10", [invLine(400_000, 20_000)], "INV-AN-1") });

    /* ---- the clocks, and the damage --------------------------------------- */

    // Everything below reaches past the triggers, and has to. A posted entry is
    // immutable by an allowlist — only `status` may ever change — and a posted
    // entry cannot be deleted at all, so none of this is reachable through the
    // application or through raw SQL with the guards live. That is the point
    // twice over: the clocks have to be set to make the test a function of the
    // code rather than of the hour the suite happens to run at, and the two
    // damaged rows have to reproduce what a hand-run statement or a restore
    // from the wrong backup leaves behind, which is the only way the ledger can
    // arrive in the state those two checks exist to find.
    const gone = await db.journalEntry.findFirst({ where: { orgId: ORG, entityId: BROKEN, series: "GJ", number: "00002" } });
    const setCreated = (memo: string, at: string) =>
      db.$executeRawUnsafe(
        `UPDATE "JournalEntry" SET "createdAt" = timestamp '${at}' ` +
          `WHERE "orgId" = '${ORG}' AND "entityId" = '${ENT}' AND memo = '${memo}'`,
      );

    await db.$transaction([
      db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),

      // Half past nine in the morning UTC — half past one in the afternoon in
      // the Gulf, comfortably inside any definition of working hours. Without
      // this the whole org would be flagged as out-of-hours whenever the suite
      // ran in the evening, which is a test that passes by the clock.
      db.$executeRawUnsafe(
        `UPDATE "JournalEntry" SET "createdAt" = "entryDate" + interval '9 hours 30 minutes' WHERE "orgId" = '${ORG}'`,
      ),
      setCreated("Late night reclass one", "2026-02-17 22:30:00"),
      setCreated("Late night reclass two", "2026-02-18 23:15:00"),
      setCreated("Accrual trued up after January closed", "2026-04-15 09:30:00"),
      setCreated("Supplier invoice arrived in April", "2026-04-20 09:30:00"),

      // A posted entry removed from the ledger, leaving its number allocated
      // and nothing carrying it.
      db.$executeRawUnsafe(`DELETE FROM "JournalLine" WHERE "entryId" = '${gone!.id}'`),
      db.$executeRawUnsafe(`DELETE FROM "JournalEntry" WHERE id = '${gone!.id}'`),

      // An entry that went in through the receivables subledger, relabelled as
      // a manual journal afterwards. The line guard refuses a manual journal
      // against a control account at the moment the line is written, so
      // rewriting the entry's provenance later is the shape this arrives in.
      db.$executeRawUnsafe(
        `UPDATE "JournalEntry" SET source = 'manual' WHERE "orgId" = '${ORG}' AND "entityId" = '${BROKEN}' AND source = 'invoice'`,
      ),
    ]);
  }, 180_000);

  afterAll(async () => {
    await wipe();
    await db.$disconnect();
  });

  /* ------------------------------------------------------------- the shape */

  it("runs every test in one read and accounts for each of them", async () => {
    const a = await read(ENT);
    expect(a.checked).toBe(10);
    expect(a.runs.length).toBe(a.checked);
    expect(a.entityId).toBe(ENT);
    expect(a.currency).toBe("AED");
    expect(a.population).toBe(ENT_ENTRIES);
    expect(a.truncated).toBe(false);
    // Every test names itself, says what it read and says something about it.
    for (const r of a.runs) {
      expect(r.label.length).toBeGreaterThan(3);
      expect(r.note.length).toBeGreaterThan(20);
      expect(["found", "clean", "skipped", "failed"]).toContain(r.outcome);
    }
    expect(new Set(a.runs.map((r) => r.key)).size).toBe(a.runs.length);
    // Nothing threw: a failed row here would be a defect in a test, not a finding.
    expect(a.runs.filter((r) => r.outcome === "failed")).toEqual([]);
  });

  it("sorts by severity and then by the money at stake", async () => {
    const a = await read(ENT);
    const rank = { high: 0, medium: 1, low: 2 } as const;
    const order = a.findings.map((f) => rank[f.severity]);
    expect(order).toEqual([...order].sort((x, y) => x - y));

    for (const sev of ["high", "medium", "low"] as const) {
      const amounts = a.findings.filter((f) => f.severity === sev).map((f) => BigInt(f.amountMinor ?? "0"));
      expect(amounts).toEqual([...amounts].sort((x, y) => (x > y ? -1 : x < y ? 1 : 0)));
    }
    expect(a.counts.high).toBe(a.findings.filter((f) => f.severity === "high").length);
    expect(a.counts.high + a.counts.medium + a.counts.low).toBe(a.findings.length);
  });

  it("gives every finding entries a reader can go and look at", async () => {
    const a = await read(ENT);
    expect(a.findings.length).toBeGreaterThan(4);
    expect(new Set(keys(a.findings)).size).toBe(a.findings.length);
    for (const f of a.findings) {
      expect(f.detail.length).toBeGreaterThan(60);
      expect(f.count).toBeGreaterThan(0);
      if (f.amountMinor !== undefined) expect(() => BigInt(f.amountMinor!)).not.toThrow();
      for (const e of f.entries) {
        expect(e.reference).toMatch(/^[A-Z]+-\d+$/);
        expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(() => BigInt(e.amountMinor)).not.toThrow();
      }
    }
  });

  /* ---------------------------------------------------------- duplicates */

  it("finds a bill that was paid twice, and prices the exposure", async () => {
    const a = await read(ENT);
    const dup = a.findings.filter((f) => f.key.startsWith("duplicate_payment:"));
    expect(dup.length).toBe(1);

    const f = dup[0];
    expect(f.severity).toBe("high");
    expect(f.count).toBe(2);
    // Two payments of 12,500.00; one of them is the money that comes back.
    expect(f.amountMinor).toBe("1250000");
    expect(f.detail).toMatch(/BILL-GS-7781/);
    expect(f.detail).toMatch(/2 days apart/);
    expect(f.entries.map((e) => e.date).sort()).toEqual(["2026-03-03", "2026-03-05"]);
    expect(run(a.runs, "duplicate_payments").outcome).toBe("found");
  });

  it("leaves the monthly rent alone — a month apart is not a duplicate", async () => {
    const a = await read(ENT);
    const named = referenced(a.findings);
    const rent = await db.journalEntry.findMany({
      where: { orgId: ORG, entityId: ENT, memo: "Office rent — Al Quoz" },
      select: { series: true, number: true },
    });
    expect(rent.length).toBe(3);
    for (const r of rent) expect(named.has(`${r.series}-${r.number}`)).toBe(false);
  });

  it("leaves two equal payments for different things alone", async () => {
    const a = await read(ENT);
    // Etisalat and DEWA: same amount, same day, nothing else in common.
    const dupEntries = a.findings
      .filter((f) => f.key.startsWith("duplicate_payment:"))
      .flatMap((f) => f.entries.map((e) => e.memo));
    expect(dupEntries).not.toContain("Etisalat — April");
    expect(dupEntries).not.toContain("DEWA — April");
  });

  it("counts only the payments it could have compared", async () => {
    const a = await read(ENT);
    const r = run(a.runs, "duplicate_payments");
    // Every entry that moved money out of the bank and carried something to
    // identify it: 62 less the FX reclass and the three journals with no memo.
    expect(r.population).toBe(58);
    expect(r.from).toBe("2026-01-20");
  });

  /* -------------------------------------------------------- round numbers */

  it("finds the round costs above the threshold and not the ones below it", async () => {
    const f = find((await read(ENT)).findings, "round_numbers")!;
    expect(f).toBeDefined();
    // 25,000.00 + 50,000.00 + 12,000.00. Not the 12,500.00 duplicates, not the
    // 13,472.55 racking, not the 8,000.00 rent — that one is below the floor.
    expect(f.count).toBe(3);
    expect(f.amountMinor).toBe("8700000");
    // Three of the eight large costs, which is over the quarter that makes
    // roundness a question about the books rather than about one invoice.
    expect(f.severity).toBe("medium");
    expect(f.detail).toMatch(/37\.50%/);
    expect(f.entries.map((e) => e.memo)).toContain("Marketing campaign — spring");
  });

  /* --------------------------------------------------------- time of day */

  it("separates the day an entry claims from the hour it arrived", async () => {
    const a = await read(ENT);
    const weekend = find(a.findings, "weekend_dated")!;
    expect(weekend).toBeDefined();
    expect(weekend.count).toBe(2);
    expect(weekend.amountMinor).toBe("100000");
    expect(weekend.detail).toMatch(/date the entry claims/);

    const night = find(a.findings, "out_of_hours")!;
    expect(night).toBeDefined();
    expect(night.count).toBe(2);
    expect(night.amountMinor).toBe("183000");
    expect(night.detail).toMatch(/cannot be chosen or backdated/);
    // The two are different entries: the weekend ones arrived in office hours.
    expect(weekend.entries.map((e) => e.id).some((id) => night.entries.some((n) => n.id === id))).toBe(false);
  });

  /* ------------------------------------------------------- late postings */

  it("finds entries keyed long after the month they were posted into", async () => {
    const f = find((await read(ENT)).findings, "late_posting")!;
    expect(f).toBeDefined();
    expect(f.count).toBe(2);
    expect(f.amountMinor).toBe("630000");
    // January ended on the 31st and the entry was written on 15 April.
    expect(f.detail).toMatch(/74 days/);
    expect(f.detail).toMatch(/2026-01/);
    expect(f.severity).toBe("medium");
  });

  /* -------------------------------------------------- unexplained journals */

  it("finds the large manual journals that say nothing", async () => {
    const f = find((await read(ENT)).findings, "unexplained_journal")!;
    expect(f).toBeDefined();
    // The 7,500.00 and the 63,450.00; not the 200.00.
    expect(f.count).toBe(2);
    expect(f.amountMinor).toBe("7095000");
    // One of them is ten times the threshold, which is what lifts it.
    expect(f.severity).toBe("high");
    for (const e of f.entries) expect(e.memo).toBeNull();
  });

  /* ------------------------------------------------------------ pairings */

  it("names the pairing these books make once and not the one they make daily", async () => {
    const a = await read(ENT);
    const rare = a.findings.filter((f) => f.key.startsWith("rare_pairing:"));
    expect(keys(rare)).toEqual(["rare_pairing:6800>4950"]);
    expect(rare[0].count).toBe(1);
    // Typed by hand rather than raised from a document, which is the half of
    // the observation worth reading.
    expect(rare[0].severity).toBe("medium");
    expect(rare[0].detail).toMatch(/this entity's own history/);
    // 6400 against 1010 happens forty-one times here and is not reported.
    expect(keys(a.findings)).not.toContain("rare_pairing:6400>1010");
  });

  it("refuses to call anything rare in a ledger with no history", async () => {
    const a = await read(BROKEN);
    const r = run(a.runs, "rare_pairings");
    expect(r.outcome).toBe("skipped");
    expect(r.note).toMatch(/not enough of this entity's own history/);
  });

  /* -------------------------------------------------------------- actors */

  it("measures an actor against their own median and nobody else's", async () => {
    const f = find((await read(ENT)).findings, "actor_outlier:u-clerk")!;
    expect(f).toBeDefined();
    expect(f.count).toBe(1);
    expect(f.amountMinor).toBe("4321000");
    expect(f.severity).toBe("medium");
    // Median 100.00, so the bar is 1,000.00 — nothing to do with the ledger's
    // own scale, which holds entries fifty times larger that are not reported.
    expect(f.detail).toMatch(/AED 100\.00/);
    expect(f.detail).toMatch(/AED 1,000\.00 or more/);
    expect(run((await read(ENT)).runs, "actor_outliers").population).toBe(41);
  });

  /* --------------------------------------------------------- the guarantees */

  it("says so when the control-account guard has held", async () => {
    const a = await read(ENT);
    expect(keys(a.findings)).not.toContain("manual_to_control");
    const r = run(a.runs, "manual_to_control");
    expect(r.outcome).toBe("clean");
    expect(r.population).toBe(ENT_ENTRIES);
    expect(r.note).toMatch(/expected result/);
    expect(r.note).toMatch(/tested rather than something that has been said/);
  });

  it("finds a manual journal on a control account when one got in another way", async () => {
    const f = find((await read(BROKEN)).findings, "manual_to_control")!;
    expect(f).toBeDefined();
    expect(f.severity).toBe("high");
    expect(f.count).toBe(1);
    expect(f.detail).toMatch(/1100/);
    expect(f.detail).toMatch(/did not arrive through the posting path/);
  });

  it("proves the numbering is gapless against the sequence's own counter", async () => {
    const r = run((await read(ENT)).runs, "numbering");
    expect(r.outcome).toBe("clean");
    expect(r.population).toBe(ENT_ENTRIES);
    expect(r.note).toMatch(/Every number the sequence has ever handed out/);
    expect(r.note).toMatch(/rather than assumed/);
  });

  it("finds the hole an entry left when it was deleted outside the posting path", async () => {
    const f = find((await read(BROKEN)).findings, "numbering_gap")!;
    expect(f).toBeDefined();
    expect(f.severity).toBe("high");
    expect(f.detail).toMatch(/GJ-00002/);
    expect(f.detail).toMatch(/out of 3 allocated/);
    // The entries behind this finding are the ones that are not there.
    expect(f.entries).toEqual([]);
    // And it is not reported as a gap in the invoice series, which is intact.
    expect(f.detail).not.toMatch(/SI-/);
  });

  /* ------------------------------------------------------------- Benford */

  it("refuses a verdict on a population too small to have one", async () => {
    const a = await read(ENT);
    expect(a.benford.population).toBe(ENT_ENTRIES);
    expect(a.benford.minimum).toBe(300);
    expect(a.benford.verdict).toBeNull();
    expect(a.benford.madBp).toBeNull();
    expect(a.benford.note).toMatch(/no verdict is offered/i);
    // The counts are still shown, because they are a fact about these books.
    expect(a.benford.digits.length).toBe(9);
    expect(a.benford.digits.reduce((s, x) => s + x.observed, 0)).toBe(ENT_ENTRIES);
    // And the test says it could not look, rather than saying nothing.
    expect(run(a.runs, "benford").outcome).toBe("skipped");
    expect(keys(a.findings)).not.toContain("benford");
  });

  it("keeps the expected distribution in basis points that sum to exactly 10,000", async () => {
    const a = await read(ENT);
    expect(a.benford.digits.map((x) => x.expectedBp)).toEqual([3010, 1761, 1249, 969, 792, 669, 580, 512, 458]);
    expect(a.benford.digits.reduce((s, x) => s + x.expectedBp, 0)).toBe(10_000);
    for (const x of a.benford.digits) expect(Number.isInteger(x.observedBp)).toBe(true);
  });

  it("offers a verdict once the population is large enough, and shows the shape", async () => {
    const a = await read(MANY);
    expect(a.benford.population).toBeGreaterThanOrEqual(300);
    expect(a.benford.verdict).toBe("deviates");
    expect(a.benford.madBp).toBeGreaterThan(150);

    // Every amount was seeded between 500.00 and 522.33.
    const five = a.benford.digits.find((x) => x.digit === 5)!;
    expect(five.observedBp).toBe(10_000);
    expect(five.differenceBp).toBe(10_000 - 792);
    expect(a.benford.digits.find((x) => x.digit === 1)!.observed).toBe(0);

    const f = find(a.findings, "benford")!;
    expect(f).toBeDefined();
    // A prompt to look at a population, never a reason to look at a person.
    expect(f.severity).toBe("low");
    expect(f.detail).toMatch(/constrained population/);
    expect(run(a.runs, "benford").outcome).toBe("found");
  });

  /* ---------------------------------------------------------- good books */

  it("says every test ran and found nothing, rather than showing nothing", async () => {
    const a = await read(CLEAN);
    expect(a.findings).toEqual([]);
    expect(a.counts).toEqual({ high: 0, medium: 0, low: 0 });
    expect(a.population).toBe(45);

    // Nine tests looked and found nothing; the tenth said why it could not.
    expect(a.runs.filter((r) => r.outcome === "clean").length).toBe(9);
    expect(a.runs.filter((r) => r.outcome === "found" || r.outcome === "failed")).toEqual([]);
    expect(run(a.runs, "benford").outcome).toBe("skipped");

    // The frequency tests ran here rather than declining, which is the whole
    // point of seeding enough history into a clean set of books.
    expect(run(a.runs, "rare_pairings").outcome).toBe("clean");
    expect(run(a.runs, "actor_outliers").outcome).toBe("clean");
    expect(run(a.runs, "rare_pairings").population).toBe(45);

    for (const r of a.runs) {
      expect(r.note.length).toBeGreaterThan(20);
      if (r.outcome === "clean") expect(r.population).toBeGreaterThanOrEqual(0);
    }
    // A test with nothing eligible still says what it looked for.
    const round = run(a.runs, "round_numbers");
    expect(round.population).toBe(0);
    expect(round.note).toMatch(/found none/);
  });

  it("keeps one entity's findings out of another's", async () => {
    const [mess, clean] = await Promise.all([read(ENT), read(CLEAN)]);
    // By id, not by reference: numbering restarts in every entity, so ENT and
    // CLEAN both hold a GJ-00007 and comparing the references would prove
    // nothing at all.
    const named = new Set(mess.findings.flatMap((f) => f.entries.map((e) => e.id)));
    expect(named.size).toBeGreaterThan(0);
    const elsewhere = await db.journalEntry.findMany({
      where: { orgId: ORG, entityId: { in: [CLEAN, MANY, BROKEN] } },
      select: { id: true },
    });
    for (const e of elsewhere) expect(named.has(e.id)).toBe(false);
    expect(clean.entityId).toBe(CLEAN);
  });

  /* -------------------------------------------------------------- window */

  it("reads the window it is given and says what it actually read", async () => {
    const whole = await read(ENT);
    const half = await read(ENT, { from: "2026-05-01", to: "2026-06-30" });
    expect(half.population).toBeLessThan(whole.population);
    expect(half.from).toBe("2026-05-01");
    expect(half.populationFrom! >= "2026-05-01").toBe(true);
    expect(half.populationTo! <= "2026-06-30").toBe(true);
    // The duplicate is in March, so a window that excludes it must not report it.
    expect(keys(half.findings).some((k) => k.startsWith("duplicate_payment:"))).toBe(false);
    // And the test still says it ran, over a smaller population.
    expect(run(half.runs, "duplicate_payments").outcome).toBe("clean");
    expect(run(half.runs, "duplicate_payments").population).toBeLessThan(58);
  });

  it("refuses a date it cannot read rather than quietly using today", async () => {
    await expect(ledgerAnalytics({ orgId: ORG, entityId: ENT, from: "the first of May" }))
      .rejects.toThrow(/valid date/i);
  });

  it("refuses a window that runs backwards", async () => {
    await expect(ledgerAnalytics({ orgId: ORG, entityId: ENT, from: "2026-06-01", to: "2026-01-01" }))
      .rejects.toThrow(/is after/i);
  });

  it("has nothing to say about an entity with no ledger, and says that too", async () => {
    const a = await read("t-ent-an-nothing");
    expect(a.findings).toEqual([]);
    expect(a.population).toBe(0);
    expect(a.runs.length).toBe(10);
    for (const r of a.runs) expect(r.note.length).toBeGreaterThan(20);
    expect(run(a.runs, "numbering").outcome).toBe("skipped");
  });
});
