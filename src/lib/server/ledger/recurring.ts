import { prisma } from "@/lib/server/prisma";
import { fmtMinor } from "@/lib/ledger/format";
import { post, LedgerError } from "./post";

/**
 * Recurring journals, accruals and prepayments.
 *
 * The template is not the entries. A template is a standing instruction — rent
 * of 15,000 a month, an accrual for a utility bill that always arrives late —
 * and it is mutable: someone will edit the amount, rename it, or delete it
 * outright. Every run therefore posts a real, independent journal that carries
 * its own accounts, its own amounts and its own memo, and still says exactly
 * what it said on the day it was posted after the template has changed or gone.
 * A posting whose meaning depends on a mutable template is a posting nobody can
 * audit; it would be an entry whose history rewrites itself.
 *
 * Two consequences of that follow through the whole file:
 *
 *  - the template lines are validated when the template is SAVED, not when it
 *    runs. A template that will fail every month at midnight is worse than one
 *    that refuses to be saved, because the failure surfaces when nobody is
 *    watching and the ledger is quietly a month short.
 *  - idempotency is keyed on the template's id and the period, never its code.
 *    Renaming RENT to RENT-DXB must not re-post four years of rent.
 *
 * Accruals are the reason this module earns its place. An accrual recognises a
 * cost before its invoice arrives — Dr expense, Cr 2050 accrued expenses — and
 * it MUST be released on the first day of the following period. If it is not,
 * the supplier invoice lands in that period and the cost is counted twice. So
 * the release is posted at the same time as the accrual, in the same run, not
 * left as a task somebody has to remember.
 */

export type Frequency = "MONTHLY" | "QUARTERLY" | "ANNUAL";
export type Kind = "ACCRUAL" | "PREPAYMENT" | "STANDING";

/** How many months one cycle of each frequency spans. */
const STEP: Record<string, number> = { MONTHLY: 1, QUARTERLY: 3, ANNUAL: 12 };

/** A template line as it is stored: whole minor units, written as digits. */
export interface TemplateLine {
  account: string;
  /** Exactly one of debit / credit, in minor units as a decimal string. */
  debit?: string;
  credit?: string;
  memo?: string;
}

/** What a caller may hand in. Numbers and bigints are accepted; floats are not. */
export interface TemplateLineInput {
  account: string;
  debit?: number | bigint | string;
  credit?: number | bigint | string;
  memo?: string;
}

export interface NewTemplate {
  code: string;
  name: string;
  frequency?: Frequency;
  startsOn: string;
  endsOn?: string | null;
  kind?: Kind;
  /** Defaults to true for an accrual, false for everything else. */
  autoReverse?: boolean;
  lines: TemplateLineInput[];
}

/* ------------------------------------------------------------- month maths */

/** "2026-03" → an ordinal, so periods can be compared and counted. */
const monthIndex = (label: string) => {
  const [y, m] = label.split("-").map(Number);
  return y * 12 + (m - 1);
};
const monthLabel = (i: number) => `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, "0")}`;
const monthOfDate = (d: Date) => d.getUTCFullYear() * 12 + d.getUTCMonth();
/** Last day of the month with that ordinal, as YYYY-MM-DD. */
const lastDayOf = (i: number) => new Date(Date.UTC(Math.floor(i / 12), (i % 12) + 1, 0)).toISOString().slice(0, 10);
/** First day of the month with that ordinal, as YYYY-MM-DD. */
const firstDayOf = (i: number) => new Date(Date.UTC(Math.floor(i / 12), i % 12, 1)).toISOString().slice(0, 10);

/**
 * A figure in the book's own currency, through the one formatter that knows how
 * many decimals a currency has. Splitting the digits two from the right is
 * right for a dirham and wrong by a factor of ten for a Kuwaiti or Bahraini
 * dinar or an Omani rial.
 */
const fmtIn = (currency: string) => (minor: bigint) =>
  fmtMinor(minor, currency, { sign: "minus", zero: "zero" });

/** The currency this entity keeps its books in. */
async function bookCurrency(orgId: string, entityId: string): Promise<string> {
  const book = await prisma.book.findFirst({
    where: { orgId, entityId, code: "PRIMARY" },
    select: { functionalCurrency: true },
  });
  return book?.functionalCurrency ?? "AED";
}

