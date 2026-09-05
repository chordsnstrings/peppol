import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  notificationCentre, acknowledge, snooze, bringBack, notificationHistory,
} from "@/lib/server/ledger/notifications";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { post } from "@/lib/server/ledger/post";
import { importStatement } from "@/lib/server/ledger/bank";
import { addItem, setReorderLevel } from "@/lib/server/ledger/inventory";
import { addBorrowing, addCovenant } from "@/lib/server/ledger/borrowings";
import { issueFacility } from "@/lib/server/ledger/trade-finance";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-ntf";
const ENT = "t-ent-ntf";
/** A second entity with no ledger at all, used to make a source genuinely throw. */
const BARE = "t-ent-ntf-bare";
const S = { orgId: ORG, entityId: ENT };
const ACTOR = "t-user-ntf";

/** The day nearly everything below is read as at. */
const A = "2026-03-15";
/** Inside the window where the 2026-Q1 VAT return is due but not yet late. */
const VAT_DAY = "2026-04-20";

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "NotificationEvent" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "NotificationAck" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "BankStatementLine" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "TaxRegistration" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "BorrowingCovenant" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Borrowing" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "TradeFacilityEvent" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "TradeFacility" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "InventoryMovement" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "StockBatch" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "InventoryItem" WHERE "orgId" = '${ORG}'`),
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

/**
 * A year of books, one sale carrying output tax, three bank lines nobody has
 * matched, and two stock items — one watched and out, one nobody watches.
 *
 * Every finding this file asserts on is worked out by the module that owns it
 * from these postings — none of them is faked, and none of them is written into
 * a notifications table, because there is no notifications table for findings.
 */
async function seed() {
  await openFiscalYear({ ...S, label: "2026", startsOn: "2026-01-01" });
  await openBooks(S);

  // A sale with 5% output tax, so the VAT return for 2026-Q1 has something on
  // it. `source: "invoice"` rather than a manual journal because 2100 is a
  // control account and the database refuses a manual journal on one.
  await post({
    ...S,
    entryDate: "2026-02-10",
    source: "invoice",
    memo: "Sale to Alpha Trading",
    lines: [
      { account: "1010", debit: 105_000n, memo: "Bank" },
      { account: "4000", credit: 100_000n, taxCode: "STANDARD_5", memo: "Goods" },
      { account: "2100", credit: 5_000n, taxCode: "OUTPUT_VAT", memo: "Output tax" },
    ],
  });

  await importStatement({
    ...S,
    accountCode: "1010",
    batch: "ntf-first",
    lines: [
      { postedOn: "2026-02-01", description: "CARD FEES", amountMinor: -1_200n },
      { postedOn: "2026-02-02", description: "TRANSFER IN", amountMinor: 40_000n },
      { postedOn: "2026-02-03", description: "STANDING ORDER", amountMinor: -7_500n },
    ],
  });

  // Two items, so a SECOND source has something real to say and the queue is
  // demonstrably not one module wearing a new coat. WIDGET is watched and there
  // is none of it; GADGET is watched by nobody, which is a different statement
  // from being fine.
  await addItem({ ...S, item: { sku: "WIDGET", name: "Widget", uom: "ea" } });
  await setReorderLevel({ ...S, sku: "WIDGET", reorderLevelMilli: 10_000n });
  await addItem({ ...S, item: { sku: "GADGET", name: "Gadget", uom: "ea" } });

  // A loan with two covenants: one this ledger can measure and which fails on
  // these figures, and one it cannot measure at all. The second is the point —
  // an untested covenant must never be summarised as compliance.
  await addBorrowing({
    ...S,
    borrowing: {
      code: "LOAN-1", lender: "Emirates NBD", principalMinor: 1_000_000_00n,
      drawdownOn: "2026-01-05", statedRateBps: 550, termMonths: 60,
    },
  });
  await addCovenant({
    ...S,
    covenant: {
      borrowingCode: "LOAN-1", code: "NW", metric: "MIN_NET_WORTH",
      direction: "MIN", thresholdMinor: 500_000_000_00n,
      wording: "Net worth shall at no time be less than AED 500,000,000.",
    },
  });
  await addCovenant({
    ...S,
    covenant: {
      borrowingCode: "LOAN-1", code: "NEG-PLEDGE", metric: "OTHER",
      wording: "The borrower shall grant no security over its assets.",
    },
  });

  // A guarantee expiring inside the ninety-day window, with margin the bank is
  // holding against it.
  await issueFacility({
    ...S,
    facility: {
      reference: "LG-9001", kind: "BANK_GUARANTEE", bank: "Emirates NBD",
      beneficiary: "Dubai Municipality", amountMinor: 250_000_00n, marginMinor: 25_000_00n,
      issuedOn: "2026-01-10", expiresOn: "2026-04-05",
    },
  });
}

