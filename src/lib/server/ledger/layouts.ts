import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/server/prisma";
import { fmtMinor } from "@/lib/ledger/format";
import { LedgerError } from "./post";
import {
  balances, classifyChart, profitAndLoss, removeYearEndClose, type BalanceSheetClass,
} from "./statements";

/**
 * Custom report layouts — a management pack defined as data rather than code.
 *
 * A business presents its numbers the way it reads them, and the two statements
 * in `statements.ts` are only the shapes the standard requires. This module
 * lets a user say "revenue is 4000 to 4499, cost of sales is 5000 to 5999,
 * gross margin is those two added up" and keep that shape, per entity, without
 * anybody editing a file.
 *
 * Three decisions carry it.
 *
 *  - Figures come from `balances()` in statements.ts, never from a query
 *    written here. That helper is what knows to read the period-anchored cache
 *    for whole periods and the journal lines for a period the range only half
 *    covers, and what knows that a reversed entry's own lines are real
 *    postings. A second query would eventually disagree with the statements
 *    about the same month, and a custom report that disagrees with the accounts
 *    is worse than no custom report.
 *
 *  - An `accounts` row picks its accounts by code range, by name, or by the
 *    classification the chart itself carries — see `LayoutGroup`. The last of
 *    those exists because a range over the codes and a question about what is
 *    current are different questions with different answers, and the range is
 *    the one that gets it wrong.
 *
 *  - A total is a plain sum of the rendered values of rows above it. There is
 *    no subtraction in the row language, because a deduction is expressed by
 *    `invert` — which is also how it should read on the page. Revenue is a
 *    credit balance, so it is inverted to present positively (the convention
 *    `section()` in statements.ts states); cost of sales is a debit balance, so
 *    inverting it presents it as the deduction it is, in parentheses. Getting
 *    this wrong is how a report shows income as a negative number, and the
 *    bottom-line check below is what catches it.
 *
 *  - `renderLayout` reports coverage. A layout that omits an account still adds
 *    up, still looks right, and quietly misstates profit — and the person who
 *    built it is the last person who will notice. So every render says which
 *    postable accounts carrying a balance no row picked up, which accounts two
 *    rows both picked up, and, for a profit layout, how far its own bottom line
 *    is from `profitAndLoss()` for the same dates. Nought is the only
 *    acceptable answer to the last one.
 *
 * Amounts are BigInt minor units throughout and cross the wire as strings.
 */

/* --------------------------------------------------------------- vocabulary */

export type LayoutBasis = "BALANCE" | "PROFIT";

/**
 * `accounts` sums a code range, an explicit list, or a classification the chart
 * itself carries; `total` sums rows named above it; `heading` is a label alone;
 * `spacer` is nothing.
 */
export type RowKind = "accounts" | "total" | "heading" | "spacer";

/**
 * The four groups a balance sheet is split into, as the chart's own hierarchy
 * defines them — `classifyChart` in statements.ts is the single place that
 * decides which accounts are in each.
 *
 * A row selecting on one of these is not a convenience over writing the range
 * out. It is a different question: `from 1100 to 1499` asks which accounts are
 * numbered in a band, and "current assets" asks which accounts somebody
 * classified as current. The two answers differ, and where they differ the band
 * is the one that is wrong — 1320 deferred tax asset is numbered inside that
 * band and hangs under non-current assets, and IAS 1.56 says it may never be
 * presented as current.
 */
export type LayoutGroup = BalanceSheetClass;

const GROUPS: LayoutGroup[] = [
  "CURRENT_ASSET", "NON_CURRENT_ASSET", "CURRENT_LIABILITY", "NON_CURRENT_LIABILITY",
];

export interface LayoutRow {
  /** Names the row so a `total` can refer to it. Optional — an unreferenced row needs none. */
  key?: string;
  label: string;
  kind: RowKind;
  /** Inclusive code range, compared with the numeric collation the chart is sorted by. */
  from?: string;
  to?: string;
  /** Named accounts instead of a range. */
  codes?: string[];
  /** Every account the chart classifies this way, instead of a range or a list. */
  group?: LayoutGroup;
  /** For a `total`: the keys of the rows it adds up. */
  of?: string[];
  /** Flip the sign for presentation: a credit balance reads positive, a cost reads as a deduction. */
  invert?: boolean;
  bold?: boolean;
}