const requirePeriod = (period: string) => {
  if (!/^\d{4}-\d{2}$/.test(period)) throw new LedgerError("A recurring period looks like 2026-03.");
  const m = Number(period.slice(5));
  if (m < 1 || m > 12) throw new LedgerError(`There is no month ${period.slice(5)}. A recurring period looks like 2026-03.`);
  return monthIndex(period);
};

/* ------------------------------------------------------------------- lines */

/**
 * The shape Prisma gives back. Declared rather than inferred so this file reads
 * the same whether or not the client has been regenerated.
 */
export type RecurringRow = {
  id: string;
  orgId: string;
  entityId: string;
  code: string;
  name: string;
  frequency: string;
  startsOn: Date;
  endsOn: Date | null;
  runCount: number;
  lastRunPeriod: string | null;
  lines: string;
  kind: string;
  autoReverse: boolean;
  status: string;
};

/** One amount off a template line, in minor units. Floats never get through. */
function minorOf(raw: unknown, account: string, side: "debit" | "credit", where: string): bigint {
  if (typeof raw === "bigint") return raw;
  if (typeof raw === "number") {
    if (!Number.isInteger(raw)) {
      throw new LedgerError(
        `The ${side} on account ${account} in ${where} must be a whole number of minor units (fils), not ${raw}. Ledger amounts are never fractions.`,
      );
    }
    return BigInt(raw);
  }
  if (typeof raw === "string" && /^-?\d+$/.test(raw.trim())) return BigInt(raw.trim());
  throw new LedgerError(
    `The ${side} on account ${account} in ${where} must be a whole number of minor units (fils), written as digits.`,
  );
}

/**
 * Normalise caller-supplied lines into what gets stored.
 *
 * Everything that can be checked without touching the database is checked here,
 * so the message names the line and the account rather than arriving as a
 * database constraint later.
 */
export function normaliseLines(input: unknown, where: string): TemplateLine[] {
  if (!Array.isArray(input)) {
    throw new LedgerError(`The lines of ${where} must be a list of journal lines.`);
  }
  return input.map((raw, i) => {
    if (!raw || typeof raw !== "object") {
      throw new LedgerError(`Line ${i + 1} of ${where} is not a journal line.`);
    }
    const l = raw as Record<string, unknown>;
    const account = typeof l.account === "string" ? l.account.trim() : "";
    if (!account) throw new LedgerError(`Line ${i + 1} of ${where} must name an account.`);

    const hasD = l.debit !== undefined && l.debit !== null && l.debit !== "";
    const hasC = l.credit !== undefined && l.credit !== null && l.credit !== "";
    if (hasD === hasC) {
      throw new LedgerError(
        `Line ${i + 1} of ${where} (account ${account}) must carry exactly one of debit or credit.`,
      );
    }
    const v = minorOf(hasD ? l.debit : l.credit, account, hasD ? "debit" : "credit", where);
    if (v < 0n) {
      throw new LedgerError(
        `Use the debit or the credit side on account ${account} in ${where} rather than a negative amount.`,
      );
    }
    if (v === 0n) {
      throw new LedgerError(`A zero amount on account ${account} in ${where} carries no information.`);
    }
    const memo = typeof l.memo === "string" && l.memo.trim() ? l.memo.trim() : undefined;
    return hasD
      ? { account, debit: v.toString(), ...(memo ? { memo } : {}) }
      : { account, credit: v.toString(), ...(memo ? { memo } : {}) };
  });
}

/**
 * Read the lines back off a saved template.
 *
 * The column is a JSON string, and a string column can hold anything — a
 * half-written edit, a value put there by a migration, a truncated write. The
 * parse is therefore defensive and the failure names the template, because
 * "Unexpected token } in JSON at position 42" tells a bookkeeper nothing about
 * which standing instruction is broken.
 */
export function parseTemplateLines(t: Pick<RecurringRow, "code" | "name" | "lines">): TemplateLine[] {
  const where = `template ${t.code} (${t.name})`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(t.lines);
  } catch {
    throw new LedgerError(
      `The saved lines of ${where} are not readable JSON, so it cannot post. Open the template, re-enter its lines and save it again.`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new LedgerError(
      `The saved lines of ${where} are not a list of journal lines, so it cannot post. Open the template, re-enter its lines and save it again.`,
    );
  }
  return normaliseLines(parsed, where);
}

