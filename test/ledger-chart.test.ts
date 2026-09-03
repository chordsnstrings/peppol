import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  addAccount, updateAccount, renumberAccount, archiveAccount, restoreAccount,
  deleteAccount, chartWithUsage,
} from "@/lib/server/ledger/chart";
import { post } from "@/lib/server/ledger/post";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-chart";
const ENT = "t-ent-chart";

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

const add = (account: Parameters<typeof addAccount>[0]["account"]) =>
  addAccount({ orgId: ORG, entityId: ENT, account });
const change = (code: string, c: Parameters<typeof updateAccount>[0]["change"]) =>
  updateAccount({ orgId: ORG, entityId: ENT, code, change: c });

d("editing the chart of accounts", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("adds an account", async () => {
    const a = await add({ code: "6910", name: "Subscriptions", type: "EXPENSE", parentCode: "6" });
    expect(a.code).toBe("6910");
    expect(a.isPostable).toBe(true);
  });

  it("refuses a duplicate code, naming what is already there", async () => {
    await expect(add({ code: "6910", name: "Something else", type: "EXPENSE" }))
      .rejects.toThrow(/already exists — it is "Subscriptions"/);
  });

  it("refuses a code that would break an export", async () => {
    await expect(add({ code: "60 10", name: "Spaces", type: "EXPENSE" }))
      .rejects.toThrow(/not a usable account code/i);
  });

  it("refuses an invented type", async () => {
    await expect(add({ code: "6911", name: "Nonsense", type: "WIDGET" }))
      .rejects.toThrow(/ASSET, LIABILITY, EQUITY, INCOME, EXPENSE/);
  });

  it("refuses a heading of a different kind from its children", async () => {
    // Rolling an expense up into an asset heading makes the total meaningless.
    await expect(add({ code: "6912", name: "Wrong parent", type: "EXPENSE", parentCode: "1" }))
      .rejects.toThrow(/same kind of account/i);
  });

  it("refuses a postable account as a heading", async () => {
    await expect(add({ code: "6913", name: "Under a real account", type: "EXPENSE", parentCode: "6900" }))
      .rejects.toThrow(/either something you post to or something that rolls up/i);
  });

  it("renames a used account, because a name is only a label", async () => {
    await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-02-10", source: "manual", memo: "A subscription",
      lines: [{ account: "6910", debit: 50_000 }, { account: "1010", credit: 50_000 }],
    });
    const r = await change("6910", { name: "Subscriptions and licences" });
    expect(r.name).toBe("Subscriptions and licences");
  });

  it("refuses to change the type of a used account, and says how many lines", async () => {
    await expect(change("6910", { type: "ASSET" }))
      .rejects.toThrow(/carries 1 posted line, so its type cannot change/);
    await expect(change("6910", { type: "ASSET" }))
      .rejects.toThrow(/rewrite every statement it has ever appeared in/);
  });

  it("allows a type change while the account is still unused", async () => {
    await add({ code: "6914", name: "Not yet used", type: "EXPENSE" });
    const r = await change("6914", { type: "ASSET" });
    expect(r.type).toBe("ASSET");
  });

  it("refuses to make a used account into a heading", async () => {
    await expect(change("6910", { isPostable: false })).rejects.toThrow(/cannot become a heading/i);
  });

  it("refuses a heading with nothing under it", async () => {
    await expect(change("6914", { isPostable: false })).rejects.toThrow(/no children/i);
  });

  it("refuses a currency restriction its own history would break", async () => {
    await expect(change("6910", { currency: "USD" }))
      .rejects.toThrow(/already holds postings in AED.*cannot be restricted to USD/is);
  });

  it("refuses a loop in the tree", async () => {
    await add({ code: "H1", name: "Heading one", type: "EXPENSE", isPostable: false });
    await add({ code: "H2", name: "Heading two", type: "EXPENSE", isPostable: false, parentCode: "H1" });
    // Putting H1 under H2 would make every rollup that walks the tree infinite.
    await expect(change("H1", { parentCode: "H2" })).rejects.toThrow(/underneath itself/i);
  });

  it("refuses an account as its own heading", async () => {
    await expect(change("H1", { parentCode: "H1" })).rejects.toThrow(/its own heading/i);
  });

  it("renumbers an account and says what else needs updating", async () => {
    const r = await renumberAccount({ orgId: ORG, entityId: ENT, from: "6910", to: "6915" });
    expect(r.account.code).toBe("6915");
    expect(r.postedLines).toBe(1);
    expect(r.note).toMatch(/refers to 6910 will need updating/);

    // History follows the account, so the posting is still on it.
    const lines = await db.journalLine.count({ where: { accountId: r.account.id } });
    expect(lines).toBe(1);
  });

  it("refuses to renumber onto a code in use", async () => {
    await expect(renumberAccount({ orgId: ORG, entityId: ENT, from: "6915", to: "6900" }))
      .rejects.toThrow(/silently merge them/i);
  });

  it("refuses to delete an account that has been posted to", async () => {
    await expect(deleteAccount({ orgId: ORG, entityId: ENT, code: "6915" }))
      .rejects.toThrow(/history that explains those balances would be orphaned/i);
    await expect(deleteAccount({ orgId: ORG, entityId: ENT, code: "6915" }))
      .rejects.toThrow(/Archive it instead/i);
  });

  it("deletes an account added by mistake and never used", async () => {
    await add({ code: "ZZZZ", name: "Typo", type: "EXPENSE" });
    const r = await deleteAccount({ orgId: ORG, entityId: ENT, code: "ZZZZ" });
    expect(r.deleted).toBe("ZZZZ");
    expect(await db.account.count({ where: { orgId: ORG, code: "ZZZZ" } })).toBe(0);
  });

  it("refuses to archive an account still holding a balance", async () => {
    await expect(archiveAccount({ orgId: ORG, entityId: ENT, code: "6915" }))
      .rejects.toThrow(/hides something the business still owns or owes/i);
  });

  it("archives an account once its balance is cleared, keeping the history", async () => {
    await post({
      orgId: ORG, entityId: ENT, entryDate: "2026-02-11", source: "manual", memo: "Clearing it out",
      lines: [{ account: "6915", credit: 50_000 }, { account: "1010", debit: 50_000 }],
    });
    const r = await archiveAccount({ orgId: ORG, entityId: ENT, code: "6915" });
    expect(r.status).toBe("archived");
    // Archiving keeps every past statement true.
    const lines = await db.journalLine.count({ where: { accountId: r.id } });
    expect(lines).toBe(2);
  });

  it("refuses to archive a heading with live children", async () => {
    await expect(archiveAccount({ orgId: ORG, entityId: ENT, code: "H1" }))
      .rejects.toThrow(/still has 1 active account under it/i);
  });

  it("restores an archived account", async () => {
    const r = await restoreAccount({ orgId: ORG, entityId: ENT, code: "6915" });
    expect(r.status).toBe("active");
  });

  it("tells the editor what each account will allow, before it is tried", async () => {
    const chart = await chartWithUsage({ orgId: ORG, entityId: ENT });
    const used = chart.find((a) => a.code === "6915")!;
    expect(used.postedLines).toBe(2);
    expect(used.canChangeType).toBe(false);
    expect(used.canDelete).toBe(false);
    // Its balance is nil again, so it may be archived.
    expect(used.canArchive).toBe(true);

    const heading = chart.find((a) => a.code === "H1")!;
    expect(heading.children).toBe(1);
    expect(heading.canDelete).toBe(false);

    const fresh = chart.find((a) => a.code === "6914")!;
    expect(fresh.canChangeType).toBe(true);
    expect(fresh.canDelete).toBe(true);
  });

  it("says when there is nothing to change", async () => {
    await expect(change("6914", {})).rejects.toThrow(/nothing to change/i);
  });
});
