import { prisma } from "@/lib/server/prisma";
import { LedgerError } from "./post";
import { attachmentCountsFor } from "./attachments";

/**
 * The audit trail.
 *
 * Every journal entry already carries who or what posted it, what it came
 * from, what it reverses and what it settles — `post()` captures all of that at
 * INSERT because a posted entry is immutable and provenance is part of what the
 * entry *is*. Until now nothing has shown it to anybody, which makes it a
 * column nobody has ever had to defend.
 *
 * So this module reads it back in the form an auditor actually asks for: not a
 * grid of enum values, but a sentence per entry saying what happened. A
 * provenance table nobody can read is provenance nobody uses, and the
 * difference between "actorType=RULE, source=invoice" and "posted automatically
 * by a rule from invoice INV-001" is the difference between a record that
 * exists and a record that answers a question.
 */

export const ACTOR_TYPES = ["HUMAN", "RULE", "MODEL", "AGENT", "INTEGRATION"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/** Everything except HUMAN posted itself; a person did not press anything. */
const isMachine = (actorType: string) => actorType !== "HUMAN";

export interface EntryRef {
  id: string;
  reference: string;
  entryDate: Date;
}

export interface AuditEntry {
  id: string;
  reference: string;
  entryDate: Date;
  /** When it actually hit the ledger, which is not always the date it is dated. */
  postedAt: Date | null;
  createdAt: Date;
  status: string;
  memo: string | null;
  periodLabel: string | null;

  /* --- who or what --- */
  actorType: string;
  actorId: string | null;
  machinePosted: boolean;
  /** False when nothing identifies the actor — see `provenanceSummary`. */
  attributed: boolean;

  /* --- where from --- */
  source: string;
  sourceType: string | null;
  sourceId: string | null;
  externalKey: string | null;

  /* --- what it does to other documents --- */
  settlesId: string | null;
  reversalOf: EntryRef | null;
  reversedBy: EntryRef | null;

  attachments: number;
  /** Total debits, functional currency — the size of the entry, in one number. */
  amountMinor: bigint;
  currency: string;

  /** The whole thing as one plain-English sentence. */
  story: string;
}

export interface AuditFilter {
  orgId: string;
  entityId: string;
  from?: Date | string;
  to?: Date | string;
  actorType?: string;
  source?: string;
  limit?: number;
}

const asDate = (d: Date | string | undefined) => (d === undefined ? undefined : typeof d === "string" ? new Date(d) : d);

/**
 * Posted entries with their provenance, newest first.
 *
 * Reversal is shown from both ends: the original names what reversed it and the
 * reversal names what it reverses. Following the link in one direction only is
 * how a reversed entry ends up being read as if it still stood.
 */
export async function auditTrail(filter: AuditFilter): Promise<AuditEntry[]> {
  if (filter.actorType && !(ACTOR_TYPES as readonly string[]).includes(filter.actorType)) {
    throw new LedgerError(
      `"${filter.actorType}" is not a kind of actor. Filter by one of ${ACTOR_TYPES.join(", ")}.`,
    );
  }
  // A page of a few hundred is a page a person can read; an unbounded audit
  // query on a real ledger is a way to take the database out.
  const take = Math.min(Math.max(filter.limit ?? 100, 1), 500);
  const from = asDate(filter.from);
  const to = asDate(filter.to);

  const rows = await prisma.journalEntry.findMany({
    where: {
      orgId: filter.orgId,
      entityId: filter.entityId,
      ...(filter.actorType ? { actorType: filter.actorType } : {}),
      ...(filter.source ? { source: filter.source } : {}),
      ...(from || to
        ? { entryDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
        : {}),
    },
    orderBy: [{ entryDate: "desc" }, { createdAt: "desc" }],
    take,
    include: {
      period: { select: { label: true } },
      lines: { select: { functionalAmountMinor: true, functionalCurrency: true } },
      reversalOf: { select: { id: true, series: true, number: true, entryDate: true } },
      reversals: { select: { id: true, series: true, number: true, entryDate: true }, take: 1 },
    },
  });

  const counts = await attachmentCountsFor({
    orgId: filter.orgId,
    subjectType: "JOURNAL_ENTRY",
    subjectIds: rows.map((r) => r.id),
  });

  return rows.map((r) => {
    const reference = `${r.series}-${r.number}`;
    const reversalOf = r.reversalOf ? refOf(r.reversalOf) : null;
    const reversedBy = r.reversals[0] ? refOf(r.reversals[0]) : null;
    const attachments = counts.get(r.id) ?? 0;
    const amountMinor = r.lines.reduce((a, l) => a + (l.functionalAmountMinor > 0n ? l.functionalAmountMinor : 0n), 0n);

    const entry: AuditEntry = {
      id: r.id,
      reference,
      entryDate: r.entryDate,
      postedAt: r.postedAt,
      createdAt: r.createdAt,
      status: r.status,
      memo: r.memo,
      periodLabel: r.period?.label ?? null,
      actorType: r.actorType,
      actorId: r.actorId,
      machinePosted: isMachine(r.actorType),
      attributed: Boolean(r.actorId),
      source: r.source,
      sourceType: r.sourceType,
      sourceId: r.sourceId,
      externalKey: r.externalKey,
      settlesId: r.settlesId,
      reversalOf,
      reversedBy,
      attachments,
      amountMinor,
      currency: r.lines[0]?.functionalCurrency ?? "AED",
      story: "",
    };
    entry.story = storyOf(entry);
    return entry;
  });
}

export interface ProvenanceSummary {
  from: Date | null;
  to: Date | null;
  total: number;
  byActorType: { actorType: string; count: number; machine: boolean }[];
  bySource: { source: string; count: number }[];
  /** Entries carrying an actorId of any kind. */
  attributed: number;
  /**
   * Entries with no actorId at all — see the note on the function.
   */
  unattributed: number;
}

/**
 * Who and what has been posting.
 *
 * The two counts to keep apart:
 *
 * - **Machine-posted** entries (actorType RULE, MODEL, AGENT, INTEGRATION) are
 *   normal and mostly desirable. A recurring rent journal raised by a rule
 *   every month is a rule doing its job, and its actorId names the rule, so the
 *   entry is fully traceable.
 * - **Unattributed** entries have no actorId whatever the actorType. Nothing
 *   identifies the person, the rule or the integration behind them, so nobody
 *   can be asked why the entry exists. That is the finding: not "a machine did
 *   it" but "nothing can say who did it".
 *
 * Counting them together would let a healthy automation rate hide a set of
 * entries with no owner, which is the exact thing an auditor is looking for.
 */
export async function provenanceSummary(opts: {
  orgId: string;
  entityId: string;
  from?: Date | string;
  to?: Date | string;
}): Promise<ProvenanceSummary> {
  const from = asDate(opts.from);
  const to = asDate(opts.to);
  const where = {
    orgId: opts.orgId,
    entityId: opts.entityId,
    ...(from || to ? { entryDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
  };

  const [byActor, bySource, total, unattributed] = await Promise.all([
    prisma.journalEntry.groupBy({ by: ["actorType"], where, _count: { _all: true } }),
    prisma.journalEntry.groupBy({ by: ["source"], where, _count: { _all: true } }),
    prisma.journalEntry.count({ where }),
    prisma.journalEntry.count({ where: { ...where, actorId: null } }),
  ]);

  const byCountThenName = <T extends { count: number }>(key: (r: T) => string) => (a: T, b: T) =>
    b.count - a.count || key(a).localeCompare(key(b));

  return {
    from: from ?? null,
    to: to ?? null,
    total,
    byActorType: byActor
      .map((r) => ({ actorType: r.actorType, count: r._count._all, machine: isMachine(r.actorType) }))
      .sort(byCountThenName((r) => r.actorType)),
    bySource: bySource
      .map((r) => ({ source: r.source, count: r._count._all }))
      .sort(byCountThenName((r) => r.source)),
    attributed: total - unattributed,
    unattributed,
  };
}

export interface IntegrityFailure {
  id: string;
  reference: string;
  entryDate: Date;
  differenceMinor: bigint;
  currency: string;
  reason: string;
}

export interface IntegrityReport {
  checked: number;
  /** How many posted entries exist in total, so the sample is honest about itself. */
  population: number;
  failures: IntegrityFailure[];
  ok: boolean;
}

/**
 * Re-prove that entries balance in the functional currency.
 *
 * This should never find anything. The database enforces it with a deferred
 * constraint trigger, so an unbalanced entry cannot be committed by any path,
 * including raw SQL. That is exactly why it is worth running: a control which
 * is never tested is a control nobody trusts, and "the database won't let that
 * happen" is a claim, not evidence, until something checks. If this ever
 * returns a failure the trigger has been dropped, disabled or bypassed —
 * which is a finding far bigger than the entry it turned up on.
 *
 * It samples the most recent entries rather than the whole ledger. A defect
 * introduced by a change shows up in what was posted after the change, and
 * summing every line in the ledger on every page load is the query that stops
 * working somewhere past a few million rows.
 */
export async function integrityCheck(opts: {
  orgId: string;
  entityId: string;
  limit?: number;
}): Promise<IntegrityReport> {
  const take = Math.min(Math.max(opts.limit ?? 250, 1), 2_000);
  const where = { orgId: opts.orgId, entityId: opts.entityId, status: { in: ["posted", "reversed"] } };

  const [rows, population] = await Promise.all([
    prisma.journalEntry.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take,
      select: {
        id: true,
        series: true,
        number: true,
        entryDate: true,
        lines: { select: { functionalAmountMinor: true, functionalCurrency: true } },
      },
    }),
    prisma.journalEntry.count({ where }),
  ]);

  const failures: IntegrityFailure[] = [];
  for (const r of rows) {
    const reference = `${r.series}-${r.number}`;
    const currencies = new Set(r.lines.map((l) => l.functionalCurrency));
    const sum = r.lines.reduce((a, l) => a + l.functionalAmountMinor, 0n);

    if (r.lines.length < 2) {
      failures.push({
        id: r.id, reference, entryDate: r.entryDate, differenceMinor: sum,
        currency: [...currencies][0] ?? "AED",
        reason: `${reference} has ${r.lines.length} line${r.lines.length === 1 ? "" : "s"}; an entry needs at least two.`,
      });
      continue;
    }
    // Every line of one entry must be measured in the same functional currency
    // or the sum is meaningless — adding fils to cents proves nothing.
    if (currencies.size > 1) {
      failures.push({
        id: r.id, reference, entryDate: r.entryDate, differenceMinor: sum,
        currency: [...currencies].join("/"),
        reason: `${reference} mixes functional currencies (${[...currencies].join(", ")}), so it cannot be summed.`,
      });
      continue;
    }
    if (sum !== 0n) {
      failures.push({
        id: r.id, reference, entryDate: r.entryDate, differenceMinor: sum,
        currency: [...currencies][0] ?? "AED",
        reason: `${reference} is out by ${sum.toString()} minor units — debits do not equal credits.`,
      });
    }
  }

  return { checked: rows.length, population, failures, ok: failures.length === 0 };
}

/* ------------------------------------------------------------------ helpers */

function refOf(e: { id: string; series: string; number: string; entryDate: Date }): EntryRef {
  return { id: e.id, reference: `${e.series}-${e.number}`, entryDate: e.entryDate };
}

/**
 * Dates carry the year. An audit trail is read months or years after the fact,
 * often next to a second date from another year, and "3 March" makes the reader
 * go and look it up.
 */
const DAY = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const on = (d: Date) => DAY.format(d);

/** "invoice INV-001" from sourceType INVOICE and sourceId INV-001. */
function sourcePhrase(e: AuditEntry): string {
  if (e.sourceType) {
    const noun = e.sourceType.toLowerCase().replace(/_/g, " ");
    return e.sourceId ? ` from ${noun} ${e.sourceId}` : ` from a ${noun}`;
  }
  if (e.source && e.source !== "manual") return ` from ${e.source}`;
  return " as a manual journal";
}

function actorPhrase(e: AuditEntry): string {
  switch (e.actorType) {
    case "HUMAN":
      return e.actorId ? `Posted by ${e.actorId}` : "Posted by hand, with nobody recorded";
    case "RULE":
      return e.actorId ? `Posted automatically by rule ${e.actorId}` : "Posted automatically by a rule";
    case "MODEL":
      return e.actorId ? `Posted by model ${e.actorId}` : "Posted by a model that did not name itself";
    case "AGENT":
      return e.actorId ? `Posted by agent ${e.actorId}` : "Posted by an agent that did not name itself";
    case "INTEGRATION":
      return e.actorId ? `Posted by the ${e.actorId} integration` : "Posted by an integration that did not name itself";
    default:
      return e.actorId ? `Posted by ${e.actorId}` : "Posted by something that did not identify itself";
  }
}

/**
 * The entry as a sentence. Order matters: who, from what, when, what it does to
 * other documents, what evidence came with it — which is the order the
 * questions get asked in.
 */
export function storyOf(e: AuditEntry): string {
  let s = `${actorPhrase(e)}${sourcePhrase(e)} on ${on(e.entryDate)}`;
  if (e.settlesId) s += `, settling ${e.settlesId}`;
  if (e.reversalOf) s += `, reversing ${e.reversalOf.reference} of ${on(e.reversalOf.entryDate)}`;
  if (e.reversedBy) s += `, reversed by ${e.reversedBy.reference} on ${on(e.reversedBy.entryDate)}`;
  else if (e.status === "reversed") s += ", since reversed";
  if (e.attachments === 1) s += ", with 1 document attached";
  else if (e.attachments > 1) s += `, with ${e.attachments} documents attached`;
  return `${s}.`;
}