/** Total debits, which for a balanced template is also the total credits. */
export function templateTotal(lines: TemplateLine[]): bigint {
  return lines.reduce((a, l) => a + (l.debit ? BigInt(l.debit) : 0n), 0n);
}

/**
 * Everything about a template's lines that needs the chart of accounts.
 *
 * Run at save time, and again immediately before a run — an account can be
 * archived between the two, and finding that out here means the run reports it
 * as a skip naming the account instead of the whole batch dying on a post.
 */
export async function checkLinesAgainstChart(opts: {
  orgId: string;
  entityId: string;
  lines: TemplateLine[];
  where: string;
}) {
  const { lines, where } = opts;
  const fmt = fmtIn(await bookCurrency(opts.orgId, opts.entityId));

  if (lines.length < 2) {
    throw new LedgerError(`${cap(where)} needs at least two lines — a journal with one line cannot balance.`);
  }

  const debits = lines.reduce((a, l) => a + (l.debit ? BigInt(l.debit) : 0n), 0n);
  const credits = lines.reduce((a, l) => a + (l.credit ? BigInt(l.credit) : 0n), 0n);
  if (debits !== credits) {
    throw new LedgerError(
      `${cap(where)} does not balance: debits are ${fmt(debits)} against credits of ${fmt(credits)}, out by ${fmt(debits - credits)}. A template that does not balance would fail every period it ran, so it cannot be saved.`,
    );
  }

  const codes = [...new Set(lines.map((l) => l.account))];
  const accounts = await prisma.account.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: { in: codes } },
    select: { code: true, name: true, isPostable: true, isControl: true, status: true },
  });
  const byCode = new Map(accounts.map((a) => [a.code, a]));

  for (const code of codes) {
    const a = byCode.get(code);
    if (!a) {
      throw new LedgerError(
        `Account ${code} does not exist in this entity's chart, so ${where} cannot post to it.`,
      );
    }
    if (!a.isPostable) {
      throw new LedgerError(
        `Account ${a.code} ${a.name} is a heading, not a postable account, so ${where} cannot post to it. Choose one of its sub-accounts.`,
      );
    }
    if (a.isControl) {
      throw new LedgerError(
        `Account ${a.code} ${a.name} is a control account — it is maintained by its subledger, so ${where} must not post to it. Raise the underlying document instead.`,
      );
    }
    if (a.status !== "active") {
      throw new LedgerError(`Account ${a.code} ${a.name} is archived, so ${where} cannot post to it.`);
    }
  }

  return { debits, credits };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/* --------------------------------------------------------------- templates */

/**
 * An accrual that does not reverse is the single most expensive mistake this
 * module can let through: the invoice arrives next month and the cost is in the
 * books twice. So auto-reversal defaults on for an accrual, and a prepayment is
 * refused it outright — releasing a prepayment moves cost out of 1300 into the
 * period it belongs to, and reversing that release the next day would undo the
 * only thing it was for.
 */
function resolveAutoReverse(kind: Kind, asked: boolean | undefined, code: string): boolean {
  if (kind === "PREPAYMENT" && asked === true) {
    throw new LedgerError(
      `Template ${code} is a prepayment, and a prepayment release is not reversed — the cost stays in the period it belongs to. Turn auto-reversal off, or record this as an accrual instead.`,
    );
  }
  if (asked !== undefined) return asked;
  return kind === "ACCRUAL";
}

function requireKind(kind: string | undefined, code: string): Kind {
  const k = (kind ?? "STANDING") as Kind;
  if (k !== "ACCRUAL" && k !== "PREPAYMENT" && k !== "STANDING") {
    throw new LedgerError(`Template ${code} must be an ACCRUAL, a PREPAYMENT or a STANDING charge, not "${kind}".`);
  }
  return k;
}

function requireFrequency(frequency: string | undefined, code: string): Frequency {
  const f = (frequency ?? "MONTHLY") as Frequency;
  if (!STEP[f]) {
    throw new LedgerError(`Template ${code} must be MONTHLY, QUARTERLY or ANNUAL, not "${frequency}".`);
  }
  return f;
}

