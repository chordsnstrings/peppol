import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/server/prisma";
import { LedgerError } from "./post";

/**
 * Document numbering, administered.
 *
 * The guarantee this module is built on top of is not in this file. It is
 * `gl_next_number` in the database: one statement against the counter row,
 * whose lock is held until the posting transaction commits, so a posting that
 * fails hands its number back instead of burning it. That is what makes the
 * numbering gapless, and nothing here is allowed to weaken it.
 *
 * So this module deliberately offers no way to move a counter. There is no
 * "set the next number to N", no "skip this one", no "delete an unused
 * number". What it offers is the three things about a series a business can
 * legitimately decide — its prefix, how wide the number is written, and
 * whether it restarts each financial year — plus an honest report of what has
 * actually been issued under it.
 *
 * The one place a refusal is not a matter of taste: a series that restarts
 * yearly must carry the year in its number. UAE Federal Decree-Law 8/2017
 * Article 65, and the Executive Regulation on the particulars of a tax
 * invoice, require a tax invoice to bear a sequential number that uniquely
 * identifies it. A counter that goes back to 1 inside a format that does not
 * name the year hands out last year's references a second time, and two
 * documents sharing a reference is precisely the thing that requirement
 * exists to prevent. The check is in the database as well as here.
 */

/* --------------------------------------------------------------- catalogue */

/**
 * Which series does this product actually post under?
 *
 * Not a list typed out here, because a list typed out here is a list that goes
 * stale the first time somebody adds a module — and a series the product posts
 * to that the screen does not show is worse than no screen at all. The answer
 * is assembled from three places that each know part of it:
 *
 *   1. the source of the ledger modules, which is where a series is decided;
 *   2. the sequence rows, which is every series that has ever taken a number;
 *   3. the documents themselves, which is every series that has issued one.
 *
 * The source scan is the only one of the three that knows about a series
 * before its first document exists. It reads the posting modules and picks up
 * the short upper-case literal assigned to `series` or `scope`, which is how
 * every caller of `post()` and of `gl_next_number` names one.
 */
const LEDGER_SOURCE = path.join(process.cwd(), "src", "lib", "server", "ledger");

/** `series: "GJ"`, `scope = "SQ"`, `const SERIES = "FX"` — and the ternary form. */
const DECLARATION = /\b(?:series|scope|SERIES)\s*[:=]\s*([^;\n}]*)/g;
const SERIES_LITERAL = /"([A-Z][A-Z0-9]{1,3})"/g;

export interface CatalogueEntry {
  scope: string;
  /** The modules that post under it — read from the source, so never stale. */
  modules: string[];
}

export interface Catalogue {
  entries: CatalogueEntry[];
  /** False when the source is not on disk, e.g. a bundled deployment. */
  scanned: boolean;
  note: string;
}

let catalogueOnce: Promise<Catalogue> | null = null;

/** Cached for the life of the process: the source does not change under it. */
export function seriesCatalogue(): Promise<Catalogue> {
  return (catalogueOnce ??= scanLedgerSource());
}

export async function scanLedgerSource(dir = LEDGER_SOURCE): Promise<Catalogue> {
  const found = new Map<string, Set<string>>();
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".ts"));
  } catch {
    return {
      entries: [],
      scanned: false,
      note:
        "The ledger source is not readable from here, so the list below is drawn from the sequences and the " +
        "documents alone. A series that exists in the code but has never issued a document will not appear.",
    };
  }

  for (const file of files) {
    let src: string;
    try {
      src = await fs.readFile(path.join(dir, file), "utf8");
    } catch {
      continue;
    }
    for (const decl of src.matchAll(DECLARATION)) {
      for (const lit of decl[1].matchAll(SERIES_LITERAL)) {
        const set = found.get(lit[1]) ?? new Set<string>();
        set.add(file);
        found.set(lit[1], set);
      }
    }
  }

  return {
    entries: [...found]
      .map(([scope, modules]) => ({ scope, modules: [...modules].sort() }))
      .sort((a, b) => a.scope.localeCompare(b.scope)),
    scanned: true,
    note: `Read from ${files.length} modules in src/lib/server/ledger.`,
  };
}

/**
 * A plain name for the series a reader is most likely to meet. Decoration
 * only: a series with no entry here still appears, named by the modules that
 * post under it, because the list is derived and this map is not.
 */