export interface LayoutInput {
  code: string;
  name: string;
  basis: LayoutBasis;
  rows: LayoutRow[];
  status?: "active" | "archived";
}

export interface SavedLayout {
  id: string;
  entityId: string;
  code: string;
  name: string;
  basis: LayoutBasis;
  rows: LayoutRow[];
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface RenderedRow {
  key: string | null;
  label: string;
  kind: RowKind;
  /** Signed minor units as presented — after `invert`. Null on a row that renders no figure. */
  valueMinor: string | null;
  invert: boolean;
  bold: boolean;
  /** The chart codes this row picked up. Shows at a glance what a range actually caught. */
  codes: string[];
  /** For a `total`: the keys it added up. */
  of: string[];
}

export interface CoverageAccount {
  code: string;
  name: string;
  type: string;
  /** Signed, debit-positive, as the ledger holds it. */
  balanceMinor: string;
}

export interface Coverage {
  /** Postable accounts carrying a balance that this layout is answerable for. */
  considered: number;
  matched: number;
  /** Carrying a balance, and in no `accounts` row. The figures below are wrong by these. */
  unmatched: CoverageAccount[];
  unmatchedTotalMinor: string;
  /** Picked up by more than one row, so counted twice by whatever total holds them. */
  overlapping: CoverageAccount[];
}

export interface RenderedLayout {
  code: string;
  name: string;
  basis: LayoutBasis;
  from: string | null;
  to: string;
  currency: string;
  rows: RenderedRow[];
  /** The last row that renders a figure — what a reader takes as the answer. */
  bottomLineMinor: string | null;
  /** PROFIT only: the same period's net profit from `profitAndLoss()`. */
  netProfitMinor: string | null;
  /** PROFIT only: bottom line less net profit. Anything but zero is a defect in the layout. */
  bottomLineDifferenceMinor: string | null;
  coverage: Coverage;
  warnings: string[];
}

export interface DuplicateResult {
  layout: SavedLayout;
  fromEntityId: string;
  toEntityId: string;
  /** Rows whose range or codes match nothing in the target chart — copied, but blank. */
  emptyRows: string[];
}

/* ------------------------------------------------------------------ helpers */

const KINDS: RowKind[] = ["accounts", "total", "heading", "spacer"];
/** A row the reader sees words on, so a row that needs words. */
const LABELLED: RowKind[] = ["accounts", "total", "heading"];
/** A row that produces a figure, so a row a `total` can add up. */
const NUMERIC: RowKind[] = ["accounts", "total"];

/** The chart's own ordering: "4100" sorts after "999", not before it. */
const cmpCode = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
const inRange = (code: string, from: string, to: string) =>
  cmpCode(code, from) >= 0 && cmpCode(code, to) <= 0;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const listing = (xs: string[], limit = 4) =>
  `${xs.slice(0, limit).join(", ")}${xs.length > limit ? `, and ${xs.length - limit} more` : ""}`;

/** Names the offending row the way the person editing it sees the row. */
function rowRef(row: { label?: unknown; key?: unknown }, i: number): string {
  const label = str(row?.label);
  const key = str(row?.key);
  if (label) return `Row ${i + 1} "${label}"`;
  if (key) return `Row ${i + 1} [${key}]`;
  return `Row ${i + 1}`;
}

const ISO = (d: Date) => d.toISOString().slice(0, 10);

function asDate(value: string, what: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new LedgerError(`${what} is not a valid date.`);
  return d;
}

/* --------------------------------------------------------------- validation */

/**
 * Every refusal here is a report that would have been quietly wrong.
 *
 * A forward reference is refused rather than resolved because a total that
 * depends on a row below it depends on the order the renderer happens to walk
 * in; the same layout would then read differently under a renderer written next
 * year. `chart` is the entity's account codes — pass null to check the shape of
 * a layout without a chart to check it against.
 */
export function validateRows(input: unknown, chart: Set<string> | null): LayoutRow[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new LedgerError("A layout needs at least one row. One with none renders an empty page and reads as a fault.");
  }

  const raw = input as Record<string, unknown>[];
  const rows: LayoutRow[] = [];
  const indexOfKey = new Map<string, number>();