function requireDate(value: string, what: string, code: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new LedgerError(`The ${what} of template ${code} is not a date. Write it as 2026-01-31.`);
  }
  return d;
}

/** Save a standing instruction. Nothing is stored until its lines are known good. */
export async function createTemplate(opts: { orgId: string; entityId: string; template: NewTemplate }) {
  const t = opts.template;
  const code = (t.code ?? "").trim();
  const name = (t.name ?? "").trim();
  if (!code) throw new LedgerError("A recurring template needs a code, so a posting can be traced back to it.");
  if (!name) throw new LedgerError(`Template ${code} needs a name — the code alone tells a reader nothing.`);

  const frequency = requireFrequency(t.frequency, code);
  const kind = requireKind(t.kind, code);
  const autoReverse = resolveAutoReverse(kind, t.autoReverse, code);
  const startsOn = requireDate(t.startsOn, "start date", code);
  const endsOn = t.endsOn ? requireDate(t.endsOn, "end date", code) : null;
  if (endsOn && endsOn < startsOn) {
    throw new LedgerError(`Template ${code} ends on ${t.endsOn} but starts on ${t.startsOn}, so it would never run.`);
  }

  const lines = normaliseLines(t.lines, `template ${code}`);
  await checkLinesAgainstChart({ orgId: opts.orgId, entityId: opts.entityId, lines, where: `template ${code}` });

  const clash = await prisma.recurringJournal.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code },
  });
  if (clash) throw new LedgerError(`There is already a recurring template with the code ${code}.`);

  return prisma.recurringJournal.create({
    data: {
      orgId: opts.orgId,
      entityId: opts.entityId,
      code,
      name,
      frequency,
      startsOn,
      endsOn,
      kind,
      autoReverse,
      lines: JSON.stringify(lines),
      status: "active",
    },
  });
}

/**
 * Change a standing instruction.
 *
 * Editing is deliberately unrestricted even after the template has run: the
 * entries it already posted are independent journals and are not touched, so a
 * rent increase is an edit, not a new template. What the edit cannot do is
 * change history, which is exactly the property that makes editing safe.
 */
export async function updateTemplate(opts: {
  orgId: string;
  entityId: string;
  code: string;
  patch: Partial<Omit<NewTemplate, "code">> & { code?: string };
}) {
  const existing = await loadTemplate(opts.orgId, opts.entityId, opts.code);
  const p = opts.patch;
  const code = (p.code ?? existing.code).trim();
  if (!code) throw new LedgerError("A recurring template needs a code, so a posting can be traced back to it.");

  const name = (p.name ?? existing.name).trim();
  if (!name) throw new LedgerError(`Template ${code} needs a name — the code alone tells a reader nothing.`);

  const frequency = requireFrequency(p.frequency ?? existing.frequency, code);
  const kind = requireKind(p.kind ?? existing.kind, code);
  const autoReverse = resolveAutoReverse(
    kind,
    p.autoReverse ?? (p.kind && p.kind !== existing.kind ? undefined : existing.autoReverse),
    code,
  );
  const startsOn = p.startsOn ? requireDate(p.startsOn, "start date", code) : existing.startsOn;
  const endsOn =
    p.endsOn === undefined ? existing.endsOn : p.endsOn === null ? null : requireDate(p.endsOn, "end date", code);
  if (endsOn && endsOn < startsOn) {
    throw new LedgerError(
      `Template ${code} would end on ${endsOn.toISOString().slice(0, 10)} but start on ${startsOn
        .toISOString()
        .slice(0, 10)}, so it would never run.`,
    );
  }

  // Re-validate on every save, even when the lines were not the thing edited —
  // a template is only ever stored in a state that can actually post.
  const lines = p.lines ? normaliseLines(p.lines, `template ${code}`) : parseTemplateLines(existing);
  await checkLinesAgainstChart({ orgId: opts.orgId, entityId: opts.entityId, lines, where: `template ${code}` });

  if (code !== existing.code) {
    const clash = await prisma.recurringJournal.findFirst({
      where: { orgId: opts.orgId, entityId: opts.entityId, code },
    });
    if (clash) throw new LedgerError(`There is already a recurring template with the code ${code}.`);
  }

  return prisma.recurringJournal.update({
    where: { id: existing.id },
    data: { code, name, frequency, startsOn, endsOn, kind, autoReverse, lines: JSON.stringify(lines) },
  });
}