const KNOWN: Record<string, string> = {
  BK: "Bank entry", CA: "Capital asset scheme adjustment", CL: "Year-end close",
  CP: "Supplier payment", CQ: "Cheque", CR: "Customer receipt", CT: "Corporate tax",
  DA: "Asset disposal", DP: "Depreciation", DT: "Deferred tax",
  EP: "Expense reimbursement", EX: "Expense claim", FX: "Exchange revaluation",
  GJ: "General journal", GR: "Goods receipt", IA: "Stock adjustment", IN: "Stock receipt",
  LI: "Lease recognition", LP: "Lease payment", LS: "Lease charge",
  OB: "Opening balances", PC: "Petty cash", PI: "Supplier invoice",
  PM: "Provision remeasured", PP: "Payroll payment", PR: "Payroll and payment runs",
  PS: "Provision used", PU: "Provision discount unwound", PV: "Provision recognised",
  RJ: "Recurring journal", RV: "Revaluation and impairment", SI: "Sales invoice",
  SO: "Sales order", SQ: "Quotation", WP: "Work in progress",
};

/* ------------------------------------------------------------ the format */

export const YEAR_TOKENS = ["{YYYY}", "{YY}"] as const;

/** The year written into the number, rather than kept beside it. */
export function expandPrefix(prefix: string, cycleStart: string): string {
  const year = cycleStart.slice(0, 4);
  return prefix.replace(/\{YYYY\}/g, year).replace(/\{YY\}/g, year.slice(2));
}

export function formatNumber(prefix: string, n: number, padding: number): string {
  return `${prefix}${String(n).padStart(padding, "0")}`;
}

/**
 * The digits of a document number are its trailing run of digits; everything
 * before them is the format. That rule only reads back unambiguously if a
 * prefix never ends in a digit, which is why configuring one that does is
 * refused — see `checkConfig`.
 */
export function splitNumber(number: string): { prefix: string; n: number; width: number } | null {
  const m = /^(.*?)(\d+)$/.exec(number);
  if (!m) return null;
  return { prefix: m[1], n: Number(m[2]), width: m[2].length };
}

/* --------------------------------------------------------------- the rules */

const SCOPE_SHAPE = /^[A-Z][A-Z0-9]{1,7}$/;
const PREFIX_BODY = /^[A-Za-z0-9/_\- ]*$/;
const MAX_PREFIX = 16;
const MAX_PADDING = 12;

/** Fields a caller might reach for that would put a hole in the numbering. */
const NEVER: Record<string, string> = {
  nextNo: "the next number",
  nextNumber: "the next number",
  currentNumber: "the current number",
  lastNumber: "the last number",
  number: "a number",
  reset: "a reset",
  cycleStart: "which year the counter is in",
};

export interface SeriesConfig {
  prefix: string;
  /** Minimum width; the number is left-padded with zeros to reach it. */
  padding: number;
  restartYearly: boolean;
}

export interface SeriesPatch {
  prefix?: string;
  padding?: number;
  restartYearly?: boolean;
  note?: string;
}

/**
 * Everything that would make a configuration unsafe, refused with the reason.
 * Called by `configureSeries` before it writes and by `previewSeries` before
 * anything is saved, so the refusal is seen while the form is still open.
 */
