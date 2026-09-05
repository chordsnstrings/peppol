import { prisma } from "@/lib/server/prisma";
import { LedgerError } from "./post";
import { partyIndex, attributeDocument } from "./counterparties";

/**
 * Related parties, IAS 24.
 *
 * The equity notes already say, correctly, that a ledger cannot know which
 * parties are related. Relatedness is a fact about people and control — a
 * director's spouse, an entity under common control, a member of key
 * management — and none of it is written in a chart of accounts or a journal
 * line. What was missing was anywhere to put the answer.
 *
 * So this is a declaration, never a detection. A detector would be wrong in
 * the direction that matters: it would produce a confident, incomplete list,
 * and a reader would take its silence about everybody else as a statement that
 * there is nobody else. Every declaration here names who made it and when.
 *
 * Three things follow from that, and they are what make the note worth having.
 *
 * "There are none" is a declaration too. A note that is empty because somebody
 * assessed the counterparties and found nothing is a different document from
 * one that is empty because nobody was asked, and the reader cannot tell them
 * apart unless the software insists on the difference. So the note reports its
 * own completeness: how many counterparties have never been assessed, and by
 * name.
 *
 * The disclosure is required whether or not there were transactions. IAS 24.13
 * asks for the parent and, where different, the ultimate controlling party,
 * regardless of whether anything passed between them — so a nil balance does
 * not excuse the note.
 *
 * Key management compensation has five categories and a total is not
 * compliant. IAS 24.17 names short-term, post-employment, other long-term,
 * termination and share-based, and a business that discloses only a total has
 * not made the disclosure. The categories nobody has answered are listed.
 *
 * What the ledger does supply is the transactions and balances, once the
 * parties are named: it reads them for declared parties over the period, the
 * same way every other per-counterparty report does, through the counterparty
 * module's own attribution ladder rather than a second one.
 *
 * And there are two answers, not one. Every value in `RELATIONSHIPS` asserts
 * relatedness, so "I looked at this one and they are not related" had nowhere
 * to go: the only way to clear a name off the unassessed list was to declare
 * the party related and end the relationship on the same day, which puts a
 * false line into the IAS 24 note of whatever year that day falls in. An
 * assessment (`assessNotRelated`) is the other answer. It reaches no note,
 * asserts no relationship, and exists for one purpose — so that "assessed,
 * nothing to disclose" can be told apart from "nobody was asked", which is the
 * distinction the whole module is built around.
 */

export type Relationship =
  | "PARENT" | "SUBSIDIARY" | "ASSOCIATE" | "JOINT_VENTURE" | "KEY_MANAGEMENT"
  | "CLOSE_FAMILY" | "COMMON_CONTROL" | "POST_EMPLOYMENT_PLAN" | "OTHER";

export const RELATIONSHIPS: Record<Relationship, string> = {
  PARENT: "Parent",
  SUBSIDIARY: "Subsidiary",
  ASSOCIATE: "Associate",
  JOINT_VENTURE: "Joint venture",
  KEY_MANAGEMENT: "Key management personnel",
  CLOSE_FAMILY: "Close family member of key management",
  COMMON_CONTROL: "Entity under common control",
  POST_EMPLOYMENT_PLAN: "Post-employment benefit plan for the entity's employees",
  OTHER: "Other related party",
};

export type CompCategory =
  | "SHORT_TERM" | "POST_EMPLOYMENT" | "OTHER_LONG_TERM" | "TERMINATION" | "SHARE_BASED";

/** IAS 24.17 names exactly these five, and a total alone is not the disclosure. */
export const COMP_CATEGORIES: Record<CompCategory, string> = {
  SHORT_TERM: "Short-term employee benefits",
  POST_EMPLOYMENT: "Post-employment benefits",
  OTHER_LONG_TERM: "Other long-term benefits",
  TERMINATION: "Termination benefits",
  SHARE_BASED: "Share-based payment",
};