/** Stop a template posting, without losing what it is. */
export async function pauseTemplate(opts: { orgId: string; entityId: string; code: string }) {
  const t = await loadTemplate(opts.orgId, opts.entityId, opts.code);
  if (t.status === "ended") {
    throw new LedgerError(`Template ${t.code} has already been ended; there is nothing to pause.`);
  }
  return prisma.recurringJournal.update({ where: { id: t.id }, data: { status: "paused" } });
}

/** Put a paused template back into service. */
export async function resumeTemplate(opts: { orgId: string; entityId: string; code: string }) {
  const t = await loadTemplate(opts.orgId, opts.entityId, opts.code);
  if (t.status === "ended") {
    throw new LedgerError(
      `Template ${t.code} has been ended. Create a new template rather than restarting a closed one, so the break is visible.`,
    );
  }
  return prisma.recurringJournal.update({ where: { id: t.id }, data: { status: "active" } });
}

/**
 * Retire a template for good.
 *
 * The row stays — the journals it posted point at it by id, and a source a
 * reader cannot open is a dead end in an audit trail.
 */
export async function endTemplate(opts: { orgId: string; entityId: string; code: string; endsOn?: string }) {
  const t = await loadTemplate(opts.orgId, opts.entityId, opts.code);
  const endsOn = opts.endsOn ? requireDate(opts.endsOn, "end date", t.code) : t.endsOn;
  return prisma.recurringJournal.update({
    where: { id: t.id },
    data: { status: "ended", endsOn: endsOn ?? new Date() },
  });
}

async function loadTemplate(orgId: string, entityId: string, code: string): Promise<RecurringRow> {
  const t = (await prisma.recurringJournal.findFirst({
    where: { orgId, entityId, code },
  })) as unknown as RecurringRow | null;
  if (!t) throw new LedgerError(`There is no recurring template with the code ${code} for this entity.`);
  return t;
}

/* ------------------------------------------------------------------ due-ness */

/**
 * Why a template is, or is not, due for a period.
 *
 * Every "no" carries a sentence. A run that quietly posts nothing is
 * indistinguishable from a run that quietly posted the wrong thing.
 */
export function assessDue(t: RecurringRow, target: number): { due: boolean; reason?: string } {
  const step = STEP[t.frequency];
  if (!step) {
    return {
      due: false,
      reason: `its frequency is recorded as "${t.frequency}", which is not MONTHLY, QUARTERLY or ANNUAL. Edit the template and choose one.`,
    };
  }
  if (t.status === "paused") {
    return { due: false, reason: "it is paused. Resume it before it will post again." };
  }
  if (t.status === "ended") {
    return { due: false, reason: "it has been ended, so it no longer posts." };
  }
  if (t.status !== "active") {
    return { due: false, reason: `its status is "${t.status}", which is not active.` };
  }

  const start = monthOfDate(t.startsOn);
  if (target < start) {
    return { due: false, reason: `it does not start until ${monthLabel(start)}, after this period.` };
  }
  if (t.endsOn) {
    const end = monthOfDate(t.endsOn);
    if (target > end) {
      return { due: false, reason: `it ended after ${monthLabel(end)} and no longer posts.` };
    }
  }
  if ((target - start) % step !== 0) {
    const next = start + Math.ceil((target - start) / step) * step;
    return {
      due: false,
      reason: `it is ${t.frequency.toLowerCase()} from ${monthLabel(start)}, so ${monthLabel(
        target,
      )} is not one of its periods — the next one is ${monthLabel(next)}.`,
    };
  }

  if (t.lastRunPeriod) {
    const last = monthIndex(t.lastRunPeriod);
    if (last >= target) {
      return { due: false, reason: `it has already run for ${t.lastRunPeriod}.` };
    }
    // Do not silently catch up. A gap means a run was missed, and folding those
    // periods into this one hides it — and for an accrual it would leave the
    // intervening months carrying a cost that was never released.
    if (target - last > step) {
      const missing: string[] = [];
      for (let i = last + step; i < target; i += step) missing.push(monthLabel(i));
      return {
        due: false,
        reason: `it last ran for ${t.lastRunPeriod} — run the months in between (${missing.join(
          ", ",
        )}) first rather than folding them into this one.`,
      };
    }
  }

  return { due: true };
}