export function checkConfig(scope: string, cfg: SeriesConfig): void {
  if (!SCOPE_SHAPE.test(scope)) {
    throw new LedgerError(
      `"${scope}" is not the shape of a series code. A series is two to eight upper-case letters or digits, ` +
        `starting with a letter — GJ, SI, PR.`,
    );
  }

  const stripped = cfg.prefix.replace(/\{YYYY\}/g, "").replace(/\{YY\}/g, "");
  const stray = /\{[^}]*\}/.exec(stripped);
  if (stray) {
    throw new LedgerError(
      `${stray[0]} is not something the numbering can fill in. The only placeholders are ` +
        `${YEAR_TOKENS.join(" and ")}, which become the financial year the document is issued in.`,
    );
  }
  if (!PREFIX_BODY.test(stripped)) {
    throw new LedgerError(
      `A prefix may hold letters, digits, spaces and - / _ only. A reference that cannot be typed into a bank ` +
        `narration or an FTA portal is a reference nobody can trace back to the document.`,
    );
  }
  if (expandPrefix(cfg.prefix, "2026-01-01").length > MAX_PREFIX) {
    throw new LedgerError(`A prefix of more than ${MAX_PREFIX} characters is longer than the number it introduces.`);
  }
  if (/\d$/.test(expandPrefix(cfg.prefix, "2026-01-01"))) {
    throw new LedgerError(
      `A prefix cannot end in a digit, because the number that follows it would run straight into it: ` +
        `"${expandPrefix(cfg.prefix, "2026-01-01")}${"1".padStart(cfg.padding, "0")}" cannot be read back as a ` +
        `prefix and a counter. End it with a separator — a hyphen, a slash or a space.`,
    );
  }

  if (!Number.isInteger(cfg.padding) || cfg.padding < 1 || cfg.padding > MAX_PADDING) {
    throw new LedgerError(`The minimum width is a whole number between 1 and ${MAX_PADDING}; ${cfg.padding} is not.`);
  }

  if (cfg.restartYearly && !YEAR_TOKENS.some((t) => cfg.prefix.includes(t))) {
    throw new LedgerError(
      `A series that restarts each financial year has to carry the year in the number. Without it the counter ` +
        `returns to 1 into the same format it used last year, so this year's document number 1 is a reference ` +
        `that already belongs to another document — and UAE Federal Decree-Law 8/2017 Article 65, with the ` +
        `Executive Regulation on the particulars of a tax invoice, requires a tax invoice to carry a sequential ` +
        `number that uniquely identifies it. Put ${YEAR_TOKENS.join(" or ")} in the prefix, or leave the series ` +
        `running continuously.`,
    );
  }
}

/* ------------------------------------------------------------ what is where */

/**
 * Where the documents of a series live. Two homes call `gl_next_number`: the
 * journal, and sales orders and quotations. Both are read for every series
 * rather than mapped from the scan, so a series that moves home still reports.
 * A third home added in future would not be read here — which is why the
 * report says so out loud when a series has allocated numbers it cannot find.
 */
interface IssuedDoc {
  id: string;
  /** As stored: prefix and digits, without the series code for a journal. */
  number: string;
  reference: string;
  date: string;
  status: string;
  /** Cancelled, reversed, declined — the document keeps its number. */
  retired: boolean;
  label: string | null;
}

const RETIRED = new Set(["reversed", "cancelled", "declined", "expired", "void"]);

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

async function issuedDocuments(orgId: string, entityId: string, scopes: Set<string>) {
  // Numbers only. This is the one read that has to see the whole ledger — a
  // gap is a fact about the numbering and the numbering has no dates — so it
  // takes the narrowest row it can and pulls nothing through the lines.
  const [entries, orders] = await Promise.all([
    prisma.journalEntry.findMany({
      where: { orgId, entityId },
      select: { id: true, series: true, number: true, entryDate: true, status: true, memo: true },
    }),
    prisma.salesOrder.findMany({
      where: { orgId, entityId },
      select: { id: true, number: true, issuedOn: true, status: true, customerName: true },
    }),
  ]);

  const by = new Map<string, IssuedDoc[]>();
  const push = (scope: string, doc: IssuedDoc) => by.set(scope, [...(by.get(scope) ?? []), doc]);

  for (const e of entries) {
    push(e.series, {
      id: e.id,
      number: e.number,
      reference: `${e.series}-${e.number}`,
      date: isoDay(e.entryDate),
      status: e.status,
      retired: RETIRED.has(e.status),
      label: e.memo,
    });
  }

  // A sales order carries its scope inside its own number, "SO-00007". One
  // typed in by hand belongs to no series and is counted as unattributed
  // rather than quietly folded into one.
  const unattributed: string[] = [];
  for (const o of orders) {
    const scope = o.number.split("-")[0];
    if (!scopes.has(scope)) {
      unattributed.push(o.number);
      continue;
    }
    push(scope, {
      id: o.id,
      number: o.number,
      reference: o.number,
      date: isoDay(o.issuedOn),
      status: o.status,
      retired: RETIRED.has(o.status),
      label: o.customerName,
    });
  }

  return { by, unattributed };
}

/* -------------------------------------------------------------- integrity */

export type Verdict = "clean" | "gap" | "reuse" | "unchecked" | "empty";

export interface NumberRun {
  /** The literal format these numbers were issued under. */
  prefix: string;
  from: string;
  to: string;
  count: number;
  firstIssued: string;
}