const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00.000Z`);

function asDate(v: Date | string, what: string): Date {
  const d = typeof v === "string" ? day(v) : v;
  if (Number.isNaN(d.getTime())) throw new LedgerError(`${what} is not a date I can read.`);
  return d;
}

function required(v: string | undefined | null, what: string): string {
  const s = (v ?? "").trim();
  if (!s) throw new LedgerError(what);
  return s;
}

/** The same folding counterparties and pricing use, so one party is one key. */
export const partyKeyOf = (v: string) => v.trim().toLowerCase();

/**
 * Every name one counterparty answers to.
 *
 * A party key may fold either the code or the name — the completeness check has
 * always looked for both — so anything deciding whether a declaration and an
 * assessment are about the same party has to look for both as well. Otherwise
 * "BETA" assessed and "Beta Trading LLC" declared are two parties to the
 * software and one party to everybody else, and the rule that the two states
 * can never both be true would be enforced only when the spelling happened to
 * match.
 */
function keysFor(partyKey: string, hit?: { code: string; name: string }): string[] {
  const keys = new Set([partyKey]);
  if (hit) { keys.add(partyKeyOf(hit.code)); keys.add(partyKeyOf(hit.name)); }
  return [...keys];
}

/** Does a declared relationship touch the reporting period at all? */
export function inPeriod(startedOn: Date, endedOn: Date | null, from: Date, to: Date): boolean {
  if (startedOn > to) return false;
  return endedOn === null || endedOn >= from;
}

/* ------------------------------------------------------------ declarations */

export async function declareRelatedParty(opts: {
  orgId: string; entityId: string;
  party: {
    partyKey: string;
    name?: string;
    relationship: Relationship;
    declaredBy: string;
    declaredOn?: Date | string;
    startedOn: Date | string;
    endedOn?: Date | string | null;
    notes?: string;
  };
}) {
  const p = opts.party;
  const partyKey = partyKeyOf(required(p.partyKey, "Which party?"));
  if (!(p.relationship in RELATIONSHIPS)) {
    throw new LedgerError(
      `"${p.relationship}" is not a relationship IAS 24 recognises. Use one of ${Object.keys(RELATIONSHIPS).join(", ")}.`,
    );
  }
  const declaredBy = required(
    p.declaredBy,
    "A declaration nobody owns is not a declaration. Say who is asserting this relationship.",
  );
  const startedOn = asDate(p.startedOn, "The date the relationship started");
  const endedOn = p.endedOn ? asDate(p.endedOn, "The date it ended") : null;
  if (endedOn && endedOn < startedOn) throw new LedgerError("A relationship cannot end before it starts.");

  // The counterparty's own name, where there is one, so the note and the
  // customer list never print two different names for one party. The query is
  // broad because the key may fold either the code or the name.
  const match = await prisma.counterparty.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId },
    select: { code: true, name: true },
  });
  const hit = match.find((c) => partyKeyOf(c.code) === partyKey || partyKeyOf(c.name) === partyKey);
  const name = (p.name ?? "").trim() || hit?.name || p.partyKey.trim();

  const clash = await prisma.relatedParty.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, partyKey, startedOn },
  });
  if (clash) {
    throw new LedgerError(
      `${name} is already declared related from ${iso(startedOn)}. End that declaration and make a new one if the ` +
      `relationship changed — overwriting it would erase what was disclosed in an earlier period.`,
    );
  }

  // Declaring a party related withdraws any assessment that said otherwise.
  // The two are contradictory statements about the same counterparty, and the
  // declaration is the later and the stronger of them: it goes into a note that
  // a reader relies on, while an assessment only records that somebody looked.
  // Nothing is lost — an assessment is not a disclosure — and leaving it behind
  // would let the same party appear as both assessed-and-not-related and
  // declared related on one screen.
  const [row] = await prisma.$transaction([
    prisma.relatedParty.create({
      data: {
        orgId: opts.orgId, entityId: opts.entityId,
        partyKey, name, relationship: p.relationship,
        declaredBy,
        declaredOn: p.declaredOn ? asDate(p.declaredOn, "The date of the declaration") : new Date(),
        startedOn, endedOn,
        notes: p.notes?.trim() || null,
      },
    }),
    prisma.partyAssessment.deleteMany({
      where: { orgId: opts.orgId, entityId: opts.entityId, partyKey: { in: keysFor(partyKey, hit) } },
    }),
  ]);
  return row;
}

/**
 * Assessed, and not a related party.
 *
 * This is the answer the note could not hold. It records that a named person
 * looked at a named counterparty on a stated day and concluded there is no IAS
 * 24 relationship — and then it stops. It creates no disclosure, joins no
 * period, and appears in no note; `relatedPartyNote` reads it in exactly one
 * place, to stop counting the party as never assessed. An assessment that
 * reached the note would be the same defect it replaces, pointing the other
 * way: a reader would see a party listed under a standard that requires
 * relationships to be listed, and conclude one exists.
 *
 * It refuses while a declaration says the opposite, rather than quietly
 * overruling one. A declaration is disclosure and this module never deletes
 * disclosure — an earlier period reported it — so the way out is to end the
 * relationship on the day it ended and assess afterwards, which is what
 * happened in fact.
 *
 * Recording it again replaces it, so a reassessment is a new date and a new
 * name rather than a second row: there is one current answer per party.
 */
export async function assessNotRelated(opts: {
  orgId: string; entityId: string;
  party: {
    partyKey: string;
    name?: string;
    assessedBy: string;
    assessedOn?: Date | string;
    notes?: string;
  };
}) {
  const p = opts.party;
  const partyKey = partyKeyOf(required(p.partyKey, "Which party?"));
  const assessedBy = required(
    p.assessedBy,
    "An assessment nobody owns is not an assessment. Say who looked at this party and concluded they are not related.",
  );
  const assessedOn = p.assessedOn ? asDate(p.assessedOn, "The date of the assessment") : new Date();

  const match = await prisma.counterparty.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId },
    select: { code: true, name: true },
  });
  const hit = match.find((c) => partyKeyOf(c.code) === partyKey || partyKeyOf(c.name) === partyKey);
  const name = (p.name ?? "").trim() || hit?.name || p.partyKey.trim();
  const keys = keysFor(partyKey, hit);
  // Where the counterparty is known, the assessment is filed under its code
  // however it was asked for. One party is one answer, and without this the
  // same supplier assessed once by code and once by name would be two rows and
  // the second would not replace the first.
  const canonical = hit ? partyKeyOf(hit.code) : partyKey;

  // A relationship that had not ended by the day of the assessment still stands
  // on that day, so the two statements would contradict each other.
  const standing = await prisma.relatedParty.findFirst({
    where: {
      orgId: opts.orgId, entityId: opts.entityId,
      partyKey: { in: keys },
      OR: [{ endedOn: null }, { endedOn: { gte: assessedOn } }],
    },
    orderBy: { startedOn: "asc" },
  });
  if (standing) {
    throw new LedgerError(
      `${name} is declared ${(RELATIONSHIPS[standing.relationship as Relationship] ?? standing.relationship).toLowerCase()} ` +
      `from ${iso(standing.startedOn)}${standing.endedOn ? ` to ${iso(standing.endedOn)}` : ""}, so they cannot also be ` +
      `assessed as not related on ${iso(assessedOn)}. If the relationship has ended, record the date it ended first — ` +
      `the declaration stays, because an earlier period disclosed it.`,
    );
  }

  const data = { name, assessedBy, assessedOn, notes: p.notes?.trim() || null };
  const others = keys.filter((k) => k !== canonical);
  const [, row] = await prisma.$transaction([
    prisma.partyAssessment.deleteMany({
      where: { orgId: opts.orgId, entityId: opts.entityId, partyKey: { in: others } },
    }),
    prisma.partyAssessment.upsert({
      where: {
        orgId_entityId_partyKey: { orgId: opts.orgId, entityId: opts.entityId, partyKey: canonical },
      },
      create: { orgId: opts.orgId, entityId: opts.entityId, partyKey: canonical, ...data },
      update: data,
    }),
  ]);
  return row;
}

/** End a relationship. Never delete one — an earlier period disclosed it. */
export async function endRelationship(opts: {
  orgId: string; entityId: string; id: string; endedOn: Date | string;
}) {
  const row = await prisma.relatedParty.findFirst({
    where: { id: opts.id, orgId: opts.orgId, entityId: opts.entityId },
  });
  if (!row) throw new LedgerError("There is no such declaration.");
  const endedOn = asDate(opts.endedOn, "The date it ended");
  if (endedOn < row.startedOn) throw new LedgerError("A relationship cannot end before it starts.");
  return prisma.relatedParty.update({ where: { id: row.id }, data: { endedOn } });
}

export async function declareCompensation(opts: {
  orgId: string; entityId: string;
  period: string;
  category: CompCategory;
  amountMinor: number | bigint | string;
  headcount: number;
  declaredBy: string;
  declaredOn?: Date | string;
}) {
  if (!(opts.category in COMP_CATEGORIES)) {
    throw new LedgerError(
      `"${opts.category}" is not one of the five categories IAS 24.17 names: ${Object.keys(COMP_CATEGORIES).join(", ")}.`,
    );
  }
  const declaredBy = required(opts.declaredBy, "Say who is asserting these figures.");
  let amountMinor: bigint;
  try {
    amountMinor = typeof opts.amountMinor === "bigint" ? opts.amountMinor : BigInt(String(opts.amountMinor).trim());
  } catch {
    throw new LedgerError("That compensation figure is not an amount I can read.");
  }
  if (amountMinor < 0n) throw new LedgerError("Compensation cannot be negative.");
  if (!Number.isInteger(opts.headcount) || opts.headcount < 0) {
    throw new LedgerError("How many people does the figure cover?");
  }
  if (amountMinor > 0n && opts.headcount === 0) {
    throw new LedgerError(
      "Nought people cannot be paid anything. A figure covering nobody is a figure a reader cannot interpret.",
    );
  }

  return prisma.keyManagementComp.upsert({
    where: {
      orgId_entityId_period_category: {
        orgId: opts.orgId, entityId: opts.entityId, period: opts.period, category: opts.category,
      },
    },
    create: {
      orgId: opts.orgId, entityId: opts.entityId, period: opts.period, category: opts.category,
      amountMinor, headcount: opts.headcount, declaredBy,
      declaredOn: opts.declaredOn ? asDate(opts.declaredOn, "The date of the declaration") : new Date(),
    },
    update: {
      amountMinor, headcount: opts.headcount, declaredBy,
      declaredOn: opts.declaredOn ? asDate(opts.declaredOn, "The date of the declaration") : new Date(),
    },
  });
}

/**
 * The attestation. IAS 24.13 asks for the parent and the ultimate controlling
 * party whether or not anything passed between them, so "there is no
 * controlling party" has to be something somebody says rather than something
 * the absence of a row implies.
 */
export async function attest(opts: {
  orgId: string; entityId: string; period: string;
  attestedBy: string;
  attestedOn?: Date | string;
  parentName?: string | null;
  ultimateControllingParty?: string | null;
  noControllingParty?: boolean;
  notes?: string;
}) {
  const attestedBy = required(opts.attestedBy, "Who is making this attestation?");
  const parentName = opts.parentName?.trim() || null;
  const ultimate = opts.ultimateControllingParty?.trim() || null;
  const none = opts.noControllingParty === true;

  if (none && (parentName || ultimate)) {
    throw new LedgerError(
      "Either there is no controlling party or one is named — both cannot be true.",
    );
  }
  if (!none && !parentName && !ultimate) {
    throw new LedgerError(
      "IAS 24.13 requires the parent and, where different, the ultimate controlling party to be disclosed whether " +
      "or not there were transactions between them. Name one, or state that there is none.",
    );
  }

  const data = {
    parentName, ultimateControllingParty: ultimate, noControllingParty: none,
    attestedBy,
    attestedOn: opts.attestedOn ? asDate(opts.attestedOn, "The date of the attestation") : new Date(),
    notes: opts.notes?.trim() || null,
  };

  return prisma.relatedPartyAttestation.upsert({
    where: {
      orgId_entityId_period: { orgId: opts.orgId, entityId: opts.entityId, period: opts.period },
    },
    create: { orgId: opts.orgId, entityId: opts.entityId, period: opts.period, ...data },
    update: data,
  });
}

/* ------------------------------------------------------------- the ledger */

/**
 * What passed between the entity and each declared related party in the
 * period, and what was still outstanding at the end of it.
 *
 * Documents are attributed through the counterparty module's own ladder, so
 * there is one answer to "whose document is this" rather than two that drift.
 */
async function activityFor(opts: {
  orgId: string; entityId: string; from: Date; to: Date; keys: Set<string>;
}) {
  const parties = await prisma.counterparty.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId },
  });
  const idx = partyIndex(parties);
  const byId = new Map(parties.map((p) => [p.id, p]));

  const totals = new Map<string, { salesMinor: bigint; purchasesMinor: bigint; documents: number }>();

  /*
   * Read every document, a page at a time, rather than the first five thousand.
   *
   * The issue date lives inside a JSON string, so it cannot be filtered in
   * SQL — and `createdAt` is not a substitute, because a backdated invoice was
   * created after the period it belongs to. What the cap did, then, was drop
   * whichever documents happened to sort last and under-report related-party
   * activity by exactly those, in a note published under IAS 24 and signed by
   * somebody. An under-reported related-party disclosure is the failure mode
   * this whole module exists to prevent.
   *
   * Paging costs nothing here: each page is reduced into `totals` and thrown
   * away, so the memory is the same whether the entity has five hundred
   * documents or five hundred thousand.
   */
  const PAGE = 2_000;
  let cursor: { store_id: { store: string; id: string } } | undefined;
  for (;;) {
    const documents: { id: string; data: string }[] = await prisma.record.findMany({
      where: { orgId: opts.orgId, store: "invoices", entityId: opts.entityId },
      select: { id: true, data: true },
      orderBy: { id: "asc" },
      take: PAGE,
      ...(cursor ? { cursor, skip: 1 } : {}),
    });
    if (documents.length === 0) break;
    read(documents);
    if (documents.length < PAGE) break;
    cursor = { store_id: { store: "invoices", id: documents[documents.length - 1].id } };
  }

  return totals;

  function read(documents: { id: string; data: string }[]) {
  for (const rec of documents) {
    let inv: {
      entityId?: string; issueDate?: string; direction?: string; docType?: string;
      totals?: { payableMinor?: number | string };
    };
    try { inv = JSON.parse(rec.data); } catch { continue; }
    if (!inv) continue;
    const issued = inv.issueDate ? day(inv.issueDate) : null;
    if (!issued || issued < opts.from || issued > opts.to) continue;

    const side = inv.direction === "INBOUND" ? "seller" : "buyer";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const partyId = attributeDocument(inv as any, idx, side);
    if (!partyId) continue;
    const party = byId.get(partyId);
    if (!party) continue;
    const key = partyKeyOf(party.code);
    const altKey = partyKeyOf(party.name);
    const matched = opts.keys.has(key) ? key : opts.keys.has(altKey) ? altKey : null;
    if (!matched) continue;

    let amount = 0n;
    try { amount = BigInt(String(inv.totals?.payableMinor ?? "0")); } catch { amount = 0n; }
    const sign = inv.docType?.includes("CREDIT") ? -1n : 1n;

    const g = totals.get(matched) ?? { salesMinor: 0n, purchasesMinor: 0n, documents: 0 };
    if (inv.direction === "INBOUND") g.purchasesMinor += amount * sign;
    else g.salesMinor += amount * sign;
    g.documents += 1;
    totals.set(matched, g);
  }
  }
}

export interface RelatedPartyNoteData {
  period: string;
  from: string;
  to: string;
  parties: {
    id: string;
    partyKey: string;
    name: string;
    relationship: Relationship;
    relationshipLabel: string;
    startedOn: string;
    endedOn: string | null;
    declaredBy: string;
    declaredOn: string;
    salesMinor: bigint;
    purchasesMinor: bigint;
    documents: number;
    notes: string | null;
  }[];
  byRelationship: { relationship: Relationship; label: string; count: number; salesMinor: bigint; purchasesMinor: bigint }[];
  compensation: {
    rows: { category: CompCategory; label: string; amountMinor: bigint; headcount: number; declaredBy: string }[];
    totalMinor: bigint;
    /** IAS 24.17 categories nobody has answered. A total alone is not the disclosure. */
    missingCategories: { category: CompCategory; label: string }[];
    headcount: number | null;
  };
  attestation: {
    present: boolean;
    parentName: string | null;
    ultimateControllingParty: string | null;
    noControllingParty: boolean;
    attestedBy: string | null;
    attestedOn: string | null;
  };
  completeness: {
    /** Counterparties with no declaration either way. */
    unassessed: string[];
    unassessedCount: number;
    /**
     * Looked at, and not related. These reach no part of the disclosure above —
     * they are here so a reader can see that the silence about them was
     * somebody's conclusion rather than nobody's question.
     */
    assessed: { partyKey: string; name: string; assessedBy: string; assessedOn: string; notes: string | null }[];
    assessedCount: number;
    complete: boolean;
    reasons: string[];
  };
  basis: string;
}

export async function relatedPartyNote(opts: {
  orgId: string; entityId: string; period: string; from: Date | string; to: Date | string;
}): Promise<RelatedPartyNoteData> {
  const from = asDate(opts.from, "The start of the period");
  const to = asDate(opts.to, "The end of the period");
  if (to < from) throw new LedgerError("The period ends before it starts.");

  const [declared, comp, attestation, counterparties, assessments] = await Promise.all([
    prisma.relatedParty.findMany({
      where: { orgId: opts.orgId, entityId: opts.entityId },
      orderBy: [{ relationship: "asc" }, { name: "asc" }],
    }),
    prisma.keyManagementComp.findMany({
      where: { orgId: opts.orgId, entityId: opts.entityId, period: opts.period },
    }),
    prisma.relatedPartyAttestation.findFirst({
      where: { orgId: opts.orgId, entityId: opts.entityId, period: opts.period },
    }),
    prisma.counterparty.findMany({
      where: { orgId: opts.orgId, entityId: opts.entityId, status: "active" },
      select: { code: true, name: true },
    }),
    // Not filtered by period, and deliberately: an assessment is a statement
    // about a party rather than about a year, and it holds until somebody
    // declares the party related, which withdraws it.
    prisma.partyAssessment.findMany({
      where: { orgId: opts.orgId, entityId: opts.entityId },
      orderBy: { name: "asc" },
    }),
  ]);

  const live = declared.filter((d) => inPeriod(d.startedOn, d.endedOn, from, to));
  const keys = new Set(live.map((d) => d.partyKey));
  const activity = keys.size
    ? await activityFor({ orgId: opts.orgId, entityId: opts.entityId, from, to, keys })
    : new Map<string, { salesMinor: bigint; purchasesMinor: bigint; documents: number }>();

  const parties = live.map((d) => {
    const a = activity.get(d.partyKey) ?? { salesMinor: 0n, purchasesMinor: 0n, documents: 0 };
    return {
      id: d.id,
      partyKey: d.partyKey,
      name: d.name,
      relationship: d.relationship as Relationship,
      relationshipLabel: RELATIONSHIPS[d.relationship as Relationship] ?? d.relationship,
      startedOn: iso(d.startedOn),
      endedOn: d.endedOn ? iso(d.endedOn) : null,
      declaredBy: d.declaredBy,
      declaredOn: iso(d.declaredOn),
      salesMinor: a.salesMinor,
      purchasesMinor: a.purchasesMinor,
      documents: a.documents,
      notes: d.notes,
    };
  });

  const groups = new Map<Relationship, { count: number; salesMinor: bigint; purchasesMinor: bigint }>();
  for (const p of parties) {
    const g = groups.get(p.relationship) ?? { count: 0, salesMinor: 0n, purchasesMinor: 0n };
    g.count += 1;
    g.salesMinor += p.salesMinor;
    g.purchasesMinor += p.purchasesMinor;
    groups.set(p.relationship, g);
  }

  const compRows = comp.map((c) => ({
    category: c.category as CompCategory,
    label: COMP_CATEGORIES[c.category as CompCategory] ?? c.category,
    amountMinor: c.amountMinor,
    headcount: c.headcount,
    declaredBy: c.declaredBy,
  }));
  const answered = new Set(compRows.map((r) => r.category));
  const missingCategories = (Object.keys(COMP_CATEGORIES) as CompCategory[])
    .filter((c) => !answered.has(c))
    .map((category) => ({ category, label: COMP_CATEGORIES[category] }));

  // Headcount is a property of the group, not of a category — the same people
  // receive short-term and post-employment benefits. Where the declarations
  // disagree about how many people that is, there is no single answer and
  // saying so is better than picking one.
  const heads = new Set(compRows.filter((r) => r.headcount > 0).map((r) => r.headcount));
  const headcount = heads.size === 1 ? [...heads][0] : null;

  // Anyone the entity trades with who has been neither declared related nor
  // declared unrelated. Completeness is the whole difficulty with this note,
  // and a reader cannot tell an assessed nil from an unasked question.
  const declaredKeys = new Set(declared.map((d) => d.partyKey));
  const assessedKeys = new Set(assessments.map((a) => a.partyKey));
  const known = (c: { code: string; name: string }) =>
    declaredKeys.has(partyKeyOf(c.code)) || declaredKeys.has(partyKeyOf(c.name)) ||
    assessedKeys.has(partyKeyOf(c.code)) || assessedKeys.has(partyKeyOf(c.name));
  const unassessed = counterparties.filter((c) => !known(c)).map((c) => c.name).sort();

  const reasons: string[] = [];
  if (!attestation) {
    reasons.push(
      "Nobody has attested to the note. IAS 24.13 requires the parent and the ultimate controlling party to be " +
      "disclosed whether or not there were transactions, so silence does not complete it.",
    );
  }
  if (unassessed.length) {
    reasons.push(
      `${unassessed.length} ${unassessed.length === 1 ? "counterparty has" : "counterparties have"} never been ` +
      `assessed. The note cannot be said to be complete while anybody the entity trades with is unaccounted for. ` +
      `Recording one as assessed and not related settles it without saying anything about them in the note.`,
    );
  }
  if (missingCategories.length && compRows.length) {
    reasons.push(
      `Key management compensation is missing ${missingCategories.length} of the five categories IAS 24.17 names: ` +
      `${missingCategories.map((m) => m.label.toLowerCase()).join(", ")}. A total alone is not the disclosure.`,
    );
  }
  if (!compRows.length) {
    reasons.push(
      "No key management compensation has been declared. IAS 24.17 requires it in total and by category, and it is " +
      "required even where the only key management personnel is the owner.",
    );
  }

  return {
    period: opts.period,
    from: iso(from),
    to: iso(to),
    parties,
    byRelationship: [...groups.entries()].map(([relationship, g]) => ({
      relationship, label: RELATIONSHIPS[relationship], ...g,
    })).sort((a, b) => a.label.localeCompare(b.label)),
    compensation: {
      rows: compRows.sort((a, b) => a.label.localeCompare(b.label)),
      totalMinor: compRows.reduce((a, r) => a + r.amountMinor, 0n),
      missingCategories,
      headcount,
    },
    attestation: {
      present: !!attestation,
      parentName: attestation?.parentName ?? null,
      ultimateControllingParty: attestation?.ultimateControllingParty ?? null,
      noControllingParty: attestation?.noControllingParty ?? false,
      attestedBy: attestation?.attestedBy ?? null,
      attestedOn: attestation ? iso(attestation.attestedOn) : null,
    },
    completeness: {
      unassessed: unassessed.slice(0, 50),
      unassessedCount: unassessed.length,
      assessed: assessments.map((a) => ({
        partyKey: a.partyKey,
        name: a.name,
        assessedBy: a.assessedBy,
        assessedOn: iso(a.assessedOn),
        notes: a.notes,
      })),
      assessedCount: assessments.length,
      complete: reasons.length === 0,
      reasons,
    },
    basis: "IAS 24.13, IAS 24.17, IAS 24.18",
  };
}