export interface DueTemplates {
  period: string;
  due: RecurringRow[];
  /** Every template that is not due, and why. */
  skipped: { code: string; reason: string }[];
}

/** Which templates are due for a "YYYY-MM" period, and why the rest are not. */
export async function dueTemplates(opts: {
  orgId: string;
  entityId: string;
  period: string;
}): Promise<DueTemplates> {
  const target = requirePeriod(opts.period);

  const templates = (await prisma.recurringJournal.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId },
    orderBy: { code: "asc" },
  })) as unknown as RecurringRow[];

  const due: RecurringRow[] = [];
  const skipped: { code: string; reason: string }[] = [];
  for (const t of templates) {
    const verdict = assessDue(t, target);
    if (verdict.due) due.push(t);
    else skipped.push({ code: t.code, reason: verdict.reason! });
  }
  return { period: opts.period, due, skipped };
}

/* ------------------------------------------------------------------- the run */

export interface PostedTemplate {
  code: string;
  name: string;
  kind: string;
  entryId: string;
  reference: string;
  amountMinor: string;
  /** The release of an accrual, posted on the first day of the next period. */
  reversalEntryId: string | null;
  reversalReference: string | null;
  reversesOn: string | null;
  /**
   * True when the journal was already on the books under this template and
   * period and the run simply found it again. Reported rather than hidden: a
   * replay is information, not a non-event.
   */
  alreadyPosted: boolean;
}

export interface RecurringRunResult {
  period: string;
  templatesPosted: number;
  totalMinor: string;
  posted: PostedTemplate[];
  /** Templates not posted, and why — silence here would hide a stalled schedule. */
  skipped: { code: string; reason: string }[];
}

/**
 * Run every template that is due for one period.
 *
 * Idempotent per template per period: the externalKey carries the template id
 * and the period, so a second run of the same month finds the same journal
 * rather than posting it twice.
 *
 * Each template posts its OWN journal, not one combined entry. Depreciation
 * combines because it is a single monthly measurement over one register; a
 * recurring template is an independent instruction, and its entry has to stand
 * alone after the template is edited, paused or retired. Combining them would
 * also mean one broken template could take a whole month's postings with it.
 */