  raw.forEach((r, i) => {
    const where = rowRef(r ?? {}, i);
    const kind = str(r?.kind) as RowKind;
    if (!KINDS.includes(kind)) {
      throw new LedgerError(
        `${where} has kind "${str(r?.kind) || "(none)"}", which is not one of accounts, total, heading or spacer.`,
      );
    }

    const label = str(r?.label);
    if (!label && LABELLED.includes(kind)) {
      throw new LedgerError(
        `${where} is a ${kind} row with no label. It draws a line on the page, and a line with no words on it ` +
          `is a line nobody can read.`,
      );
    }

    const key = str(r?.key);
    if (key) {
      const prior = indexOfKey.get(key);
      if (prior !== undefined) {
        throw new LedgerError(
          `${where} repeats the key "${key}", which row ${prior + 1} already uses. A key names one row, so a ` +
            `total naming a repeated key cannot say which row it meant.`,
        );
      }
      indexOfKey.set(key, i);
    }

    const row: LayoutRow = { label, kind };
    if (key) row.key = key;
    if (r?.invert === true) row.invert = true;
    if (r?.bold === true) row.bold = true;

    if (kind === "accounts") {
      const from = str(r?.from);
      const to = str(r?.to);
      const codes = Array.isArray(r?.codes)
        ? (r.codes as unknown[]).map((c) => str(c)).filter(Boolean)
        : [];
      const group = str(r?.group).toUpperCase();
      const hasRange = Boolean(from || to);

      if (group && !GROUPS.includes(group as LayoutGroup)) {
        throw new LedgerError(
          `${where} selects the group "${str(r?.group)}", which is not one of ${GROUPS.join(", ")}.`,
        );
      }
      if (!hasRange && !codes.length && !group) {
        throw new LedgerError(
          `${where} sums accounts but names no code range, list of codes or group, so there is nothing for ` +
            `it to add up.`,
        );
      }
      if ([hasRange, codes.length > 0, Boolean(group)].filter(Boolean).length > 1) {
        throw new LedgerError(
          `${where} selects accounts more than one way. Give a range, a list of codes or a group — one of them, ` +
            `so the row means one thing.`,
        );
      }
      if (hasRange && (!from || !to)) {
        throw new LedgerError(
          `${where} gives only ${from ? "the start" : "the end"} of its range. A range needs both ends.`,
        );
      }
      if (hasRange && cmpCode(from, to) > 0) {
        throw new LedgerError(`${where} runs from ${from} down to ${to}, which is backwards.`);
      }
      if (codes.length && chart) {
        for (const c of codes) {
          if (!chart.has(c)) {
            throw new LedgerError(`${where} names account ${c}, which is not in this entity's chart.`);
          }
        }
      }
      if (hasRange) {
        row.from = from;
        row.to = to;
      } else if (group) {
        row.group = group as LayoutGroup;
      } else {
        row.codes = codes;
      }
    }

    if (kind === "total") {
      const of = Array.isArray(r?.of) ? (r.of as unknown[]).map((k) => str(k)).filter(Boolean) : [];
      if (!of.length) {
        throw new LedgerError(`${where} is a total of nothing. Name the rows it adds up.`);
      }
      row.of = of;
    }

    rows.push(row);
  });

  // Totals in a second pass: a reference can only be judged once every key is
  // known, and the message for a forward reference has to name where the row
  // it points at actually is.
  const totalRefs = new Map<string, string[]>();
  rows.forEach((row) => {
    if (row.kind === "total" && row.key) totalRefs.set(row.key, row.of ?? []);
  });

  rows.forEach((row, i) => {
    if (row.kind !== "total") return;
    const where = rowRef(row, i);

    for (const ref of row.of ?? []) {
      const at = indexOfKey.get(ref);
      if (at === undefined) {
        throw new LedgerError(`${where} adds up "${ref}", but no row has that key.`);
      }
      if (!NUMERIC.includes(rows[at].kind)) {
        throw new LedgerError(
          `${where} adds up "${ref}", which is a ${rows[at].kind} row and renders no figure.`,
        );
      }
    }

    if (row.key) {
      if ((row.of ?? []).includes(row.key)) {
        throw new LedgerError(`${where} adds up itself, which is a figure that has no value.`);
      }
      for (const ref of row.of ?? []) {
        const chain = chase(ref, row.key, totalRefs, new Set());
        if (chain) {
          throw new LedgerError(
            `${where} adds up itself through ${[row.key, ...chain].join(" → ")}. A circular total has no value ` +
              `to compute.`,
          );
        }
      }
    }

    for (const ref of row.of ?? []) {
      const at = indexOfKey.get(ref)!;
      if (at >= i) {
        throw new LedgerError(
          `${where} adds up "${ref}", which is defined later at row ${at + 1}. A report that depends on a figure ` +
            `below it depends on the order it happens to be evaluated in.`,
        );
      }
    }
  });