export interface SeriesIntegrity {
  verdict: Verdict;
  issued: number;
  /** Documents still in force. */
  live: number;
  /** Reversed or cancelled. They keep their numbers, so they are not gaps. */
  retired: number;
  firstReference: string | null;
  lastReference: string | null;
  runs: NumberRun[];
  /** Numbers no document carries at all. The first twelve, with the count. */
  gaps: string[];
  gapCount: number;
  /** One number string on more than one document. */
  duplicates: string[];
  unreadable: string[];
  note: string;
}

const MAX_LISTED = 12;

function integrityOf(
  scope: string,
  docs: IssuedDoc[],
  seq: { nextNo: number; padding: number } | null,
  allocatedThisCycle: number | null,
): SeriesIntegrity {
  const reference = (prefix: string, n: number, width: number) => {
    const shown = formatNumber(prefix, n, width);
    return shown.startsWith(scope) ? shown : `${scope}-${shown}`;
  };

  const unreadable: string[] = [];
  interface Group { prefix: string; width: number; nums: Map<number, IssuedDoc[]>; first: string }
  const groups = new Map<string, Group>();
  const byNumber = new Map<string, IssuedDoc[]>();

  for (const d of docs) {
    byNumber.set(d.number, [...(byNumber.get(d.number) ?? []), d]);
    const parsed = splitNumber(d.number);
    if (!parsed) {
      unreadable.push(d.reference);
      continue;
    }
    const g = groups.get(parsed.prefix) ?? { prefix: parsed.prefix, width: parsed.width, nums: new Map(), first: d.date };
    g.nums.set(parsed.n, [...(g.nums.get(parsed.n) ?? []), d]);
    if (d.date < g.first) g.first = d.date;
    g.width = Math.max(g.width, parsed.width);
    groups.set(parsed.prefix, g);
  }

  // Ordered by when each format was first used, not by number: a series that
  // restarts each year has two runs both beginning at 1, and sorting those by
  // value would report the older one as a hole in the newer.
  const ordered = [...groups.values()].sort((a, b) => (a.first === b.first ? a.prefix.localeCompare(b.prefix) : a.first < b.first ? -1 : 1));

  const gaps: string[] = [];
  let gapCount = 0;
  const miss = (prefix: string, width: number, from: number, to: number) => {
    for (let n = from; n <= to; n++) {
      gapCount++;
      if (gaps.length < MAX_LISTED) gaps.push(reference(prefix, n, width));
    }
  };

  let previous: { prefix: string; width: number; max: number } | null = null;
  const runs: NumberRun[] = [];

  for (const g of ordered) {
    const values = [...g.nums.keys()].sort((a, b) => a - b);
    const min = values[0];
    const max = values[values.length - 1];

    if (previous === null) {
      // The very first document of a series is number 1 — unless the counter
      // has never existed, in which case the numbers came from somewhere else
      // and there is nothing here to check them against.
      if (seq && min > 1) miss(g.prefix, g.width, 1, min - 1);
    } else if (min !== 1 && min > previous.max + 1) {
      // Not a restart, so the numbers between the two formats were handed out
      // under the old one and never came back.
      miss(previous.prefix, previous.width, previous.max + 1, min - 1);
    }

    for (let n = min; n <= max; n++) if (!g.nums.has(n)) miss(g.prefix, g.width, n, n);

    runs.push({
      prefix: g.prefix,
      from: reference(g.prefix, min, g.width),
      to: reference(g.prefix, max, g.width),
      count: values.length,
      firstIssued: g.first,
    });
    previous = { prefix: g.prefix, width: g.width, max };
  }

  // And the numbers the counter says it handed out after the last document.
  // Nothing in the posting path can produce those: a rolled-back posting
  // returns its number. They mean something was removed from outside it.
  if (previous && allocatedThisCycle !== null && allocatedThisCycle > previous.max) {
    miss(previous.prefix, previous.width, previous.max + 1, allocatedThisCycle);
  }

  const duplicates = [...byNumber.entries()].filter(([, d]) => d.length > 1).map(([n]) => n);
  const live = docs.filter((d) => !d.retired).length;
  const retired = docs.length - live;

  const allocated = seq ? seq.nextNo - 1 : 0;
  const verdict: Verdict =
    duplicates.length > 0 ? "reuse"
    : gapCount > 0 ? "gap"
    : docs.length === 0 ? (allocated > 0 ? "unchecked" : "empty")
    : unreadable.length > 0 ? "unchecked"
    : "clean";

  const note =
    verdict === "reuse"
      ? `${duplicates.slice(0, MAX_LISTED).join(", ")} ${duplicates.length === 1 ? "is" : "are"} on more than one ` +
        `document. The counter never returns a number twice, so these were not both numbered by it — until it is ` +
        `resolved, nobody can say which document a reference names.`
      : verdict === "gap"
      ? `${gapCount} ${gapCount === 1 ? "number was" : "numbers were"} allocated and no document carries ` +
        `${gapCount === 1 ? "it" : "them"}. A reversed or cancelled document keeps its number, so these are not ` +
        `those — they are numbers nothing at all is filed under. The counter cannot produce that: it allocates ` +
        `inside the posting transaction and a posting that fails returns its number. Something was removed from ` +
        `the ledger outside the posting path.`
      : verdict === "unchecked" && docs.length === 0
      ? `${allocated} ${allocated === 1 ? "number has" : "numbers have"} been taken from this counter and no ` +
        `document carrying one was found in the journal or in sales orders. Either they belong to a document ` +
        `this report does not read, or they are gone.`
      : verdict === "unchecked"
      ? `${unreadable.length} ${unreadable.length === 1 ? "reference does" : "references do"} not end in digits ` +
        `(${unreadable.slice(0, 5).join(", ")}), so ${unreadable.length === 1 ? "it was" : "they were"} left out ` +
        `of the run and only checked for reuse.`
      : verdict === "empty"
      ? "Nothing has been issued under this series yet."
      : `${docs.length} issued, running unbroken` +
        (runs.length > 1 ? ` across ${runs.length} formats` : "") +
        (retired > 0 ? `; ${retired} reversed or cancelled, which keep their numbers.` : ".");

  const last = ordered.length
    ? (() => {
        const g = ordered[ordered.length - 1];
        const max = Math.max(...g.nums.keys());
        return g.nums.get(max)![0];
      })()
    : null;
  const firstGroup = ordered[0];
  const first = firstGroup ? firstGroup.nums.get(Math.min(...firstGroup.nums.keys()))![0] : null;

  return {
    verdict,
    issued: docs.length,
    live,
    retired,
    firstReference: first?.reference ?? null,
    lastReference: last?.reference ?? null,
    runs,
    gaps,
    gapCount,
    duplicates: duplicates.slice(0, MAX_LISTED),
    unreadable: unreadable.slice(0, MAX_LISTED),
    note,
  };
}