export async function runRecurring(opts: {
  orgId: string;
  entityId: string;
  /** YYYY-MM. */
  period: string;
  actorId?: string;
  actorType?: "HUMAN" | "RULE" | "MODEL" | "AGENT" | "INTEGRATION";
}): Promise<RecurringRunResult> {
  const target = requirePeriod(opts.period);
  const { due, skipped } = await dueTemplates(opts);

  const posted: PostedTemplate[] = [];
  const entryDate = lastDayOf(target);
  const reversalDate = firstDayOf(target + 1);
  const nextPeriod = monthLabel(target + 1);

  for (const t of due) {
    // The lines are read back defensively: the column is a string, and a
    // template nobody can read must name itself rather than surface as a JSON
    // parse error the bookkeeper cannot act on.
    let lines: TemplateLine[];
    try {
      lines = parseTemplateLines(t);
      await checkLinesAgainstChart({
        orgId: opts.orgId,
        entityId: opts.entityId,
        lines,
        where: `template ${t.code}`,
      });
    } catch (e) {
      if (!(e instanceof LedgerError)) throw e;
      skipped.push({ code: t.code, reason: e.message });
      continue;
    }

    // An accrual is never posted without somewhere for its release to land.
    // Posting the cost and discovering afterwards that next month is closed
    // leaves a liability on the books that nobody will remember to clear.
    if (t.autoReverse) {
      const blocker = await reversalBlocker(opts.orgId, opts.entityId, reversalDate, nextPeriod);
      if (blocker) {
        skipped.push({ code: t.code, reason: blocker });
        continue;
      }
    }

    const externalKey = `recurring:${t.id}:${opts.period}`;
    const seen = await prisma.journalEntry.findFirst({
      where: { orgId: opts.orgId, externalKey },
      select: { id: true },
    });

    try {
      const entry = await post({
        orgId: opts.orgId,
        entityId: opts.entityId,
        entryDate,
        memo: `${t.code} ${t.name} — ${opts.period}`,
        source: "recurring",
        sourceType: "RECURRING_JOURNAL",
        sourceId: t.id,
        externalKey,
        actorType: opts.actorType ?? "RULE",
        actorId: opts.actorId,
        series: "RJ",
        lines: lines.map((l) => ({
          account: l.account,
          ...(l.debit !== undefined ? { debit: l.debit } : { credit: l.credit! }),
          memo: l.memo ?? `${t.code} ${opts.period}`,
        })),
      });

      let reversal: { id: string; series: string; number: string | number } | null = null;
      if (t.autoReverse) {
        /*
         * Why an explicit mirror entry rather than reverse() from post.ts.
         *
         * reverse() is the correction path: it exists to undo a mistake, so it
         * flips the original's status to "reversed" and takes no externalKey.
         * Neither fits here. A period-end accrual is not a mistake — it was the
         * right entry for its period, and marking it "reversed" would drop it
         * out of every query that reads posted entries, so the cost would
         * vanish from the month it belongs to. And with no externalKey there is
         * nothing stopping a second run posting the release twice.
         *
         * So the release is posted as its own journal, keyed on
         * `…:{period}:reversal`, which makes it idempotent exactly as the
         * accrual itself is. reversalOfId still records the link — post() takes
         * it at INSERT, so the relationship is part of what the entry is rather
         * than a later edit to an immutable record.
         */
        reversal = await post({
          orgId: opts.orgId,
          entityId: opts.entityId,
          entryDate: reversalDate,
          memo: `Release of ${t.code} ${t.name} accrued in ${opts.period}`,
          source: "recurring",
          sourceType: "RECURRING_REVERSAL",
          sourceId: t.id,
          externalKey: `${externalKey}:reversal`,
          reversalOfId: entry.id,
          actorType: opts.actorType ?? "RULE",
          actorId: opts.actorId,
          series: "RJ",
          // Debits become credits and credits become debits, line for line, so
          // the release is the exact mirror of what was accrued.
          lines: lines.map((l) => ({
            account: l.account,
            ...(l.debit !== undefined ? { credit: l.debit } : { debit: l.credit! }),
            memo: `Release of ${t.code} ${opts.period}`,
          })),
        });
      }

      // The template's own bookkeeping moves only once the journals are on the
      // books; the other order would leave a template marked run with nothing
      // posted. A replay does not advance the count — it found what was already
      // there, it did not run again.
      await prisma.recurringJournal.update({
        where: { id: t.id },
        data: { lastRunPeriod: opts.period, runCount: seen ? t.runCount : t.runCount + 1 },
      });

      posted.push({
        code: t.code,
        name: t.name,
        kind: t.kind,
        entryId: entry.id,
        reference: `${entry.series}-${entry.number}`,
        amountMinor: templateTotal(lines).toString(),
        reversalEntryId: reversal?.id ?? null,
        reversalReference: reversal ? `${reversal.series}-${reversal.number}` : null,
        reversesOn: reversal ? reversalDate : null,
        alreadyPosted: Boolean(seen),
      });
    } catch (e) {
      if (!(e instanceof LedgerError)) throw e;
      // One template's problem must not take the rest of the month's postings
      // with it. lastRunPeriod is deliberately not advanced, so re-running the
      // period once the problem is fixed completes the work — and the entry
      // that did post is found again by its externalKey rather than duplicated.
      skipped.push({
        code: t.code,
        reason: seen
          ? `its journal is already posted but the run could not finish: ${e.message}`
          : e.message,
      });
    }
  }

  return {
    period: opts.period,
    templatesPosted: posted.length,
    totalMinor: posted.reduce((a, p) => a + BigInt(p.amountMinor), 0n).toString(),
    posted,
    skipped,
  };
}

