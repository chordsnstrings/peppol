import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { post, reverse } from "@/lib/server/ledger/post";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import {
  attach, listAttachments, getAttachment, removeAttachment, attachmentCountsFor, MAX_BYTES,
} from "@/lib/server/ledger/attachments";
import { auditTrail, provenanceSummary, integrityCheck } from "@/lib/server/ledger/audit";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-aud";
const ENT = "t-ent-aud";

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "Attachment" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "BankStatementLine" WHERE "orgId" = '${ORG}'`),
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

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");
const sha = (s: string) => createHash("sha256").update(Buffer.from(s, "utf8")).digest("hex");

const put = (over: Partial<Parameters<typeof attach>[0]> = {}) =>
  attach({
    orgId: ORG,
    entityId: ENT,
    subjectType: "EXPENSE_CLAIM",
    subjectId: "claim-1",
    filename: "receipt.txt",
    mimeType: "text/plain",
    contentBase64: b64("TAXI TO DIFC 45.00 AED"),
    uploadedBy: "u-alice",
    ...over,
  });

/** A two-line entry; every audit fixture is one of these with different provenance. */
const P = (
  entryDate: string,
  over: Partial<Parameters<typeof post>[0]> = {},
) =>
  post({
    orgId: ORG,
    entityId: ENT,
    entryDate,
    memo: "Consulting fee",
    lines: [{ account: "1010", debit: 100_000 }, { account: "4000", credit: 100_000 }],
    ...over,
  });

d("attachments and the audit trail", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ orgId: ORG, entityId: ENT, label: "2026", startsOn: "2026-01-01" });
    await openBooks({ orgId: ORG, entityId: ENT });
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  /* ----------------------------------------------------------- attachments */

  it("stores a document and hands back the SHA-256 of its bytes", async () => {
    const a = await put();
    expect(a.deduplicated).toBe(false);
    expect(a.sha256).toBe(sha("TAXI TO DIFC 45.00 AED"));
    expect(a.sizeBytes).toBe(Buffer.byteLength("TAXI TO DIFC 45.00 AED"));
    expect(a.uploadedBy).toBe("u-alice");
  });

  it("attaching the same bytes to the same subject twice keeps one copy, and says so", async () => {
    const first = await put();
    const second = await put({ filename: "receipt-copy.txt" });
    expect(second.deduplicated).toBe(true);
    expect(second.id).toBe(first.id);
    // The second filename is not what is stored: it is the same document.
    expect(second.filename).toBe("receipt.txt");
    const rows = await db.attachment.count({ where: { orgId: ORG, subjectId: "claim-1" } });
    expect(rows).toBe(1);
  });

  it("the same bytes on a different subject are a different attachment", async () => {
    const other = await put({ subjectId: "claim-2" });
    expect(other.deduplicated).toBe(false);
    expect(other.sha256).toBe(sha("TAXI TO DIFC 45.00 AED"));
  });

  it("line-wrapped or data-URL base64 is recognised as the same document", async () => {
    const wrapped = b64("TAXI TO DIFC 45.00 AED").replace(/(.{8})/g, "$1\n");
    const again = await put({ contentBase64: `data:text/plain;base64,${wrapped}` });
    expect(again.deduplicated).toBe(true);
  });

  it("refuses a file bigger than the limit, and says how big it was", async () => {
    const big = Buffer.alloc(MAX_BYTES + 1, 0x41).toString("base64");
    // One byte over: the message has to distinguish it from the limit, which
    // rounded megabytes alone cannot do.
    await expect(put({ filename: "huge.pdf", mimeType: "application/pdf", contentBase64: big }))
      .rejects.toThrow(/huge\.pdf is 5 MB \(5,242,881 bytes\) and the limit is 5 MB \(5,242,880 bytes\)/);
  });

  it("refuses a file type it does not accept, naming the type", async () => {
    await expect(put({ filename: "payload.exe", mimeType: "application/x-msdownload", contentBase64: b64("MZ") }))
      .rejects.toThrow(/application\/x-msdownload/);
  });

  it("refuses an empty file, which is not evidence of anything", async () => {
    await expect(put({ filename: "nothing.pdf", mimeType: "application/pdf", contentBase64: "" }))
      .rejects.toThrow(/empty/i);
  });

  it("refuses content that is not base64 at all", async () => {
    await expect(put({ contentBase64: "this is not base64!" })).rejects.toThrow(/base64/i);
  });

  it("refuses a subject type it does not recognise", async () => {
    await expect(put({ subjectType: "PAYSLIP" })).rejects.toThrow(/not something documents can be attached to/i);
  });

  it("lists metadata and never the content", async () => {
    await put({ filename: "hotel.pdf", mimeType: "application/pdf", contentBase64: b64("%PDF-1.4 hotel") });
    const list = await listAttachments({ orgId: ORG, subjectType: "EXPENSE_CLAIM", subjectId: "claim-1" });
    expect(list.length).toBe(2);
    for (const row of list) {
      expect(Object.keys(row)).not.toContain("content");
      expect((row as unknown as { content?: string }).content).toBeUndefined();
      expect(row.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("hands one document back with its bytes, and verifies them on the way out", async () => {
    const a = await put({ filename: "verify.txt", contentBase64: b64("VERIFY ME") });
    const got = await getAttachment({ orgId: ORG, id: a.id });
    expect(Buffer.from(got.contentBase64, "base64").toString("utf8")).toBe("VERIFY ME");
    expect(got.verified).toBe(true);
    expect(got.problem).toBeNull();
  });

  it("detects a document whose bytes no longer match its hash", async () => {
    const a = await put({ filename: "tampered.txt", contentBase64: b64("ORIGINAL RECEIPT 45.00") });
    // Somebody swaps the file underneath the record — the whole reason the hash
    // is stored. Written straight to the row so content and sha256 disagree.
    await db.attachment.update({ where: { id: a.id }, data: { content: b64("ALTERED RECEIPT 4500.00") } });

    const got = await getAttachment({ orgId: ORG, id: a.id });
    expect(got.verified).toBe(false);
    expect(got.problem).toMatch(/no longer matches the hash/i);
    // The untouched ones are unaffected: verification is per document.
    const clean = await getAttachment({ orgId: ORG, id: (await put({ filename: "clean.txt", contentBase64: b64("CLEAN") })).id });
    expect(clean.verified).toBe(true);
  });

  it("removes a document and returns what was removed, so the act can be logged", async () => {
    const a = await put({ subjectId: "claim-3", filename: "wrong-bill.txt", contentBase64: b64("WRONG BILL") });
    const gone = await removeAttachment({ orgId: ORG, id: a.id, removedBy: "u-bob" });
    expect(gone.filename).toBe("wrong-bill.txt");
    expect(gone.sha256).toBe(sha("WRONG BILL"));
    expect(gone.uploadedBy).toBe("u-alice");
    expect(gone.removedBy).toBe("u-bob");
    expect(await listAttachments({ orgId: ORG, subjectType: "EXPENSE_CLAIM", subjectId: "claim-3" })).toHaveLength(0);
    await expect(removeAttachment({ orgId: ORG, id: a.id })).rejects.toThrow(/does not exist/i);
  });

  /* ---------------------------------------------------------- audit trail */

  it("shows what posted an entry, not just that it was posted", async () => {
    const e = await P("2026-03-03", {
      source: "invoice", sourceType: "INVOICE", sourceId: "INV-001",
      actorType: "RULE", actorId: "ar-autopost", memo: "Sales invoice INV-001",
    });
    const rows = await auditTrail({ orgId: ORG, entityId: ENT, from: "2026-03-01", to: "2026-03-31" });
    const row = rows.find((r) => r.id === e.id)!;
    expect(row.actorType).toBe("RULE");
    expect(row.actorId).toBe("ar-autopost");
    expect(row.machinePosted).toBe(true);
    expect(row.attributed).toBe(true);
    expect(row.sourceType).toBe("INVOICE");
    expect(row.amountMinor).toBe(100_000n);
  });

  it("tells the story in a sentence, naming the source document", async () => {
    const rows = await auditTrail({ orgId: ORG, entityId: ENT, from: "2026-03-01", to: "2026-03-31" });
    const row = rows.find((r) => r.sourceId === "INV-001")!;
    expect(row.story).toContain("Posted automatically by rule ar-autopost");
    expect(row.story).toContain("from invoice INV-001");
    expect(row.story).toContain("3 March 2026");
  });

  it("says which document an entry settles", async () => {
    await P("2026-03-10", {
      source: "payment", sourceType: "RECEIPT", sourceId: "RCT-009", settlesId: "INV-001",
      actorType: "HUMAN", actorId: "u-alice", memo: "Receipt against INV-001",
    });
    const rows = await auditTrail({ orgId: ORG, entityId: ENT, from: "2026-03-10", to: "2026-03-10" });
    expect(rows[0].settlesId).toBe("INV-001");
    expect(rows[0].story).toContain("settling INV-001");
    expect(rows[0].story).toContain("Posted by u-alice");
  });

  it("shows a reversal from both ends", async () => {
    const original = await P("2026-04-01", { memo: "Duplicate posting", actorId: "u-alice" });
    const rev = await reverse({ orgId: ORG, entryId: original.id, entryDate: "2026-04-05", actorId: "u-bob" });

    const rows = await auditTrail({ orgId: ORG, entityId: ENT, from: "2026-04-01", to: "2026-04-30" });
    const from = rows.find((r) => r.id === original.id)!;
    const to = rows.find((r) => r.id === rev.id)!;

    expect(from.reversedBy?.id).toBe(rev.id);
    expect(from.status).toBe("reversed");
    expect(from.story).toMatch(/reversed by GJ-\d+ on 5 April 2026/);

    expect(to.reversalOf?.id).toBe(original.id);
    expect(to.story).toMatch(/reversing GJ-\d+ of 1 April 2026/);
  });

  it("counts the documents attached to an entry and mentions them in the story", async () => {
    const e = await P("2026-05-02", { memo: "Rent", actorId: "u-alice" });
    await attach({
      orgId: ORG, entityId: ENT, subjectType: "JOURNAL_ENTRY", subjectId: e.id,
      filename: "lease.pdf", mimeType: "application/pdf", contentBase64: b64("%PDF-1.4 lease"),
      uploadedBy: "u-alice",
    });
    const counts = await attachmentCountsFor({ orgId: ORG, subjectType: "JOURNAL_ENTRY", subjectIds: [e.id] });
    expect(counts.get(e.id)).toBe(1);

    const rows = await auditTrail({ orgId: ORG, entityId: ENT, from: "2026-05-02", to: "2026-05-02" });
    expect(rows[0].attachments).toBe(1);
    expect(rows[0].story).toContain("with 1 document attached");
  });

  it("filters by actor type, and refuses an actor type that does not exist", async () => {
    const machine = await auditTrail({ orgId: ORG, entityId: ENT, actorType: "RULE" });
    expect(machine.length).toBeGreaterThan(0);
    expect(machine.every((r) => r.actorType === "RULE")).toBe(true);
    await expect(auditTrail({ orgId: ORG, entityId: ENT, actorType: "ROBOT" }))
      .rejects.toThrow(/not a kind of actor/i);
  });

  it("filters by source and by date range", async () => {
    const invoices = await auditTrail({ orgId: ORG, entityId: ENT, source: "invoice" });
    expect(invoices.length).toBeGreaterThan(0);
    expect(invoices.every((r) => r.source === "invoice")).toBe(true);

    const april = await auditTrail({ orgId: ORG, entityId: ENT, from: "2026-04-01", to: "2026-04-30" });
    expect(april.length).toBeGreaterThan(0);
    expect(april.every((r) => r.entryDate >= new Date("2026-04-01") && r.entryDate <= new Date("2026-04-30"))).toBe(true);
    expect(april.some((r) => r.sourceId === "INV-001")).toBe(false);
  });

  it("returns entries newest first and respects the limit", async () => {
    const rows = await auditTrail({ orgId: ORG, entityId: ENT, limit: 2 });
    expect(rows).toHaveLength(2);
    expect(rows[0].entryDate >= rows[1].entryDate).toBe(true);
  });

  it("summarises who and what has been posting", async () => {
    const s = await provenanceSummary({ orgId: ORG, entityId: ENT, from: "2026-03-01", to: "2026-03-31" });
    const rule = s.byActorType.find((a) => a.actorType === "RULE")!;
    expect(rule.count).toBe(1);
    expect(rule.machine).toBe(true);
    const human = s.byActorType.find((a) => a.actorType === "HUMAN")!;
    expect(human.machine).toBe(false);
    expect(s.bySource.map((x) => x.source)).toContain("invoice");
    expect(s.total).toBe(s.byActorType.reduce((a, x) => a + x.count, 0));
  });

  it("counts entries nobody can be traced to separately from machine-posted ones", async () => {
    // A month of its own so the count is exactly what this test posted.
    await P("2026-11-05", { memo: "Nobody recorded" });                                    // no actorId
    await P("2026-11-06", { memo: "By a rule", actorType: "RULE", actorId: "rent-monthly" }); // machine, traceable
    await P("2026-11-07", { memo: "By a person", actorId: "u-alice" });                     // human, traceable

    const s = await provenanceSummary({ orgId: ORG, entityId: ENT, from: "2026-11-01", to: "2026-11-30" });
    expect(s.total).toBe(3);
    expect(s.unattributed).toBe(1);
    expect(s.attributed).toBe(2);
    // The machine-posted entry is NOT a finding: it names the rule that posted it.
    expect(s.byActorType.find((a) => a.actorType === "RULE")?.count).toBe(1);

    const rows = await auditTrail({ orgId: ORG, entityId: ENT, from: "2026-11-05", to: "2026-11-05" });
    expect(rows[0].attributed).toBe(false);
    expect(rows[0].story).toContain("with nobody recorded");
  });

  it("finds nothing wrong with a healthy ledger", async () => {
    const r = await integrityCheck({ orgId: ORG, entityId: ENT });
    expect(r.checked).toBeGreaterThan(0);
    expect(r.checked).toBeLessThanOrEqual(r.population);
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("would report an entry that did not balance, if one could exist", async () => {
    // The database refuses to commit an unbalanced entry, so the only way to
    // test the detector is to bypass the trigger the way a restore or a direct
    // fix-up would. If this check could not see the damage, its clean result
    // above would mean nothing.
    const e = await P("2026-06-01", { memo: "Healthy when posted", actorId: "u-alice" });
    const account = await db.account.findFirst({ where: { orgId: ORG, entityId: ENT, code: "4000" } });

    await db.$transaction([
      db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
      db.$executeRawUnsafe(
        `INSERT INTO "JournalLine" (id,"orgId","entryId","lineNo","accountId","txnCurrency","txnAmountMinor","fxRate","functionalCurrency","functionalAmountMinor")
         VALUES ('t-aud-bogus-line','${ORG}','${e.id}',99,'${account!.id}','AED',500,1,'AED',500)`,
      ),
    ]);

    const bad = await integrityCheck({ orgId: ORG, entityId: ENT });
    expect(bad.ok).toBe(false);
    const failure = bad.failures.find((f) => f.id === e.id)!;
    expect(failure.differenceMinor).toBe(500n);
    expect(failure.reason).toMatch(/out by 500 minor units/);

    await db.$transaction([
      db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
      db.$executeRawUnsafe(`DELETE FROM "JournalLine" WHERE id = 't-aud-bogus-line'`),
    ]);
    const healed = await integrityCheck({ orgId: ORG, entityId: ENT });
    expect(healed.ok).toBe(true);
  });
});