/* ----------------------------------------------------------------- reading */

export interface Cycle {
  /** Start of the financial year a number issued today would belong to. */
  start: string;
  year: string;
  /** Where the next restart falls, and what the year in the number becomes. */
  next: { start: string; year: string };
  /** True when the entity has a fiscal calendar; otherwise the calendar year. */
  fromFiscalYear: boolean;
}

/**
 * One definition of "which year are we numbering in", shared with the
 * allocator: `gl_sequence_cycle` is the same function `gl_next_number` calls,
 * so the screen and the counter can never disagree about when a year turns.
 */
export async function currentCycle(orgId: string, entityId: string): Promise<Cycle> {
  const [{ d }] = await prisma.$queryRaw<{ d: string }[]>`
    SELECT gl_sequence_cycle(${orgId}, ${entityId})::text AS d`;

  const years = await prisma.fiscalYear.findMany({
    where: { orgId, entityId },
    select: { startsOn: true },
    orderBy: { startsOn: "asc" },
  });
  const starts = years.map((y) => isoDay(y.startsOn));
  const next = starts.find((s) => s > d) ?? `${Number(d.slice(0, 4)) + 1}${d.slice(4)}`;

  return {
    start: d,
    year: d.slice(0, 4),
    next: { start: next, year: next.slice(0, 4) },
    fromFiscalYear: starts.includes(d),
  };
}

export interface SeriesChange {
  changedAt: string;
  effectiveFromNo: number;
  from: SeriesConfig;
  to: SeriesConfig;
  note: string | null;
  actorId: string | null;
}