  return rows;
}

/** The path from `key` back to `target` through totals, or null if there is none. */
function chase(key: string, target: string, totals: Map<string, string[]>, seen: Set<string>): string[] | null {
  if (key === target) return [key];
  if (seen.has(key)) return null;
  seen.add(key);
  for (const ref of totals.get(key) ?? []) {
    const rest = chase(ref, target, totals, seen);
    if (rest) return [key, ...rest];
  }
  return null;
}

/* ------------------------------------------------------------------ storage */

type ChartAccount = {
  code: string; name: string; type: string; isPostable: boolean;
  /** Null on equity, income and expenses, and on an asset or liability the chart cannot place. */
  classification: BalanceSheetClass | null;
};

/**
 * The entity's chart, in the order a statement lists it, with each account's
 * current/non-current classification worked out once.
 *
 * The parent and the subtype are read only to compute that — the hierarchy is
 * what a `group` row selects on, and it cannot be recovered from the codes.
 */
async function chartOf(orgId: string, entityId: string): Promise<ChartAccount[]> {
  const accounts = await prisma.account.findMany({
    where: { orgId, entityId },
    select: { id: true, code: true, name: true, type: true, subtype: true, parentId: true, isPostable: true },
  });
  const classOf = classifyChart(accounts);
  return accounts
    .map((a) => ({
      code: a.code, name: a.name, type: a.type, isPostable: a.isPostable,
      classification: classOf.get(a.code) ?? null,
    }))
    .sort((a, b) => cmpCode(a.code, b.code));
}

function toSaved(row: {
  id: string; entityId: string; code: string; name: string; basis: string;
  rows: unknown; status: string; createdAt: Date; updatedAt: Date;
}): SavedLayout {
  return {
    id: row.id,
    entityId: row.entityId,
    code: row.code,
    name: row.name,
    basis: row.basis as LayoutBasis,
    // Stored as JSON, so it is re-checked on the way out: nothing guarantees a
    // row written by an older version of this file still means what it did.
    rows: validateRows(row.rows, null),
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const CODE = /^[A-Z0-9][A-Z0-9_-]{0,31}$/;

/**
 * Write a layout, whole. The validation is the point: a layout is saved once
 * and read for years, so the moment to refuse a forward reference or an account
 * that does not exist is the moment someone is looking at the row that has it.
 */
export async function saveLayout(opts: {
  orgId: string;
  entityId: string;
  code: string;
  name: string;
  basis: LayoutBasis;
  rows: unknown;
  status?: "active" | "archived";
}): Promise<SavedLayout> {
  // Codes are the identity a layout is copied between entities under, so they
  // are held in one case rather than allowing MGMT_PL and mgmt_pl to be two.
  const code = str(opts.code).toUpperCase();
  if (!CODE.test(code)) {
    throw new LedgerError(
      `"${opts.code}" is not a layout code. Use letters, digits, hyphens and underscores, such as MGMT_PL.`,
    );
  }
  const name = str(opts.name);
  if (!name) throw new LedgerError("A layout needs a name — it is what the list of layouts shows.");
  if (opts.basis !== "BALANCE" && opts.basis !== "PROFIT") {
    throw new LedgerError(`A layout is drawn either on a PROFIT basis or a BALANCE one, not "${opts.basis}".`);
  }
  const status = opts.status ?? "active";
  if (status !== "active" && status !== "archived") {
    throw new LedgerError(`A layout is either active or archived, not "${status}".`);
  }

  const chart = await chartOf(opts.orgId, opts.entityId);
  const rows = validateRows(opts.rows, new Set(chart.map((a) => a.code)));

  const saved = await prisma.reportLayout.upsert({
    where: { orgId_entityId_code: { orgId: opts.orgId, entityId: opts.entityId, code } },
    create: {
      orgId: opts.orgId, entityId: opts.entityId, code, name,
      basis: opts.basis, rows: rows as unknown as Prisma.InputJsonValue, status,
    },
    update: { name, basis: opts.basis, rows: rows as unknown as Prisma.InputJsonValue, status },
  });
  return toSaved(saved);
}

export async function listLayouts(opts: {
  orgId: string;
  entityId: string;
  includeArchived?: boolean;
}): Promise<SavedLayout[]> {
  const rows = await prisma.reportLayout.findMany({
    where: {
      orgId: opts.orgId,
      entityId: opts.entityId,
      ...(opts.includeArchived ? {} : { status: "active" }),
    },
    orderBy: [{ basis: "asc" }, { code: "asc" }],
  });
  return rows.map(toSaved);
}

export async function getLayout(opts: { orgId: string; entityId: string; code: string }): Promise<SavedLayout> {
  const code = str(opts.code).toUpperCase();
  const row = await prisma.reportLayout.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code },
  });
  if (!row) throw new LedgerError(`There is no report layout "${code}" for this entity.`);
  return toSaved(row);
}

