import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  declareRelatedParty, endRelationship, declareCompensation, attest, assessNotRelated,
  relatedPartyNote, inPeriod, partyKeyOf, RELATIONSHIPS, COMP_CATEGORIES,
} from "@/lib/server/ledger/related-parties";
import { openBooks, openFiscalYear } from "@/lib/server/ledger/setup";
import { LedgerError } from "@/lib/server/ledger/post";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-rp";
const ENT = "t-ent-rp";
const S = { orgId: ORG, entityId: ENT };
const P = { period: "2026", from: "2026-01-01", to: "2026-12-31" };

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "RelatedParty" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "PartyAssessment" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "KeyManagementComp" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "RelatedPartyAttestation" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Counterparty" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Record" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Account" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "AccountingPeriod" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "FiscalYear" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Book" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "DocumentSequence" WHERE "orgId" = '${ORG}'`),
  ]);
}

async function party(code: string, name: string) {
  await db.counterparty.create({
    data: { orgId: ORG, entityId: ENT, code, name, kind: "BOTH", status: "active" },
  });
}

/** An invoice in the document store, which is where attribution reads from. */
async function invoice(opts: {
  id: string; number: string; customer: string; payableMinor: number;
  direction?: "OUTBOUND" | "INBOUND"; issueDate?: string; docType?: string;
}) {
  const inv = {
    id: opts.id, orgId: ORG, entityId: ENT,
    direction: opts.direction ?? "OUTBOUND",
    docType: opts.docType ?? "TAX_INVOICE",
    number: opts.number,
    issueDate: opts.issueDate ?? "2026-05-01",
    currency: "AED",
    buyer: { nameEn: opts.direction === "INBOUND" ? "Our Company" : opts.customer },
    seller: { nameEn: opts.direction === "INBOUND" ? opts.customer : "Our Company" },
    lines: [],
    totals: { taxExclusiveMinor: opts.payableMinor, vatMinor: 0, taxInclusiveMinor: opts.payableMinor, payableMinor: opts.payableMinor, perCategory: [] },
  };
  await db.record.create({
    data: { id: opts.id, orgId: ORG, store: "invoices", entityId: ENT, data: JSON.stringify(inv) },
  });
}

describe("does a relationship touch the period", () => {
  const from = new Date("2026-01-01");
  const to = new Date("2026-12-31");

  it("includes one that ran all year", () => {
    expect(inPeriod(new Date("2025-01-01"), null, from, to)).toBe(true);
  });

  it("includes one that ended mid-year, because it existed for part of it", () => {
    expect(inPeriod(new Date("2025-01-01"), new Date("2026-06-30"), from, to)).toBe(true);
  });

  it("excludes one that ended before the period began", () => {
    expect(inPeriod(new Date("2024-01-01"), new Date("2025-12-31"), from, to)).toBe(false);
  });

  it("excludes one that had not started yet", () => {
    expect(inPeriod(new Date("2027-01-01"), null, from, to)).toBe(false);
  });

  it("folds a party key so one party is one key", () => {
    expect(partyKeyOf("  ACME Holding ")).toBe("acme holding");
  });
});

d("related parties", () => {
  beforeAll(async () => {
    await wipe();
    await openFiscalYear({ ...S, label: "2026", startsOn: "2026-01-01" });
    await openBooks(S);
    await party("ACME", "Acme Holding LLC");
    await party("BETA", "Beta Trading LLC");
    await party("DIRSPOUSE", "H. Al Mansoori");
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("refuses a declaration nobody owns", async () => {
    await expect(declareRelatedParty({
      ...S, party: { partyKey: "ACME", relationship: "PARENT", declaredBy: "  ", startedOn: "2026-01-01" },
    })).rejects.toThrow(/nobody owns is not a declaration/);
  });

  it("refuses a relationship IAS 24 does not recognise", async () => {
    await expect(declareRelatedParty({
      ...S,
      party: { partyKey: "ACME", relationship: "FRIEND" as never, declaredBy: "R. Khan", startedOn: "2026-01-01" },
    })).rejects.toThrow(/not a relationship IAS 24 recognises/);
  });

  it("refuses one that ended before it started", async () => {
    await expect(declareRelatedParty({
      ...S,
      party: { partyKey: "ACME", relationship: "PARENT", declaredBy: "R. Khan", startedOn: "2026-06-01", endedOn: "2026-01-01" },
    })).rejects.toThrow(/cannot end before it starts/);
  });

  it("takes the counterparty's own name so two screens never print two names", async () => {
    const row = await declareRelatedParty({
      ...S,
      party: { partyKey: "acme", relationship: "PARENT", declaredBy: "R. Khan", startedOn: "2025-01-01" },
    });
    expect(row.name).toBe("Acme Holding LLC");
    expect(row.partyKey).toBe("acme");
  });

  it("refuses a second declaration from the same day rather than overwriting one", async () => {
    await expect(declareRelatedParty({
      ...S,
      party: { partyKey: "ACME", relationship: "COMMON_CONTROL", declaredBy: "R. Khan", startedOn: "2025-01-01" },
    })).rejects.toThrow(/already declared related from 2025-01-01/);
  });

  it("says the note is incomplete while anybody is unassessed", async () => {
    const n = await relatedPartyNote({ ...S, ...P });
    expect(n.completeness.complete).toBe(false);
    // Beta and the director's spouse have been neither declared related nor
    // declared unrelated, so the note cannot claim to be complete.
    expect(n.completeness.unassessedCount).toBe(2);
    expect(n.completeness.reasons.some((r) => r.includes("never been assessed"))).toBe(true);
  });

  it("reports transactions with a declared party from the ledger", async () => {
    await invoice({ id: "inv-rp-1", number: "INV-1", customer: "Acme Holding LLC", payableMinor: 500_000 });
    await invoice({ id: "inv-rp-2", number: "INV-2", customer: "Acme Holding LLC", payableMinor: 250_000 });
    await invoice({ id: "bil-rp-1", number: "BIL-1", customer: "Acme Holding LLC", payableMinor: 100_000, direction: "INBOUND" });
    // Beta is not declared, so its trading belongs in no related party note.
    await invoice({ id: "inv-rp-3", number: "INV-3", customer: "Beta Trading LLC", payableMinor: 900_000 });

    const n = await relatedPartyNote({ ...S, ...P });
    const acme = n.parties.find((p) => p.partyKey === "acme")!;
    expect(acme.salesMinor).toBe(750_000n);
    expect(acme.purchasesMinor).toBe(100_000n);
    expect(acme.documents).toBe(3);
    expect(n.parties).toHaveLength(1);
  });

  it("takes a credit note off the total rather than adding it", async () => {
    await invoice({
      id: "crn-rp-1", number: "CRN-1", customer: "Acme Holding LLC",
      payableMinor: 50_000, docType: "TAX_CREDIT_NOTE",
    });
    const n = await relatedPartyNote({ ...S, ...P });
    expect(n.parties.find((p) => p.partyKey === "acme")!.salesMinor).toBe(700_000n);
  });

  it("leaves a document outside the period out of it", async () => {
    await invoice({
      id: "inv-rp-old", number: "INV-OLD", customer: "Acme Holding LLC",
      payableMinor: 999_999, issueDate: "2025-06-01",
    });
    const n = await relatedPartyNote({ ...S, ...P });
    expect(n.parties.find((p) => p.partyKey === "acme")!.salesMinor).toBe(700_000n);
  });

  it("groups by relationship", async () => {
    await declareRelatedParty({
      ...S,
      party: { partyKey: "DIRSPOUSE", relationship: "CLOSE_FAMILY", declaredBy: "R. Khan", startedOn: "2026-01-01" },
    });
    const n = await relatedPartyNote({ ...S, ...P });
    const labels = n.byRelationship.map((g) => g.relationship).sort();
    expect(labels).toEqual(["CLOSE_FAMILY", "PARENT"]);
    expect(n.byRelationship.find((g) => g.relationship === "PARENT")!.salesMinor).toBe(700_000n);
  });

  it("keeps a relationship that ended mid-year in the note", async () => {
    const row = await db.relatedParty.findFirst({ where: { orgId: ORG, partyKey: "dirspouse" } });
    await endRelationship({ ...S, id: row!.id, endedOn: "2026-06-30" });
    const n = await relatedPartyNote({ ...S, ...P });
    // It existed for half the year, and IAS 24 asks about the period.
    expect(n.parties.some((p) => p.partyKey === "dirspouse")).toBe(true);
    expect(n.parties.find((p) => p.partyKey === "dirspouse")!.endedOn).toBe("2026-06-30");
  });

  it("drops it from a later period", async () => {
    const n = await relatedPartyNote({ ...S, period: "2027", from: "2027-01-01", to: "2027-12-31" });
    expect(n.parties.some((p) => p.partyKey === "dirspouse")).toBe(false);
  });

  it("refuses to end a relationship before it started", async () => {
    const row = await db.relatedParty.findFirst({ where: { orgId: ORG, partyKey: "acme" } });
    await expect(endRelationship({ ...S, id: row!.id, endedOn: "2020-01-01" }))
      .rejects.toThrow(/cannot end before it starts/);
  });

  it("names every compensation category nobody has answered", async () => {
    const n = await relatedPartyNote({ ...S, ...P });
    expect(n.compensation.rows).toEqual([]);
    expect(n.compensation.missingCategories).toHaveLength(5);
    expect(n.completeness.reasons.some((r) => r.includes("No key management compensation"))).toBe(true);
  });

  it("refuses a category IAS 24.17 does not name", async () => {
    await expect(declareCompensation({
      ...S, period: "2026", category: "BONUS" as never, amountMinor: 1, headcount: 1, declaredBy: "R. Khan",
    })).rejects.toThrow(/not one of the five categories/);
  });

  it("refuses a figure covering nobody", async () => {
    await expect(declareCompensation({
      ...S, period: "2026", category: "SHORT_TERM", amountMinor: 100_000, headcount: 0, declaredBy: "R. Khan",
    })).rejects.toThrow(/Nought people cannot be paid anything/);
  });

  it("still says a total alone is not the disclosure", async () => {
    await declareCompensation({
      ...S, period: "2026", category: "SHORT_TERM", amountMinor: 1_200_000, headcount: 3, declaredBy: "R. Khan",
    });
    const n = await relatedPartyNote({ ...S, ...P });
    expect(n.compensation.totalMinor).toBe(1_200_000n);
    expect(n.compensation.missingCategories).toHaveLength(4);
    expect(n.completeness.reasons.some((r) => r.includes("A total alone is not the disclosure"))).toBe(true);
  });

  it("gives no headcount where the declarations disagree about how many people", async () => {
    await declareCompensation({
      ...S, period: "2026", category: "POST_EMPLOYMENT", amountMinor: 90_000, headcount: 4, declaredBy: "R. Khan",
    });
    const n = await relatedPartyNote({ ...S, ...P });
    // Three people receive short-term benefits and four receive post-
    // employment ones. There is no single answer, and picking one would be a
    // number a reader could not check.
    expect(n.compensation.headcount).toBeNull();
    expect(n.compensation.totalMinor).toBe(1_290_000n);
  });

  it("refuses an attestation that answers nothing", async () => {
    await expect(attest({ ...S, period: "2026", attestedBy: "R. Khan" }))
      .rejects.toThrow(/whether or not there were transactions/);
  });

  it("refuses one that says both that there is none and who it is", async () => {
    await expect(attest({
      ...S, period: "2026", attestedBy: "R. Khan",
      noControllingParty: true, parentName: "Acme Holding LLC",
    })).rejects.toThrow(/both cannot be true/);
  });

  it("takes an attestation naming the controlling party", async () => {
    const a = await attest({
      ...S, period: "2026", attestedBy: "R. Khan", attestedOn: "2027-02-01",
      parentName: "Acme Holding LLC", ultimateControllingParty: "Mr A. Al Mansoori",
    });
    expect(a.attestedBy).toBe("R. Khan");
    const n = await relatedPartyNote({ ...S, ...P });
    expect(n.attestation.present).toBe(true);
    expect(n.attestation.ultimateControllingParty).toBe("Mr A. Al Mansoori");
    expect(n.completeness.reasons.some((r) => r.includes("Nobody has attested"))).toBe(false);
  });

  it("takes an attestation that there is no controlling party at all", async () => {
    const a = await attest({
      ...S, period: "2027", attestedBy: "R. Khan", noControllingParty: true,
    });
    expect(a.noControllingParty).toBe(true);
  });

  /* ── assessed, and not related ──────────────────────────────────────────── */

  it("refuses an assessment nobody owns", async () => {
    await expect(assessNotRelated({ ...S, party: { partyKey: "BETA", assessedBy: "   " } }))
      .rejects.toThrow(/nobody owns is not an assessment/);
  });

  it("refuses to assess a party as not related while a declaration says otherwise", async () => {
    // Acme is declared the parent from 2025-01-01 with no end date, so on any
    // day the assessment could be made the two statements contradict.
    await expect(assessNotRelated({ ...S, party: { partyKey: "ACME", assessedBy: "R. Khan" } }))
      .rejects.toThrow(/is declared parent from 2025-01-01/i);
  });

  it("records an assessment that reaches no note and asserts no relationship", async () => {
    const before = await relatedPartyNote({ ...S, ...P });
    expect(before.completeness.unassessedCount).toBe(1);

    const a = await assessNotRelated({
      ...S,
      party: {
        partyKey: "BETA", assessedBy: "R. Khan", assessedOn: "2026-11-30",
        notes: "Ordinary supplier. No common control, no key management link.",
      },
    });
    // The counterparty's own name, the same way a declaration takes it.
    expect(a.name).toBe("Beta Trading LLC");
    expect(a.partyKey).toBe("beta");

    const n = await relatedPartyNote({ ...S, ...P });
    // The whole point: it is off the unassessed list and in no disclosure.
    expect(n.completeness.unassessedCount).toBe(0);
    expect(n.completeness.assessedCount).toBe(1);
    expect(n.completeness.assessed[0]).toMatchObject({
      name: "Beta Trading LLC", assessedBy: "R. Khan", assessedOn: "2026-11-30",
    });
    expect(n.parties.some((p) => p.partyKey === "beta")).toBe(false);
    expect(n.byRelationship.some((g) => g.relationship === "OTHER")).toBe(false);
    // Beta traded 900,000 minor units in the period, and none of it is here.
    expect(n.parties.reduce((t, p) => t + p.salesMinor, 0n)).toBe(700_000n);
  });

  it("replaces an assessment rather than keeping two answers about one party", async () => {
    await assessNotRelated({
      ...S, party: { partyKey: "Beta Trading LLC", assessedBy: "S. Aziz", assessedOn: "2026-12-01" },
    });
    const n = await relatedPartyNote({ ...S, ...P });
    expect(n.completeness.assessedCount).toBe(1);
    expect(n.completeness.assessed[0].assessedBy).toBe("S. Aziz");
  });

  it("becomes complete once everybody has been assessed and every category answered", async () => {
    for (const c of ["OTHER_LONG_TERM", "TERMINATION", "SHARE_BASED"] as const) {
      await declareCompensation({ ...S, period: "2026", category: c, amountMinor: 0, headcount: 0, declaredBy: "R. Khan" });
    }
    const n = await relatedPartyNote({ ...S, ...P });
    // Acme declared, the spouse declared and ended, Beta assessed and not
    // related. Three active counterparties, nobody unaccounted for, and the
    // note says so without a false line in it.
    expect(n.completeness.unassessedCount).toBe(0);
    expect(n.completeness.reasons).toEqual([]);
    expect(n.completeness.complete).toBe(true);
    expect(n.basis).toContain("IAS 24");
  });

  it("withdraws the assessment when the party is later declared related", async () => {
    // The two can never both be true, and a declaration is the later and the
    // stronger statement: it goes into a note a reader relies on.
    await declareRelatedParty({
      ...S,
      party: { partyKey: "BETA", relationship: "ASSOCIATE", declaredBy: "R. Khan", startedOn: "2026-12-15" },
    });
    const n = await relatedPartyNote({ ...S, ...P });
    expect(n.completeness.assessedCount).toBe(0);
    expect(n.completeness.unassessedCount).toBe(0);
    expect(n.parties.some((p) => p.partyKey === "beta")).toBe(true);
    expect(await db.partyAssessment.count({ where: { orgId: ORG, partyKey: "beta" } })).toBe(0);
  });

  it("takes the assessment once the relationship has been ended", async () => {
    const row = await db.relatedParty.findFirst({ where: { orgId: ORG, partyKey: "beta" } });
    await endRelationship({ ...S, id: row!.id, endedOn: "2026-12-31" });
    // Ended on 31 December, assessed on 1 January: nothing stands on that day.
    const a = await assessNotRelated({
      ...S, party: { partyKey: "BETA", assessedBy: "R. Khan", assessedOn: "2027-01-01" },
    });
    expect(a.partyKey).toBe("beta");
    // 2026 keeps the disclosure it made; 2027 has an assessment and no note row.
    const y2026 = await relatedPartyNote({ ...S, ...P });
    expect(y2026.parties.some((p) => p.partyKey === "beta")).toBe(true);
    const y2027 = await relatedPartyNote({ ...S, period: "2027", from: "2027-01-01", to: "2027-12-31" });
    expect(y2027.parties.some((p) => p.partyKey === "beta")).toBe(false);
    expect(y2027.completeness.assessedCount).toBe(1);
  });

  it("keeps one organisation out of another's declarations", async () => {
    const n = await relatedPartyNote({ orgId: "t-org-rp-2", entityId: ENT, ...P });
    expect(n.parties).toEqual([]);
    expect(n.completeness.complete).toBe(false);
  });

  it("names all nine relationships and all five categories", () => {
    expect(Object.keys(RELATIONSHIPS)).toHaveLength(9);
    expect(Object.keys(COMP_CATEGORIES)).toHaveLength(5);
    expect(LedgerError).toBeTruthy();
  });
});