export interface SeriesRow extends SeriesConfig {
  scope: string;
  label: string;
  /** The modules that post under it, read from the source. */
  modules: string[];
  /** False where the series has never been configured or taken a number. */
  configured: boolean;
  /** The prefix as it currently reads, with the year filled in. */
  expandedPrefix: string;
  /** Numbers taken from this counter, in the year it is currently inside. */
  allocated: number;
  /** What the next document will be called. */
  nextReference: string;
  /** True when the next document opens a new year and restarts the counter. */
  restartPending: boolean;
  lastIssued: { reference: string; date: string; status: string; label: string | null } | null;
  integrity: SeriesIntegrity;
  changes: SeriesChange[];
}

export interface NumberingOverview {
  cycle: Cycle;
  series: SeriesRow[];
  catalogue: { scanned: boolean; note: string };
  /** Numbers found on documents that belong to no series this product knows. */
  unattributed: string[];
}

const DEFAULTS: SeriesConfig = { prefix: "", padding: 5, restartYearly: false };

/** Every series this entity uses, with its configuration and its integrity. */
export async function numberingOverview(opts: { orgId: string; entityId: string }): Promise<NumberingOverview> {
  const { orgId, entityId } = opts;

  const [catalogue, sequences, cycle, changes] = await Promise.all([
    seriesCatalogue(),
    prisma.documentSequence.findMany({ where: { orgId, entityId } }),
    currentCycle(orgId, entityId),
    prisma.documentSequenceChange.findMany({
      where: { orgId, entityId },
      orderBy: { changedAt: "desc" },
    }),
  ]);

  const scopes = new Set<string>([...catalogue.entries.map((e) => e.scope), ...sequences.map((s) => s.scope)]);
  // A series that has issued documents but has neither a counter nor a line of
  // source behind it still belongs on the screen — it is in the books.
  const entrySeries = await prisma.journalEntry.findMany({
    where: { orgId, entityId },
    select: { series: true },
    distinct: ["series"],
  });
  for (const e of entrySeries) scopes.add(e.series);

  const { by, unattributed } = await issuedDocuments(orgId, entityId, scopes);
  for (const scope of by.keys()) scopes.add(scope);

  const modulesOf = new Map(catalogue.entries.map((e) => [e.scope, e.modules]));
  const sequenceOf = new Map(sequences.map((s) => [s.scope, s]));

  const series = [...scopes].sort().map((scope) => {
    const seq = sequenceOf.get(scope) ?? null;
    const docs = by.get(scope) ?? [];
    const cfg: SeriesConfig = seq
      ? { prefix: seq.prefix, padding: seq.padding, restartYearly: seq.restartYearly }
      : { ...DEFAULTS };

    // A restart is pending when the counter is still sitting in a year that
    // has ended. The next document opens the new one at 1.
    const restartPending = Boolean(seq && seq.restartYearly && (seq.cycleStart === null || isoDay(seq.cycleStart) !== cycle.start));
    const nextNo = seq ? (restartPending ? 1 : seq.nextNo) : 1;
    const allocated = seq ? (restartPending ? 0 : seq.nextNo - 1) : 0;
    const expandedPrefix = expandPrefix(cfg.prefix, cycle.start);

    // `nextNo - 1` is the last number this counter handed out, whichever year
    // it belongs to — which is the last run, restart pending or not.
    const integrity = integrityOf(scope, docs, seq, seq ? seq.nextNo - 1 : null);
    const lastRef = integrity.lastReference;
    const lastDoc = lastRef ? docs.find((d) => d.reference === lastRef) ?? null : null;

    return {
      scope,
      label: KNOWN[scope] ?? (modulesOf.get(scope)?.map((m) => m.replace(/\.ts$/, "")).join(", ") ?? "Not declared in the source"),
      modules: modulesOf.get(scope) ?? [],
      configured: seq !== null,
      ...cfg,
      expandedPrefix,
      allocated,
      nextReference: `${scope}-${formatNumber(expandedPrefix, nextNo, cfg.padding)}`,
      restartPending,
      lastIssued: lastDoc
        ? { reference: lastDoc.reference, date: lastDoc.date, status: lastDoc.status, label: lastDoc.label }
        : null,
      integrity,
      changes: changes
        .filter((c) => c.scope === scope)
        .map((c) => ({
          changedAt: c.changedAt.toISOString(),
          effectiveFromNo: c.effectiveFromNo,
          from: { prefix: c.fromPrefix, padding: c.fromPadding, restartYearly: c.fromRestartYearly },
          to: { prefix: c.toPrefix, padding: c.toPadding, restartYearly: c.toRestartYearly },
          note: c.note,
          actorId: c.actorId,
        })),
    };
  });

  return {
    cycle,
    series,
    catalogue: { scanned: catalogue.scanned, note: catalogue.note },
    unattributed: unattributed.slice(0, MAX_LISTED),
  };
}