/** Archive a layout rather than deleting it: a report someone has printed should stay explicable. */
export async function setLayoutStatus(opts: {
  orgId: string;
  entityId: string;
  code: string;
  status: "active" | "archived";
}): Promise<SavedLayout> {
  const layout = await getLayout(opts);
  const row = await prisma.reportLayout.update({
    where: { id: layout.id },
    data: { status: opts.status },
  });
  return toSaved(row);
}

/* ----------------------------------------------------------------- rendering */

/**
 * Render a layout over a date range, and say what it does not cover.
 *
 * Pass `code` for a saved layout or `layout` for one still being edited — the
 * editor previews from the same code path the saved report uses, so what is on
 * screen while the rows are being written is what will be filed.
 */
export async function renderLayout(opts: {
  orgId: string;
  entityId: string;
  code?: string;
  layout?: LayoutInput;
  /** Required on a PROFIT layout; meaningless on a BALANCE one, which reads to a date. */
  from?: string;
  to: string;
}): Promise<RenderedLayout> {
  const chart = await chartOf(opts.orgId, opts.entityId);
  const chartCodes = new Set(chart.map((a) => a.code));

  let def: { code: string; name: string; basis: LayoutBasis; rows: LayoutRow[] };
  if (opts.layout) {
    const basis = opts.layout.basis;
    if (basis !== "BALANCE" && basis !== "PROFIT") {
      throw new LedgerError(`A layout is drawn either on a PROFIT basis or a BALANCE one, not "${basis}".`);
    }
    def = {
      code: str(opts.layout.code).toUpperCase() || "DRAFT",
      name: str(opts.layout.name) || "Draft layout",
      basis,
      rows: validateRows(opts.layout.rows, chartCodes),
    };
  } else if (opts.code) {
    const saved = await getLayout({ orgId: opts.orgId, entityId: opts.entityId, code: opts.code });
    def = { code: saved.code, name: saved.name, basis: saved.basis, rows: saved.rows };
  } else {
    throw new LedgerError("Name a saved layout to render, or pass the rows of one being edited.");
  }

  const to = asDate(opts.to, "The date this report is drawn to");
  let from: Date | null = null;
  if (def.basis === "PROFIT") {
    if (!opts.from) {
      throw new LedgerError(
        `Layout "${def.code}" is drawn on a profit basis, which covers a period rather than a moment. ` +
          `Give the date it runs from.`,
      );
    }
    from = asDate(opts.from, "The date this report runs from");
    if (to < from) throw new LedgerError("The period ends before it starts.");
  }

  const { rows: bal, currency } = await balances({
    orgId: opts.orgId,
    entityId: opts.entityId,
    to,
    ...(from ? { from } : {}),
  });

  // A profit layout must not see the year-end close. Closing a year debits
  // income and credits expenses to nothing, so a layout drawn over a range
  // covering a close would read every line as nil — and, because a custom
  // layout is checked against `profitAndLoss()` below, the coverage difference
  // would report zero and the whole report would look correct and be empty.
  // The balance sheet keeps it, where it is exactly right.
  if (def.basis === "PROFIT" && from) {
    await removeYearEndClose({ orgId: opts.orgId, entityId: opts.entityId, from, to, rows: bal });
  }

  const balanceOf = new Map(bal.map((b) => [b.code, b.balance]));

  const rendered: RenderedRow[] = [];
  const valueOf = new Map<string, bigint>();
  const timesMatched = new Map<string, number>();

  for (const row of def.rows) {
    if (row.kind === "heading" || row.kind === "spacer") {
      rendered.push({
        key: row.key ?? null, label: row.label, kind: row.kind,
        valueMinor: null, invert: false, bold: row.bold === true, codes: [], of: [],
      });
      continue;
    }

    let raw = 0n;
    let codes: string[] = [];

    if (row.kind === "accounts") {
      codes = (row.codes?.length
        ? chart.filter((a) => row.codes!.includes(a.code))
        : row.group
          ? chart.filter((a) => a.classification === row.group)
          : chart.filter((a) => inRange(a.code, row.from!, row.to!))
      ).map((a) => a.code);
      for (const code of codes) {
        raw += balanceOf.get(code) ?? 0n;
        timesMatched.set(code, (timesMatched.get(code) ?? 0) + 1);
      }
    } else {
      // Every key here is defined above this row — validateRows refuses a
      // forward reference — so the value is always already computed.
      for (const ref of row.of ?? []) raw += valueOf.get(ref) ?? 0n;
    }

    const value = row.invert ? -raw : raw;
    if (row.key) valueOf.set(row.key, value);
    rendered.push({
      key: row.key ?? null, label: row.label, kind: row.kind,
      valueMinor: value.toString(),
      invert: row.invert === true, bold: row.bold === true,
      codes, of: row.of ?? [],
    });
  }

  const withFigures = rendered.filter((r) => r.valueMinor !== null);
  const bottomLine = withFigures.length ? BigInt(withFigures[withFigures.length - 1].valueMinor!) : null;

  // What the layout is answerable for. A profit layout is not expected to say
  // anything about the bank account, so only income and expenses are in scope
  // for it; a balance layout is answerable for the whole chart, income and
  // expenses included, because the profit for the year has to reach it or the
  // sheet does not balance.
  const scope = chart.filter(
    (a) =>
      a.isPostable &&
      (balanceOf.get(a.code) ?? 0n) !== 0n &&
      (def.basis === "PROFIT" ? a.type === "INCOME" || a.type === "EXPENSE" : true),
  );
  const gap = (a: ChartAccount): CoverageAccount => ({
    code: a.code, name: a.name, type: a.type,
    balanceMinor: (balanceOf.get(a.code) ?? 0n).toString(),
  });
  const unmatched = scope.filter((a) => !(timesMatched.get(a.code) ?? 0)).map(gap);
  const overlapping = scope.filter((a) => (timesMatched.get(a.code) ?? 0) > 1).map(gap);
  const unmatchedTotal = unmatched.reduce((a, u) => a + BigInt(u.balanceMinor), 0n);

  let netProfit: bigint | null = null;
  let difference: bigint | null = null;
  if (def.basis === "PROFIT" && from) {
    const pl = await profitAndLoss({
      orgId: opts.orgId, entityId: opts.entityId, from: ISO(from), to: ISO(to),
    });
    netProfit = BigInt(pl.netProfitMinor);
    if (bottomLine !== null) difference = bottomLine - netProfit;
  }

  const warnings: string[] = [];
  if (unmatched.length) {
    warnings.push(
      `${unmatched.length} postable account${unmatched.length === 1 ? "" : "s"} carrying a balance ` +
        `${unmatched.length === 1 ? "is" : "are"} in no row of this layout ` +
        `(${listing(unmatched.map((u) => `${u.code} ${u.name}`))}), together ` +
        `${fmtMinor(unmatchedTotal, currency, { sign: "minus" })}. A report that omits an account still adds ` +
        `up, so nothing else on this page will show it.`,
    );
  }
  if (overlapping.length) {
    warnings.push(
      `${overlapping.length} account${overlapping.length === 1 ? " is" : "s are"} picked up by more than one row ` +
        `(${listing(overlapping.map((o) => `${o.code} ${o.name}`))}), so every total holding both rows counts ` +
        `${overlapping.length === 1 ? "it" : "them"} twice.`,
    );
  }
  if (difference !== null && difference !== 0n) {
    warnings.push(
      `This layout's bottom line is ${fmtMinor(difference, currency, { sign: "minus" })} away from the profit and ` +
        `loss for the same dates (${fmtMinor(netProfit, currency, { sign: "minus" })}). Either a row is missing, ` +
        `a row is counted twice, or a deduction is not inverted.`,
    );
  }
  if (bottomLine === null) {
    warnings.push("This layout renders no figure at all — every row is a heading or a spacer.");
  }

  return {
    code: def.code,
    name: def.name,
    basis: def.basis,
    from: from ? ISO(from) : null,
    to: ISO(to),
    currency,
    rows: rendered,
    bottomLineMinor: bottomLine === null ? null : bottomLine.toString(),
    netProfitMinor: netProfit === null ? null : netProfit.toString(),
    bottomLineDifferenceMinor: difference === null ? null : difference.toString(),
    coverage: {
      considered: scope.length,
      matched: scope.length - unmatched.length,
      unmatched,
      unmatchedTotalMinor: unmatchedTotal.toString(),
      overlapping,
    },
    warnings,
  };
}