/** Why the release of an accrual could not be posted into the next period. */
async function reversalBlocker(
  orgId: string,
  entityId: string,
  reversalDate: string,
  nextPeriod: string,
): Promise<string | null> {
  const d = new Date(reversalDate);
  const period = await prisma.accountingPeriod.findFirst({
    where: { orgId, entityId, startsOn: { lte: d }, endsOn: { gte: d } },
    orderBy: [{ isAdjustment: "asc" }, { seq: "asc" }],
  });
  if (!period) {
    return `it reverses on ${reversalDate} and no accounting period covers that date. Open ${nextPeriod} first — an accrual must never be posted without its release.`;
  }
  if (period.status !== "open") {
    return `it reverses on ${reversalDate}, in period ${period.label}, which is ${period.status.replace(
      "_",
      " ",
    )}. Reopen it first — an accrual must never be posted without its release.`;
  }
  return null;
}

/* ---------------------------------------------------------------- the screen */

export interface TemplateStatusRow {
  id: string;
  code: string;
  name: string;
  kind: string;
  frequency: string;
  status: string;
  autoReverse: boolean;
  startsOn: string;
  endsOn: string | null;
  lastRunPeriod: string | null;
  runCount: number;
  /** The next period this template should post for, or null if it is finished. */
  nextDuePeriod: string | null;
  /** A period it should already have posted for has gone by. */
  behind: boolean;
  /** How many of its periods are unposted as at the reference month. */
  periodsDue: number;
  /** What it would post: null when its saved lines cannot be read. */
  lines: TemplateLine[] | null;
  amountMinor: string | null;
  /** Why this template cannot post as it stands. */
  problem: string | null;
  /** Whether it is due for the reference month, and if not, why not. */
  dueThisPeriod: boolean;
  reason: string | null;
}

/**
 * Every template, when it last ran, when it is next due and whether it is
 * behind — which is the one thing a recurring-journal screen has to answer. A
 * missed accrual is invisible in the ledger by construction, because the thing
 * that is wrong is an entry that is not there.
 */
export async function templateStatus(opts: {
  orgId: string;
  entityId: string;
  /** The month to judge "behind" against; defaults to the current one. */
  asOf?: string;
}): Promise<{ asOf: string; templates: TemplateStatusRow[]; behindCount: number }> {
  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 7);
  const asOfIndex = requirePeriod(asOf);

  const templates = (await prisma.recurringJournal.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId },
    orderBy: { code: "asc" },
  })) as unknown as RecurringRow[];

  const rows = templates.map((t): TemplateStatusRow => {
    const step = STEP[t.frequency] ?? 1;
    const start = monthOfDate(t.startsOn);
    const end = t.endsOn ? monthOfDate(t.endsOn) : null;

    let next: number | null = t.lastRunPeriod ? monthIndex(t.lastRunPeriod) + step : start;
    if (next < start) next = start;
    if (end !== null && next > end) next = null;
    const live = t.status === "active";

    const periodsDue = next !== null && live && next <= asOfIndex ? Math.floor((asOfIndex - next) / step) + 1 : 0;
    const behind = live && next !== null && next < asOfIndex;

    let lines: TemplateLine[] | null = null;
    let problem: string | null = null;
    try {
      lines = parseTemplateLines(t);
    } catch (e) {
      problem = e instanceof LedgerError ? e.message : "Its saved lines cannot be read.";
    }

    const verdict = assessDue(t, asOfIndex);

    return {
      id: t.id,
      code: t.code,
      name: t.name,
      kind: t.kind,
      frequency: t.frequency,
      status: t.status,
      autoReverse: t.autoReverse,
      startsOn: t.startsOn.toISOString().slice(0, 10),
      endsOn: t.endsOn ? t.endsOn.toISOString().slice(0, 10) : null,
      lastRunPeriod: t.lastRunPeriod,
      runCount: t.runCount,
      nextDuePeriod: next === null ? null : monthLabel(next),
      behind,
      periodsDue,
      lines,
      amountMinor: lines ? templateTotal(lines).toString() : null,
      problem,
      dueThisPeriod: verdict.due,
      reason: verdict.reason ?? null,
    };
  });

  return { asOf, templates: rows, behindCount: rows.filter((r) => r.behind).length };
}