/**
 * Two series sharing a prefix put what reads as the same reference on two
 * different documents, told apart only by a series code the person holding the
 * paper cannot see. Checked in the preview as well as on the way in, so the
 * refusal arrives while the form is still open.
 */
async function assertPrefixFree(orgId: string, entityId: string, scope: string, prefix: string) {
  if (prefix === "") return;
  const clash = await prisma.documentSequence.findFirst({
    where: { orgId, entityId, prefix, scope: { not: scope } },
    select: { scope: true },
  });
  if (clash) {
    throw new LedgerError(
      `Series ${clash.scope} already numbers with "${prefix}". Two series sharing a prefix put the same ` +
        `reference on two different documents, which is what a reference exists to prevent.`,
    );
  }
}

/* ----------------------------------------------------------------- preview */

export interface Preview {
  scope: string;
  config: SeriesConfig;
  /** What the next document will be called if this is saved. */
  next: string;
  /** And the one after it, so the counter is visible as a counter. */
  following: string;
  /** The first number of the next financial year under this configuration. */
  afterRestart: string;
  /** What it would be called if nothing is changed. */
  current: string;
  restartsOn: string;
  changes: string[];
}

/**
 * What the next reference will look like, worked out before anything is saved.
 * It refuses exactly what saving would refuse, so a configuration that cannot
 * be kept is rejected while the form is still open rather than after.
 */
export async function previewSeries(opts: {
  orgId: string;
  entityId: string;
  scope: string;
  patch: SeriesPatch;
}): Promise<Preview> {
  const { orgId, entityId, scope } = opts;
  const [seq, cycle] = await Promise.all([
    prisma.documentSequence.findFirst({ where: { orgId, entityId, scope } }),
    currentCycle(orgId, entityId),
  ]);

  const now: SeriesConfig = seq
    ? { prefix: seq.prefix, padding: seq.padding, restartYearly: seq.restartYearly }
    : { ...DEFAULTS };
  const cfg = merge(now, opts.patch);
  checkConfig(scope, cfg);
  await assertPrefixFree(orgId, entityId, scope, cfg.prefix);

  const restartPending = Boolean(seq && seq.restartYearly && (seq.cycleStart === null || isoDay(seq.cycleStart) !== cycle.start));
  const nextNo = seq ? (restartPending ? 1 : seq.nextNo) : 1;
  // A change of format never moves the counter. That is the whole point: the
  // next document takes the number it was always going to take, written the
  // new way.
  const ref = (c: SeriesConfig, n: number, cycleStart: string) =>
    `${scope}-${formatNumber(expandPrefix(c.prefix, cycleStart), n, c.padding)}`;

  const changes: string[] = [];
  if (cfg.prefix !== now.prefix) changes.push(`prefix "${now.prefix}" → "${cfg.prefix}"`);
  if (cfg.padding !== now.padding) changes.push(`minimum width ${now.padding} → ${cfg.padding}`);
  if (cfg.restartYearly !== now.restartYearly) {
    changes.push(cfg.restartYearly ? "restarts each financial year" : "runs continuously");
  }

  return {
    scope,
    config: cfg,
    next: ref(cfg, nextNo, cycle.start),
    following: ref(cfg, nextNo + 1, cycle.start),
    afterRestart: cfg.restartYearly ? ref(cfg, 1, cycle.next.start) : ref(cfg, nextNo + 1, cycle.next.start),
    current: ref(now, nextNo, cycle.start),
    restartsOn: cycle.next.start,
    changes,
  };
}

/* ----------------------------------------------------------------- writing */

function merge(now: SeriesConfig, patch: SeriesPatch): SeriesConfig {
  return {
    prefix: patch.prefix === undefined ? now.prefix : String(patch.prefix).trim(),
    padding: patch.padding === undefined ? now.padding : Number(patch.padding),
    restartYearly: patch.restartYearly === undefined ? now.restartYearly : Boolean(patch.restartYearly),
  };
}