/* --------------------------------------------------------------- duplicating */

/**
 * Copy a layout to another entity in the same organisation.
 *
 * The reason this is not an insert is the chart. Two entities in a group rarely
 * have identical charts, and a row naming an account the target does not have
 * would render as a silent zero — a management pack that looks complete and
 * omits a line. Named codes are therefore refused outright; a range that
 * catches nothing is reported, because a range is a statement about where
 * things live rather than about a particular account.
 */
export async function duplicateLayout(opts: {
  orgId: string;
  from: { entityId: string; code: string };
  toEntityId: string;
  /** Defaults to the source code. */
  code?: string;
  name?: string;
  overwrite?: boolean;
}): Promise<DuplicateResult> {
  const source = await getLayout({ orgId: opts.orgId, entityId: opts.from.entityId, code: opts.from.code });
  const targetCode = (str(opts.code) || source.code).toUpperCase();

  if (opts.from.entityId === opts.toEntityId && targetCode === source.code) {
    throw new LedgerError(
      `Layout "${source.code}" cannot be copied onto itself. Copy it to another entity, or give the copy ` +
        `another code.`,
    );
  }

  const targetChart = await chartOf(opts.orgId, opts.toEntityId);
  if (!targetChart.length) {
    throw new LedgerError(
      `Entity ${opts.toEntityId} has no chart of accounts, so there is nothing for a layout to point at.`,
    );
  }
  const targetCodes = new Set(targetChart.map((a) => a.code));
  // Throws naming the row and the account, which is the whole value of copying
  // through this function rather than through an insert.
  const rows = validateRows(source.rows, targetCodes);

  const existing = await prisma.reportLayout.findFirst({
    where: { orgId: opts.orgId, entityId: opts.toEntityId, code: targetCode },
  });
  if (existing && !opts.overwrite) {
    throw new LedgerError(
      `Entity ${opts.toEntityId} already has a layout "${targetCode}" (${existing.name}). Copying would ` +
        `overwrite work someone has done — say so deliberately to replace it.`,
    );
  }

  const emptyRows = rows
    .filter((row) => {
      if (row.kind !== "accounts") return false;
      const hit = row.codes?.length
        ? targetChart.some((a) => row.codes!.includes(a.code))
        : row.group
          ? targetChart.some((a) => a.classification === row.group)
          : targetChart.some((a) => inRange(a.code, row.from!, row.to!));
      return !hit;
    })
    .map((row) => row.label);

  const layout = await saveLayout({
    orgId: opts.orgId,
    entityId: opts.toEntityId,
    code: targetCode,
    name: str(opts.name) || source.name,
    basis: source.basis,
    rows,
    status: "active",
  });

  return { layout, fromEntityId: opts.from.entityId, toEntityId: opts.toEntityId, emptyRows };
}