const BANK = "attention:bank_unmatched";
const PERIODS = "attention:periods_open";
const VAT = "attention:vat_return@Jan-Mar 2026";

d("the notification centre", () => {
  beforeAll(async () => {
    await wipe();
    await seed();
  });
  afterAll(async () => {
    await wipe();
    await db.$disconnect();
  });

  it("gathers a real finding from a real source rather than making one up", async () => {
    const centre = await notificationCentre({ ...S, asOf: A });

    // Three statement lines were imported and nothing was matched to them, so
    // the reconciliation says three. The notification says three because it
    // asked the reconciliation, not because it counted rows itself.
    const bank = centre.notices.find((n) => n.key === BANK);
    expect(bank).toBeDefined();
    expect(bank!.itemCount).toBe(3);
    expect(bank!.source).toBe("attention");
    expect(bank!.state).toBe("open");
    expect(bank!.outstanding).toBe(true);
    // The oldest line is 42 days old, past terms, which is "soon" on the
    // attention list and a warning here. The mapping is a rename, not a view.
    expect(bank!.severity).toBe("warning");

    // Every source is named, whether it had anything to say or not, so
    // "nothing found" can be told apart from "nothing asked".
    expect(centre.sources.length).toBeGreaterThanOrEqual(12);
    expect(centre.sources.every((s) => s.ok)).toBe(true);
    expect(centre.sources.map((s) => s.key)).toContain("month-end");
    expect(centre.digest.outstanding).toBe(centre.notices.filter((n) => n.outstanding).length);

    // And a second, unrelated module reporting its own fact through the same
    // queue: WIDGET is below the level somebody set, and nothing is on order.
    const stock = centre.notices.find((n) => n.key === "inventory:reorder");
    expect(stock).toBeDefined();
    expect(stock!.source).toBe("inventory");
    expect(stock!.severity).toBe("advisory");
    expect(stock!.detail).toMatch(/WIDGET/);
    // Nobody has said anything about GADGET, which is information, not a job.
    expect(centre.notices.find((n) => n.key === "inventory:unmonitored")!.severity).toBe("information");
  });

  it("gives a deadline only where the source has one", async () => {
    const centre = await notificationCentre({ ...S, asOf: A });

    // Unmatched bank lines are not late for anything. Nobody has set a date by
    // which they must be matched, so the row does not carry one.
    const bank = centre.notices.find((n) => n.key === BANK)!;
    expect(bank.dueOn).toBeNull();
    expect(bank.daysToDue).toBeNull();
    expect(bank.statutory).toBe(false);

    // And the digest does not quietly count it as due this week.
    expect(centre.digest.dueSoon.some((r) => r.key === BANK)).toBe(false);
    expect(centre.digest.overdue.some((r) => r.key === BANK)).toBe(false);
  });

  it("degrades a source that throws to one row and keeps the rest of the page", async () => {
    // An entity with no ledger opened at all. `vatReturn` refuses outright —
    // it cannot compute a return with no book — while the other sources have
    // nothing to say and say so.
    const centre = await notificationCentre({ orgId: ORG, entityId: BARE, asOf: A });

    const unread = centre.sources.filter((s) => !s.ok);
    expect(unread.map((s) => s.key)).toContain("vat");
    expect(unread.find((s) => s.key === "vat")!.reason).toMatch(/No ledger has been opened/);

    const row = centre.notices.find((n) => n.key === "notifications:unreadable@vat");
    expect(row).toBeDefined();
    // A source that did not answer is not a source that had nothing to say.
    expect(row!.severity).toBe("warning");
    expect(row!.detail).toMatch(/Everything else on this page still ran/);

    // One row lost, not the page: the rest still ran and are still reported.
    expect(centre.sources.filter((s) => s.ok).length).toBeGreaterThanOrEqual(6);
    expect(centre.notices.length).toBeGreaterThan(1);
  });

  it("remembers an acknowledgement across a re-run", async () => {
    await acknowledge({
      ...S, key: BANK, actorId: ACTOR, actorName: "Nadia", reason: "The bank is sending a corrected file", asOf: A,
    });

    // A completely fresh read — nothing is cached between the two.
    const again = await notificationCentre({ ...S, asOf: A });
    const bank = again.notices.find((n) => n.key === BANK)!;

    expect(bank.state).toBe("acknowledged");
    expect(bank.outstanding).toBe(false);
    expect(bank.returnedBecause).toBeNull();
    expect(bank.dealtWith).toMatchObject({
      action: "acknowledged",
      actorId: ACTOR,
      actorName: "Nadia",
      reason: "The bank is sending a corrected file",
      itemCount: 3,
    });
    expect(again.digest.acknowledged).toBe(1);
  });

  it("brings an acknowledged finding back when it gets worse", async () => {
    // Forty-four more unmatched lines. The wording of the row changes with
    // them — it names the count and the total — which is exactly why the
    // identity is not the wording.
    await importStatement({
      ...S,
      accountCode: "1010",
      batch: "ntf-second",
      lines: Array.from({ length: 44 }, (_, i) => ({
        postedOn: "2026-02-20",
        description: `CHARGE ${i + 1}`,
        amountMinor: BigInt(-(100 + i)),
      })),
    });

    const worse = await notificationCentre({ ...S, asOf: A });
    const bank = worse.notices.find((n) => n.key === BANK)!;

    // Same key: it is the same finding about the same thing.
    expect(bank.key).toBe(BANK);
    expect(bank.itemCount).toBe(47);
    // But not the same fact, so the acknowledgement no longer covers it.
    expect(bank.state).toBe("returned");
    expect(bank.outstanding).toBe(true);
    expect(bank.returnedBecause).toMatch(/covered 3 .*covers 47/);
    // The acknowledgement itself is not lost — it still says what was seen.
    expect(bank.dealtWith!.itemCount).toBe(3);
    expect(worse.digest.returned).toBe(1);
    expect(worse.digest.acknowledged).toBe(0);
  });

  it("puts a snoozed row back on the day it names, and not before", async () => {
    // Two months have ended and neither has been closed. Nothing about that
    // changes over the next few days, so the only thing that can bring this
    // row back in the reads below is the snooze running out.
    const before = await notificationCentre({ ...S, asOf: A });
    expect(before.notices.find((n) => n.key === PERIODS)!.itemCount).toBe(2);

    await snooze({ ...S, key: PERIODS, actorId: ACTOR, until: "2026-03-18", reason: "Closing both on Friday", asOf: A });

    const held = await notificationCentre({ ...S, asOf: A });
    const still = held.notices.find((n) => n.key === PERIODS)!;
    expect(still.state).toBe("snoozed");
    expect(still.outstanding).toBe(false);
    expect(held.digest.snoozedUntil).toEqual([
      expect.objectContaining({ key: PERIODS, until: "2026-03-18", daysToReturn: 3 }),
    ]);

    // The day before it is due back it is still away.
    const eve = await notificationCentre({ ...S, asOf: "2026-03-17" });
    expect(eve.notices.find((n) => n.key === PERIODS)!.state).toBe("snoozed");

    // On the day, it is back, and it says why.
    const due = await notificationCentre({ ...S, asOf: "2026-03-18" });
    const back = due.notices.find((n) => n.key === PERIODS)!;
    expect(back.state).toBe("returned");
    expect(back.outstanding).toBe(true);
    expect(back.returnedBecause).toMatch(/snoozed until 2026-03-18/);
    expect(back.itemCount).toBe(2);

    await bringBack({ ...S, key: PERIODS, actorId: ACTOR });
  });

  it("refuses a snooze that reaches a statutory deadline, and says which one", async () => {
    const centre = await notificationCentre({ ...S, asOf: VAT_DAY });
    const vat = centre.notices.find((n) => n.key === VAT);
    expect(vat).toBeDefined();
    // The FTA gives 28 days after the quarter, so 2026-Q1 falls due 2026-04-28.
    expect(vat!.dueOn).toBe("2026-04-28");
    expect(vat!.statutory).toBe(true);
    expect(vat!.daysToDue).toBe(8);
    // Back one day from the deadline, never to it: a row that returns on the
    // morning something is due has been put off past being any use.
    expect(vat!.snoozeLimit).toBe("2026-04-27");

    await expect(
      snooze({ ...S, key: VAT, actorId: ACTOR, until: "2026-05-10", asOf: VAT_DAY }),
    ).rejects.toThrow(/due on 2026-04-28, a deadline set by law/);

    // On the day itself is just as refused as past it.
    await expect(
      snooze({ ...S, key: VAT, actorId: ACTOR, until: "2026-04-28", asOf: VAT_DAY }),
    ).rejects.toThrow(/on or past the day it is due/);

    // Nothing was written by either refusal.
    const after = await notificationCentre({ ...S, asOf: VAT_DAY });
    expect(after.notices.find((n) => n.key === VAT)!.state).toBe("open");
  });

  it("allows a snooze that ends before the deadline", async () => {
    await snooze({ ...S, key: VAT, actorId: ACTOR, until: "2026-04-24", reason: "Waiting on one purchase invoice", asOf: VAT_DAY });

    const held = await notificationCentre({ ...S, asOf: VAT_DAY });
    expect(held.notices.find((n) => n.key === VAT)!.state).toBe("snoozed");

    // And it is back with four days to spare, in time to be filed.
    const back = await notificationCentre({ ...S, asOf: "2026-04-24" });
    const row = back.notices.find((n) => n.key === VAT)!;
    expect(row.state).toBe("returned");
    expect(row.daysToDue).toBe(4);
    expect(back.digest.dueSoon.map((r) => r.key)).toContain(VAT);

    await bringBack({ ...S, key: VAT, actorId: ACTOR });
  });

  it("keeps the deadline rule in the database, not only in the application", async () => {
    // The application refuses it above. This is the same rule attacked
    // directly, because a rule only the application enforces is a rule an
    // import or a future module walks straight through.
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "NotificationAck" ("id","orgId","entityId","key","action","actorId","severity","dueOn","snoozeUntil","updatedAt")
         VALUES ('ntf-raw-1','${ORG}','${ENT}','raw:test','snoozed','${ACTOR}','warning',DATE '2026-04-28',DATE '2026-04-28',now())`,
      ),
    ).rejects.toThrow(/NotificationAck_snooze_before_due_check/);

    // And a snooze with no day to come back on is not a snooze.
    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO "NotificationAck" ("id","orgId","entityId","key","action","actorId","severity","updatedAt")
         VALUES ('ntf-raw-2','${ORG}','${ENT}','raw:test','snoozed','${ACTOR}','warning',now())`,
      ),
    ).rejects.toThrow(/NotificationAck_snooze_date_check/);
  });

  it("never lets a blocker be acknowledged away, or put off far", async () => {
    // By June the two unclosed months are far enough past their ends that the
    // attention list calls them urgent, which is a blocker here.
    const LATE = "2026-06-05";
    const centre = await notificationCentre({ ...S, asOf: LATE });
    const periods = centre.notices.find((n) => n.key === PERIODS)!;
    expect(periods.severity).toBe("blocker");
    expect(periods.mayAcknowledge).toBe(false);

    await expect(
      acknowledge({ ...S, key: PERIODS, actorId: ACTOR, asOf: LATE }),
    ).rejects.toThrow(/cannot be acknowledged away/);

    // It can be deferred, because a deferral comes back on its own — but only
    // as far as a week, or "cannot be acknowledged" would be a formality.
    expect(periods.snoozeLimit).toBe("2026-06-12");
    await expect(
      snooze({ ...S, key: PERIODS, actorId: ACTOR, until: "2026-06-20", asOf: LATE }),
    ).rejects.toThrow(/blocker, so it can be put off by at most 7 days/);

    await snooze({ ...S, key: PERIODS, actorId: ACTOR, until: "2026-06-10", asOf: LATE });
    const held = await notificationCentre({ ...S, asOf: LATE });
    expect(held.notices.find((n) => n.key === PERIODS)!.state).toBe("snoozed");

    await bringBack({ ...S, key: PERIODS, actorId: ACTOR });
  });

  it("refuses to act on a row that is not on the list", async () => {
    await expect(
      acknowledge({ ...S, key: "attention:no_such_thing", actorId: ACTOR, asOf: A }),
    ).rejects.toThrow(/Nothing on this list is/);
    await expect(bringBack({ ...S, key: "attention:no_such_thing", actorId: ACTOR })).rejects.toThrow(
      /nothing to undo/,
    );
  });

  it("digests what is outstanding, what falls due this week and what comes back when", async () => {
    const soon = "2026-04-25";
    await snooze({ ...S, key: BANK, actorId: ACTOR, until: "2026-05-01", asOf: soon });

    const centre = await notificationCentre({ ...S, asOf: soon });
    const { digest } = centre;

    // Counts are of outstanding work only — something dealt with is not on the
    // list of what somebody has to do.
    const outstanding = centre.notices.filter((n) => n.outstanding);
    expect(digest.outstanding).toBe(outstanding.length);
    for (const severity of ["blocker", "warning", "advisory", "information"] as const) {
      expect(digest.counts[severity]).toBe(outstanding.filter((n) => n.severity === severity).length);
    }

    // Three days to the VAT deadline, so it is on the week's list.
    expect(digest.dueWithinDays).toBe(7);
    expect(digest.dueSoon.map((r) => r.key)).toContain(VAT);
    expect(digest.dueSoon.find((r) => r.key === VAT)!.daysToDue).toBe(3);
    // Everything on that list has a real date. Nothing was given one.
    expect(digest.dueSoon.every((r) => r.dueOn !== null)).toBe(true);

    // And what has been put away says when it comes back, and who put it there.
    expect(digest.snoozed).toBe(1);
    expect(digest.snoozedUntil).toEqual([
      expect.objectContaining({ key: BANK, until: "2026-05-01", daysToReturn: 6, by: ACTOR }),
    ]);

    await bringBack({ ...S, key: BANK, actorId: ACTOR });
  });

  it("keeps the log of who did what, after the acknowledgement itself is gone", async () => {
    const history = await notificationHistory({ ...S, key: BANK });
    // Acknowledged, then snoozed over the top of that, then put back. The ack
    // row only ever held the last of the three; the log holds all of them.
    expect(history.events.map((e) => e.action)).toEqual(["acknowledged", "snoozed", "cleared"]);
    expect(history.events[0]).toMatchObject({
      actorId: ACTOR, actorName: "Nadia", itemCount: 3, reason: "The bank is sending a corrected file",
    });
    expect(history.events[1].snoozeUntil).toBe("2026-05-01");

    // The current position is empty — nothing is hiding the row now.
    const centre = await notificationCentre({ ...S, asOf: A });
    expect(centre.notices.find((n) => n.key === BANK)!.state).toBe("open");
  });

  /* ── the four sources that existed and were never gathered ─────────────── */

  it("reports a breached covenant, and never calls an untested one a pass", async () => {
    const centre = await notificationCentre({ ...S, asOf: A });

    // Net worth of half a billion against a company with one sale on its
    // books. The covenant fails, and a failed covenant is the one finding here
    // that can cost the business its funding.
    const breach = centre.notices.find((n) => n.key === "covenants:breach");
    expect(breach).toBeDefined();
    expect(breach!.severity).toBe("blocker");
    expect(breach!.detail).toMatch(/LOAN-1\/NW/);
    // It is a fact about the books, not a filing, so it must not be dressed as
    // a statutory deadline — those cannot be snoozed at all.
    expect(breach!.statutory).toBeFalsy();

    // And the negative pledge, which nothing in a ledger can measure. Reported
    // as its own row rather than folded into silence: the borrowings screen's
    // own rule is that it never reports a pass for something not measured, and
    // a queue that swallows that would undo it.
    const untested = centre.notices.find((n) => n.key === "covenants:not_tested");
    expect(untested).toBeDefined();
    expect(untested!.severity).toBe("warning");
    expect(untested!.itemCount).toBe(1);
    expect(untested!.detail).toMatch(/not a pass/i);
  });

  it("reports a guarantee about to expire, with the date it actually expires", async () => {
    const centre = await notificationCentre({ ...S, asOf: A });

    const expiring = centre.notices.find((n) => n.key === "trade-finance:expiring@LG-9001");
    expect(expiring).toBeDefined();
    expect(expiring!.detail).toMatch(/LG-9001/);
    // 5 April against an as-at of 15 March: twenty-one days, inside the thirty
    // that make this a warning rather than a note.
    expect(expiring!.dueOn).toBe("2026-04-05");
    expect(expiring!.severity).toBe("warning");
    // The uncalled exposure, which is the face less anything drawn.
    expect(expiring!.amountMinor).toBe("25000000");
  });

  it("names every source it read, so nothing found can be told from nothing asked", async () => {
    const centre = await notificationCentre({ ...S, asOf: A });
    const keys = centre.sources.map((s) => s.key);

    // The four that were built, tested, and gathered by nothing. Each is on the
    // list whether it had anything to say or not — that is the whole point of
    // reporting sources separately from findings.
    for (const k of ["covenants", "vat-schemes", "trade-finance", "dunning"]) {
      expect(keys, `${k} is not being read`).toContain(k);
    }
    // And every one of them ran. A source that throws costs one row and says
    // so; none of these should, against a seeded entity.
    expect(centre.sources.filter((s) => !s.ok).map((s) => s.key)).toEqual([]);
  });

});