/**
 * Change a series' format. The counter is not an argument and cannot be made
 * one — a field that would move it is refused by name, because "set the next
 * number to 250" is how a business ends up with a reference on two documents
 * or a hole where a document should be.
 */
export async function configureSeries(opts: {
  orgId: string;
  entityId: string;
  scope: string;
  patch: SeriesPatch & Record<string, unknown>;
  actorId?: string;
}): Promise<{ changed: boolean; series: SeriesRow; preview: Preview }> {
  const { orgId, entityId, scope, patch } = opts;

  for (const [field, what] of Object.entries(NEVER)) {
    if (patch[field] !== undefined) {
      throw new LedgerError(
        `Numbering will not let you set ${what}. The counter is allocated inside the transaction that writes the ` +
          `document and its row stays locked until that commits, which is what makes the sequence gapless and what ` +
          `makes a reference unique — moving it by hand would either skip numbers nothing is filed under or issue ` +
          `one twice. Change the prefix or the width instead; the next document keeps the number it was due.`,
      );
    }
  }

  const [existing, cycle, catalogue] = await Promise.all([
    prisma.documentSequence.findFirst({ where: { orgId, entityId, scope } }),
    currentCycle(orgId, entityId),
    seriesCatalogue(),
  ]);

  // A configuration for a series nothing posts under is configuration nobody
  // will ever see the effect of, and it would sit on this screen looking real.
  if (!existing && catalogue.scanned) {
    const known = new Set(catalogue.entries.map((e) => e.scope));
    if (!known.has(scope)) {
      const entries = await prisma.journalEntry.count({ where: { orgId, entityId, series: scope } });
      if (entries === 0) {
        throw new LedgerError(
          `Nothing in this product posts under "${scope}", so configuring it would have no effect on any document. ` +
            `The series in use are ${[...known].sort().join(", ")}.`,
        );
      }
    }
  }

  const now: SeriesConfig = existing
    ? { prefix: existing.prefix, padding: existing.padding, restartYearly: existing.restartYearly }
    : { ...DEFAULTS };
  const cfg = merge(now, patch);
  checkConfig(scope, cfg);

  await assertPrefixFree(orgId, entityId, scope, cfg.prefix);

  const unchanged =
    cfg.prefix === now.prefix && cfg.padding === now.padding && cfg.restartYearly === now.restartYearly;

  if (!unchanged) {
    const restartPending = Boolean(
      existing && existing.restartYearly && (existing.cycleStart === null || isoDay(existing.cycleStart) !== cycle.start),
    );
    const effectiveFromNo = existing ? (restartPending ? 1 : existing.nextNo) : 1;

    try {
      await prisma.$transaction(async (tx) => {
        if (existing) {
          // The counter and the year it is in are deliberately absent from
          // this update: a format change must not move either.
          await tx.documentSequence.update({
            where: { id: existing.id },
            data: { prefix: cfg.prefix, padding: cfg.padding, restartYearly: cfg.restartYearly },
          });
        } else {
          await tx.documentSequence.create({
            data: {
              orgId, entityId, scope,
              prefix: cfg.prefix, padding: cfg.padding, restartYearly: cfg.restartYearly,
              nextNo: 1, cycleStart: new Date(`${cycle.start}T00:00:00.000Z`),
            },
          });
        }
        await tx.documentSequenceChange.create({
          data: {
            orgId, entityId, scope,
            effectiveFromNo,
            fromPrefix: now.prefix, toPrefix: cfg.prefix,
            fromPadding: now.padding, toPadding: cfg.padding,
            fromRestartYearly: now.restartYearly, toRestartYearly: cfg.restartYearly,
            note: typeof patch.note === "string" && patch.note.trim() ? patch.note.trim() : null,
            actorId: opts.actorId ?? null,
          },
        });
      });
    } catch (e) {
      // The database keeps the year rule too. If it is what refused, say the
      // same thing the application would have said rather than a 500.
      if (String(e).includes("DocumentSequence_restart_needs_year_check")) {
        checkConfig(scope, { ...cfg, restartYearly: true });
      }
      throw e;
    }
  }

  const overview = await numberingOverview({ orgId, entityId });
  const series = overview.series.find((s) => s.scope === scope)!;
  return { changed: !unchanged, series, preview: await previewSeries({ orgId, entityId, scope, patch: {} }) };
}