/* -------------------------------------------------------------------- seeds */

/**
 * Two layouts to adapt rather than a blank page.
 *
 * Both cover the standard chart completely, so a user who changes one row can
 * see the coverage report react — which is the fastest way to learn what it is
 * telling them. Both are written in ranges rather than named codes so they
 * survive being copied to an entity whose chart has extra accounts in it.
 */
export const STARTER_LAYOUTS: LayoutInput[] = [
  {
    code: "MGMT_PL",
    name: "Management profit and loss",
    basis: "PROFIT",
    rows: [
      { kind: "heading", label: "Trading" },
      { key: "revenue", kind: "accounts", label: "Revenue", from: "4000", to: "4499", invert: true },
      { key: "cost_of_sales", kind: "accounts", label: "Cost of sales", from: "5000", to: "5999", invert: true },
      { key: "gross_margin", kind: "total", label: "Gross margin", of: ["revenue", "cost_of_sales"], bold: true },
      { kind: "spacer", label: "" },
      { kind: "heading", label: "Overheads" },
      { key: "people", kind: "accounts", label: "People", from: "6000", to: "6099", invert: true },
      { key: "premises", kind: "accounts", label: "Premises and utilities", from: "6100", to: "6199", invert: true },
      { key: "selling", kind: "accounts", label: "Selling and marketing", from: "6200", to: "6249", invert: true },
      { key: "admin", kind: "accounts", label: "Administration", from: "6250", to: "6899", invert: true },
      { key: "other_opex", kind: "accounts", label: "Other operating costs", from: "6900", to: "6999", invert: true },
      {
        key: "operating_profit", kind: "total", label: "Operating profit", bold: true,
        of: ["gross_margin", "people", "premises", "selling", "admin", "other_opex"],
      },
      { kind: "spacer", label: "" },
      { key: "other_income", kind: "accounts", label: "Other income", from: "4500", to: "4999", invert: true },
      { key: "tax", kind: "accounts", label: "Tax", from: "7000", to: "7999", invert: true },
      {
        key: "net_result", kind: "total", label: "Result for the period", bold: true,
        of: ["operating_profit", "other_income", "tax"],
      },
    ],
  },
  {
    code: "BS_SUMMARY",
    name: "Summarised balance sheet",
    basis: "BALANCE",
    rows: [
      // Split the way IAS 1.60 asks, and on the chart's own classification
      // rather than on the code bands this layout used to read. The bands were
      // close enough to look right and wrong where it counted: 1320 deferred
      // tax asset and 2320 deferred tax liability are numbered inside the
      // current bands and hang under the non-current headings, so a summarised
      // sheet drawn on the numbers reported both as current — which IAS 1.56
      // forbids outright.
      { kind: "heading", label: "Assets" },
      { key: "current_assets", kind: "accounts", label: "Current assets", group: "CURRENT_ASSET" },
      { key: "non_current_assets", kind: "accounts", label: "Non-current assets", group: "NON_CURRENT_ASSET" },
      {
        key: "total_assets", kind: "total", label: "Total assets",
        of: ["current_assets", "non_current_assets"], bold: true,
      },
      { kind: "spacer", label: "" },
      { kind: "heading", label: "Liabilities" },
      { key: "current_liabilities", kind: "accounts", label: "Current liabilities", group: "CURRENT_LIABILITY", invert: true },
      { key: "non_current_liabilities", kind: "accounts", label: "Non-current liabilities", group: "NON_CURRENT_LIABILITY", invert: true },
      {
        key: "total_liabilities", kind: "total", label: "Total liabilities",
        of: ["current_liabilities", "non_current_liabilities"], bold: true,
      },
      { kind: "spacer", label: "" },
      { kind: "heading", label: "Equity" },
      { key: "capital", kind: "accounts", label: "Capital and reserves", from: "3000", to: "3999", invert: true },
      // Profit not yet closed to equity is not a posted balance anywhere; it is
      // the income and expense accounts themselves, which is why a summarised
      // sheet that leaves this row out never balances.
      { key: "result", kind: "accounts", label: "Result for the year", from: "4000", to: "7999", invert: true },
      { key: "total_equity", kind: "total", label: "Total equity", of: ["capital", "result"], bold: true },
      {
        key: "total_le", kind: "total", label: "Total liabilities and equity",
        of: ["total_liabilities", "total_equity"], bold: true,
      },
    ],
  },
];

export async function seedStarterLayouts(opts: {
  orgId: string;
  entityId: string;
  /** Replace a layout that already carries one of these codes. */
  overwrite?: boolean;
}): Promise<{ created: string[]; skipped: string[] }> {
  const existing = await prisma.reportLayout.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: { in: STARTER_LAYOUTS.map((l) => l.code) } },
    select: { code: true },
  });
  const held = new Set(existing.map((e) => e.code));

  const created: string[] = [];
  const skipped: string[] = [];
  for (const starter of STARTER_LAYOUTS) {
    if (held.has(starter.code) && !opts.overwrite) {
      skipped.push(starter.code);
      continue;
    }
    await saveLayout({ orgId: opts.orgId, entityId: opts.entityId, ...starter });
    created.push(starter.code);
  }
  return { created, skipped };
}
