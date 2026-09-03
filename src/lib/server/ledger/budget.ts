import { prisma } from "@/lib/server/prisma";
import { LedgerError } from "./post";
import { profitAndLoss } from "./statements";

/**
 * Budgets, and the variance report that is the only reason to keep one.
 *
 * Three decisions carry this module.
 *
 *  - A budget is not a journal entry. Nothing here posts, and nothing here can
 *    move a balance. A plan that could touch the ledger would be a plan the
 *    books could be made to agree with.
 *
 *  - Actuals come from profitAndLoss(), not from a second read of the ledger.
 *    Budget-versus-actual and the profit and loss for the same dates are then
 *    the same figure by construction. Derived twice they would eventually
 *    disagree, and a variance report that disagrees with the accounts is one
 *    nobody trusts again. The rule about periods the range only half covers
 *    comes along with that read rather than being written out a second time
 *    here, which is the only way the two can be relied on to match.
 *
 *  - Every line states whether its variance is favourable, as a flag. Revenue
 *    above budget is good news, expense above budget is bad news, and both have
 *    the same sign. A reader left to work that out row by row is a reader who
 *    will eventually work it out wrong.
 *
 * Amounts are BigInt minor units and rates are basis points computed in BigInt.
 * A rate against a zero budget is null rather than infinity or a soothing zero:
 * "no budget" is not the same fact as "no variance".
 */

/* --------------------------------------------------------------- vocabulary */

/** Which side of a variance is the good side. Stated, never inferred. */
export type Direction = "above" | "below";

export interface VarianceLine {
  code: string;
  name: string;
  nameAr: string | null;
  /** Planned, on the account's natural side. */
  budgetMinor: string;
  /** Actual, on the account's natural side — exactly as the statements show it. */
  actualMinor: string;
  /** Actual less budget, still on the natural side. */
  varianceMinor: string;
  /** Variance over the budget, in basis points. Null when there is no budget to be over. */
  varianceBps: number | null;
  /** Good news or bad news. Do not infer this from the sign. */
  favourable: boolean;
  /** Activity against an account nobody budgeted for. Worth a look on its own. */
  unbudgeted: boolean;
}

export interface VarianceSection {
  key: "income" | "expenses";
  label: string;
  /** Which direction is favourable for everything in this section. */
  favourableWhen: Direction;
  lines: VarianceLine[];
  budgetMinor: string;
  actualMinor: string;
  varianceMinor: string;
  varianceBps: number | null;
  favourable: boolean;
}

export interface BudgetVsActual {
  scenario: string;
  from: string;
  to: string;
  currency: string;
  /** The budget months these figures cover. */
  periods: string[];
  /** Months the range only partly covers; their budget is still included in full. */
  partialPeriods: string[];
  income: VarianceSection;
  expenses: VarianceSection;
  netBudgetMinor: string;
  netActualMinor: string;
  netVarianceMinor: string;
  netVarianceBps: number | null;
  netFavourable: boolean;
  unbudgetedCount: number;
  warnings: string[];
}

export interface BudgetLineInput {
  /** The month this money is planned for, YYYY-MM. */
  period: string;
  accountCode: string;
  /**
   * Minor units on the account's natural side: revenue budgeted as a positive
   * figure, expenses likewise. That is how the variance report presents the
   * actuals, so the two are directly comparable without a sign convention the
   * caller has to remember.
   */
  amountMinor: bigint | number | string;
  note?: string;
}

export interface SetBudgetResult {
  scenario: string;
  fiscalYear: string;
  written: number;
  periods: string[];
  totalMinor: string;
}

export interface CopyScenarioResult {
  from: string;
  to: string;
  fromFiscalYear: string;
  toFiscalYear: string;
  upliftBps: number;
  copied: number;
  replaced: number;
  totalMinor: string;
}

export interface BudgetSummaryBlock {
  key: "income" | "expenses" | "net";
  label: string;
  favourableWhen: Direction;
  /** The whole year's plan. */
  budgetFullYearMinor: string;
  /** The part of that plan covered by the elapsed months. */
  budgetToDateMinor: string;
  /** Fact: posted to the ledger, from the start of the year to the as-at date. */
  actualToDateMinor: string;
  varianceToDateMinor: string;
  varianceToDateBps: number | null;
  favourableToDate: boolean;
  /** Arithmetic, not fact: the actual to date scaled to the length of the year. */
  projectedFullYearMinor: string;
  projectedVarianceMinor: string;
  projectedFavourable: boolean;
}

export interface BudgetSummary {
  scenario: string;
  fiscalYear: string;
  asOf: string;
  currency: string;
  yearStartsOn: string;
  yearEndsOn: string;
  elapsedDays: number;
  totalDays: number;
  income: BudgetSummaryBlock;
  expenses: BudgetSummaryBlock;
  net: BudgetSummaryBlock;
  /** Says in words what the projected figures are and are not. */
  projectionBasis: string;
  warnings: string[];
}

/* ------------------------------------------------------------------ helpers */

const PERIOD = /^(\d{4})-(0[1-9]|1[0-2])$/;
const DAY_MS = 86_400_000;
const ISO = (d: Date) => d.toISOString().slice(0, 10);

const monthStart = (period: string) => {
  const m = PERIOD.exec(period)!;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
};
const monthEnd = (period: string) => {
  const m = PERIOD.exec(period)!;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]), 0));
};
const monthOf = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;

/** Every month the range touches, in order. */
function monthsIn(from: Date, to: Date): string[] {
  const out: string[] = [];
  const cur = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
  const last = new Date(Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), 1));
  while (cur <= last) {
    out.push(monthOf(cur));
    cur.setUTCMonth(cur.getUTCMonth() + 1);
  }
  return out;
}

const shiftYears = (period: string, delta: number) => {
  const m = PERIOD.exec(period)!;
  return `${Number(m[1]) + delta}-${m[2]}`;
};

/** Days from a to b inclusive of both ends, which is how a year has 365 of them. */
const daysInclusive = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / DAY_MS) + 1;

/** A rate in basis points. Null when the base is zero — there is no rate to give. */
function bpsOf(part: bigint, base: bigint): number | null {
  if (base === 0n) return null;
  // The base's magnitude, so the sign of the rate follows the variance rather
  // than the sign of a contra account's budget.
  const b = base < 0n ? -base : base;
  return Number((part * 10_000n) / b);
}

/** amount × numerator / denominator, half away from zero. No floats. */
function scale(amount: bigint, numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new LedgerError("Cannot scale by a zero denominator.");
  const product = amount * numerator;
  const neg = product < 0n;
  const abs = neg ? -product : product;
  const out = (abs + denominator / 2n) / denominator;
  return neg ? -out : out;
}

/** Minor units from whatever the caller had to hand, refusing anything fractional. */
function minorUnits(v: bigint | number | string, what: string): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new LedgerError(`${what} must be in whole minor units, got ${v}.`);
    return BigInt(v);
  }
  const s = String(v).trim();
  if (!/^-?\d+$/.test(s)) throw new LedgerError(`${what} must be in whole minor units, got "${v}".`);
  return BigInt(s);
}

type ChartAccount = { code: string; name: string; nameAr: string | null; type: string };

/** The entity's income and expense accounts, by code. */
async function chartIndex(orgId: string, entityId: string): Promise<Map<string, ChartAccount>> {
  const accounts = await prisma.account.findMany({
    where: { orgId, entityId, type: { in: ["INCOME", "EXPENSE"] } },
    select: { code: true, name: true, nameAr: true, type: true },
  });
  return new Map(accounts.map((a) => [a.code, a]));
}

/**
 * Which section a budgeted account belongs in. The chart is the authority; the
 * fallback exists only for a budget line whose account has since been removed
 * from the chart, which is reported as a warning rather than hidden.
 */
const groupOf = (code: string, chart: Map<string, ChartAccount>): "income" | "expenses" => {
  const a = chart.get(code);
  if (a) return a.type === "INCOME" ? "income" : "expenses";
  return code.startsWith("4") ? "income" : "expenses";
};

const byCode = (a: { code: string }, b: { code: string }) =>
  a.code.localeCompare(b.code, undefined, { numeric: true });

const listing = (xs: string[], limit = 3) =>
  `${xs.slice(0, limit).join(", ")}${xs.length > limit ? ", …" : ""}`;

async function loadYear(orgId: string, entityId: string, label: string) {
  const year = await prisma.fiscalYear.findFirst({ where: { orgId, entityId, label } });
  if (!year) {
    throw new LedgerError(
      `There is no fiscal year "${label}" for this entity. Open the year before budgeting against it.`,
    );
  }
  return year;
}

/* ------------------------------------------------------------------ setting */

/**
 * Write a scenario's lines, one figure per account per month.
 *
 * The validation is the point of the function. A budget against a bank account
 * or a receivable is a category error — those hold a balance, not a plan — and
 * the cost of catching it here is one query, against the cost of a variance
 * report that quietly measures the wrong thing for a year.
 */
export async function setBudget(opts: {
  orgId: string;
  entityId: string;
  scenario?: string;
  fiscalYear: string;
  lines: BudgetLineInput[];
}): Promise<SetBudgetResult> {
  const scenario = (opts.scenario ?? "BUDGET").trim();
  if (!scenario) throw new LedgerError("A budget needs a scenario name, such as BUDGET or FORECAST.");
  if (!opts.lines?.length) throw new LedgerError("A budget needs at least one line.");

  const year = await loadYear(opts.orgId, opts.entityId, opts.fiscalYear);
  const yearFrom = ISO(year.startsOn);
  const yearTo = ISO(year.endsOn);

  const seen = new Set<string>();
  const prepared = opts.lines.map((l) => {
    const period = String(l.period ?? "").trim();
    if (!PERIOD.test(period)) {
      throw new LedgerError(`Budget period "${l.period}" is not a month in YYYY-MM form.`);
    }
    // Naming both ends of the year matters: the usual cause is a fiscal year
    // that does not start in January, and the message has to make that visible.
    if (monthStart(period) < year.startsOn || monthEnd(period) > year.endsOn) {
      throw new LedgerError(
        `Period ${period} falls outside fiscal year ${opts.fiscalYear}, which runs from ${yearFrom} to ${yearTo}.`,
      );
    }
    const code = String(l.accountCode ?? "").trim();
    if (!code) throw new LedgerError(`Budget line for ${period} names no account.`);

    const key = `${period}|${code}`;
    if (seen.has(key)) {
      throw new LedgerError(
        `Account ${code} appears twice for ${period} in this budget. Send one figure per account per month.`,
      );
    }
    seen.add(key);

    return {
      period,
      accountCode: code,
      amountMinor: minorUnits(l.amountMinor, `Budget for ${code} in ${period}`),
      note: l.note ?? null,
    };
  });

  const codes = [...new Set(prepared.map((p) => p.accountCode))];
  const accounts = await prisma.account.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: { in: codes } },
  });
  const chart = new Map(accounts.map((a) => [a.code, a]));

  for (const code of codes) {
    const a = chart.get(code);
    if (!a) throw new LedgerError(`Account ${code} does not exist in this entity's chart.`);
    if (a.type !== "INCOME" && a.type !== "EXPENSE") {
      throw new LedgerError(
        `${a.code} ${a.name} is a balance-sheet account (${a.type}). A budget is a plan for income and ` +
          `expenses; ${a.name} carries a balance, not a plan. Budget the income or expense account the ` +
          `money will land on instead.`,
      );
    }
    if (!a.isPostable) {
      throw new LedgerError(
        `${a.code} ${a.name} is a heading, not a postable account. Nothing can post to it, so a budget ` +
          `against it can never be met or missed. Budget its sub-accounts.`,
      );
    }
    if (a.status !== "active") {
      throw new LedgerError(`Account ${a.code} ${a.name} is archived, so nothing can be posted against this budget.`);
    }
  }

  await prisma.$transaction(
    prepared.map((p) =>
      prisma.budgetLine.upsert({
        where: {
          orgId_entityId_scenario_period_accountCode: {
            orgId: opts.orgId,
            entityId: opts.entityId,
            scenario,
            period: p.period,
            accountCode: p.accountCode,
          },
        },
        create: {
          orgId: opts.orgId,
          entityId: opts.entityId,
          scenario,
          fiscalYear: opts.fiscalYear,
          period: p.period,
          accountCode: p.accountCode,
          amountMinor: p.amountMinor,
          note: p.note,
        },
        update: { amountMinor: p.amountMinor, note: p.note, fiscalYear: opts.fiscalYear },
      }),
    ),
  );

  return {
    scenario,
    fiscalYear: opts.fiscalYear,
    written: prepared.length,
    periods: [...new Set(prepared.map((p) => p.period))].sort(),
    totalMinor: prepared.reduce((a, p) => a + p.amountMinor, 0n).toString(),
  };
}

/* ------------------------------------------------------------------ copying */

/**
 * Clone one scenario onto another — last year's outturn into next year's plan,
 * or this year's budget into a forecast that is about to be revised.
 *
 * The uplift is in basis points and is applied in BigInt: 500 is five per cent,
 * −250 shaves two and a half. A float percentage would round differently on
 * every line and leave a budget whose sections do not add up to its total.
 */
export async function copyScenario(opts: {
  orgId: string;
  entityId: string;
  from: string;
  to: string;
  fiscalYear: string;
  /** Defaults to the source year — pass it to roll a plan into the year after. */
  toFiscalYear?: string;
  upliftBps?: number | bigint;
  /** Replace whatever the target scenario already holds for that year. */
  overwrite?: boolean;
  note?: string;
}): Promise<CopyScenarioResult> {
  const from = opts.from.trim();
  const to = opts.to.trim();
  const toFiscalYear = (opts.toFiscalYear ?? opts.fiscalYear).trim();
  if (!from || !to) throw new LedgerError("A copy needs a source scenario and a target scenario.");
  if (from === to && opts.fiscalYear === toFiscalYear) {
    throw new LedgerError(
      `Scenario "${from}" for ${opts.fiscalYear} cannot be copied onto itself. Give the copy another scenario name or another fiscal year.`,
    );
  }

  const upliftBps = minorUnits(opts.upliftBps ?? 0, "Uplift");
  if (upliftBps < -10_000n) {
    throw new LedgerError(
      `An uplift of ${upliftBps} basis points would turn every budgeted figure negative. ` +
        `−10000 basis points is a hundred per cent cut, which is the most a budget can be reduced by.`,
    );
  }

  const sourceYear = await loadYear(opts.orgId, opts.entityId, opts.fiscalYear);
  const targetYear =
    toFiscalYear === opts.fiscalYear ? sourceYear : await loadYear(opts.orgId, opts.entityId, toFiscalYear);

  const source = await prisma.budgetLine.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, scenario: from, fiscalYear: opts.fiscalYear },
    orderBy: [{ period: "asc" }, { accountCode: "asc" }],
  });
  if (!source.length) {
    throw new LedgerError(
      `Scenario "${from}" holds no budget lines for ${opts.fiscalYear}, so there is nothing to copy.`,
    );
  }

  const existing = await prisma.budgetLine.count({
    where: { orgId: opts.orgId, entityId: opts.entityId, scenario: to, fiscalYear: toFiscalYear },
  });
  if (existing && !opts.overwrite) {
    throw new LedgerError(
      `Scenario "${to}" already holds ${existing} line${existing === 1 ? "" : "s"} for ${toFiscalYear}. ` +
        `Copying would overwrite work someone has done — pass overwrite to replace it deliberately.`,
    );
  }

  // Rolling into another year moves every month by the difference between the
  // two years' start dates, so a July-start fiscal year rolls July to July.
  const delta = targetYear.startsOn.getUTCFullYear() - sourceYear.startsOn.getUTCFullYear();
  const prepared = source.map((l) => {
    const period = delta === 0 ? l.period : shiftYears(l.period, delta);
    if (monthStart(period) < targetYear.startsOn || monthEnd(period) > targetYear.endsOn) {
      throw new LedgerError(
        `Copying ${l.period} from ${opts.fiscalYear} lands on ${period}, which falls outside fiscal year ` +
          `${toFiscalYear} (${ISO(targetYear.startsOn)} to ${ISO(targetYear.endsOn)}). The two years are not the same shape.`,
      );
    }
    return {
      period,
      accountCode: l.accountCode,
      amountMinor: uplift(l.amountMinor, upliftBps),
      note: opts.note ?? l.note,
    };
  });

  await prisma.$transaction([
    ...(existing
      ? [
          prisma.budgetLine.deleteMany({
            where: { orgId: opts.orgId, entityId: opts.entityId, scenario: to, fiscalYear: toFiscalYear },
          }),
        ]
      : []),
    ...prepared.map((p) =>
      prisma.budgetLine.upsert({
        where: {
          orgId_entityId_scenario_period_accountCode: {
            orgId: opts.orgId,
            entityId: opts.entityId,
            scenario: to,
            period: p.period,
            accountCode: p.accountCode,
          },
        },
        create: {
          orgId: opts.orgId,
          entityId: opts.entityId,
          scenario: to,
          fiscalYear: toFiscalYear,
          period: p.period,
          accountCode: p.accountCode,
          amountMinor: p.amountMinor,
          note: p.note,
        },
        update: { amountMinor: p.amountMinor, note: p.note, fiscalYear: toFiscalYear },
      }),
    ),
  ]);

  return {
    from,
    to,
    fromFiscalYear: opts.fiscalYear,
    toFiscalYear,
    upliftBps: Number(upliftBps),
    copied: prepared.length,
    replaced: existing,
    totalMinor: prepared.reduce((a, p) => a + p.amountMinor, 0n).toString(),
  };
}

/** amount × (1 + bps/10000), half away from zero. */
function uplift(amount: bigint, bps: bigint): bigint {
  if (bps === 0n) return amount;
  return scale(amount, 10_000n + bps, 10_000n);
}

/* ---------------------------------------------------------------- the report */

/**
 * Budget against actual for a date range.
 *
 * The actuals are the profit and loss, unchanged: same read, same presentation
 * on each account's natural side, same treatment of a period the range only
 * half covers. The report cannot disagree with the statements because it is
 * not computing anything the statements did not already compute.
 *
 * Both directions of omission are reported. An account with a budget and no
 * spend is an under-spend, which is a finding; an account with spend and no
 * budget is money nobody planned for, which is a bigger one, and it is flagged
 * rather than left to be spotted by its blank budget column.
 */
export async function budgetVsActual(opts: {
  orgId: string;
  entityId: string;
  scenario?: string;
  from: string;
  to: string;
}): Promise<BudgetVsActual> {
  const scenario = (opts.scenario ?? "BUDGET").trim();
  const from = new Date(opts.from);
  const to = new Date(opts.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new LedgerError("A variance report needs valid dates.");
  }
  if (to < from) throw new LedgerError("The period ends before it starts.");

  const pl = await profitAndLoss({ orgId: opts.orgId, entityId: opts.entityId, from: opts.from, to: opts.to });

  // Cost of sales and operating expenses are one section here: the question a
  // budget answers is "did we spend what we planned", which does not care which
  // side of the gross margin the spending fell on.
  const actual = new Map<string, { group: "income" | "expenses"; minor: bigint }>();
  for (const l of pl.revenue.lines) actual.set(l.code, { group: "income", minor: BigInt(l.presentedMinor) });
  for (const l of [...pl.costOfSales.lines, ...pl.expenses.lines]) {
    actual.set(l.code, { group: "expenses", minor: BigInt(l.presentedMinor) });
  }

  const periods = monthsIn(from, to);
  const partialPeriods = periods.filter((p) => monthStart(p) < from || monthEnd(p) > to);

  const rows = await prisma.budgetLine.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, scenario, period: { in: periods } },
  });
  const budget = new Map<string, bigint>();
  for (const r of rows) budget.set(r.accountCode, (budget.get(r.accountCode) ?? 0n) + r.amountMinor);

  const chart = await chartIndex(opts.orgId, opts.entityId);
  const orphans = [...budget.keys()].filter((c) => !chart.has(c));

  const build = (key: "income" | "expenses", label: string, favourableWhen: Direction): VarianceSection => {
    const codes = new Set<string>();
    for (const [code, a] of actual) if (a.group === key) codes.add(code);
    for (const code of budget.keys()) if (groupOf(code, chart) === key) codes.add(code);

    const lines = [...codes]
      .map((code) => {
        const account = chart.get(code);
        const budgetMinor = budget.get(code) ?? 0n;
        const actualMinor = actual.get(code)?.minor ?? 0n;
        const varianceMinor = actualMinor - budgetMinor;
        return {
          code,
          name: account?.name ?? "Not in the chart of accounts",
          nameAr: account?.nameAr ?? null,
          budgetMinor: budgetMinor.toString(),
          actualMinor: actualMinor.toString(),
          varianceMinor: varianceMinor.toString(),
          varianceBps: bpsOf(varianceMinor, budgetMinor),
          // On budget counts as favourable: it is the outcome that was planned.
          favourable: favourableWhen === "above" ? varianceMinor >= 0n : varianceMinor <= 0n,
          // A budget deliberately set to zero is not the same as no budget at
          // all, so this asks whether a line exists, not whether it is nonzero.
          unbudgeted: !budget.has(code),
        };
      })
      .sort(byCode);

    const budgetTotal = lines.reduce((a, l) => a + BigInt(l.budgetMinor), 0n);
    const actualTotal = lines.reduce((a, l) => a + BigInt(l.actualMinor), 0n);
    const variance = actualTotal - budgetTotal;
    return {
      key,
      label,
      favourableWhen,
      lines,
      budgetMinor: budgetTotal.toString(),
      actualMinor: actualTotal.toString(),
      varianceMinor: variance.toString(),
      varianceBps: bpsOf(variance, budgetTotal),
      favourable: favourableWhen === "above" ? variance >= 0n : variance <= 0n,
    };
  };

  const income = build("income", "Income", "above");
  const expenses = build("expenses", "Cost of sales and expenses", "below");

  const netBudget = BigInt(income.budgetMinor) - BigInt(expenses.budgetMinor);
  const netActual = BigInt(income.actualMinor) - BigInt(expenses.actualMinor);
  const netVariance = netActual - netBudget;

  const unbudgeted = [...income.lines, ...expenses.lines].filter((l) => l.unbudgeted && BigInt(l.actualMinor) !== 0n);

  const warnings: string[] = [];
  if (!rows.length) {
    warnings.push(
      `Scenario "${scenario}" has no budget lines for ${listing(periods, 12)}, so every figure below is ` +
        `actual with nothing to measure it against.`,
    );
  }
  if (partialPeriods.length) {
    // The alternative would be splitting a month's budget across its days,
    // which invents a figure nobody planned. Better to include the month whole
    // and say plainly that the comparison is not like for like.
    warnings.push(
      `${opts.from} to ${opts.to} covers only part of ${listing(partialPeriods)}. ` +
        `Those months' budgets are included in full, so their variance compares a whole month's plan against ` +
        `part of a month's activity.`,
    );
  }
  if (unbudgeted.length) {
    warnings.push(
      `${unbudgeted.length} account${unbudgeted.length === 1 ? " carries" : "s carry"} activity with no budget ` +
        `line (${listing(unbudgeted.map((l) => `${l.code} ${l.name}`))}). Unbudgeted spend is the finding worth ` +
        `chasing first — nobody has agreed to it.`,
    );
  }
  if (orphans.length) {
    warnings.push(
      `Budget lines exist for ${listing(orphans)}, which ${orphans.length === 1 ? "is" : "are"} no longer in the ` +
        `chart of accounts. Nothing can post against them, so their budget can only ever show as an under-spend.`,
    );
  }

  return {
    scenario,
    from: opts.from,
    to: opts.to,
    currency: pl.currency,
    periods,
    partialPeriods,
    income,
    expenses,
    netBudgetMinor: netBudget.toString(),
    netActualMinor: netActual.toString(),
    netVarianceMinor: netVariance.toString(),
    netVarianceBps: bpsOf(netVariance, netBudget),
    netFavourable: netVariance >= 0n,
    unbudgetedCount: unbudgeted.length,
    warnings,
  };
}

/* ----------------------------------------------------------------- the year */

/**
 * Year to date against the full-year budget, with a run-rate projection.
 *
 * The projection is arithmetic and nothing more: what has been earned or spent
 * so far, scaled by the elapsed share of the year. It is kept in its own fields
 * with `projected` in every name, and never added to an actual to make one
 * number, because a figure that is half fact and half extrapolation is the kind
 * of number a board makes decisions on without knowing which half it trusted.
 */
export async function budgetSummary(opts: {
  orgId: string;
  entityId: string;
  scenario?: string;
  fiscalYear: string;
  /** Defaults to today. Clamped to the year end — a year cannot be more than over. */
  asOf?: string;
}): Promise<BudgetSummary> {
  const scenario = (opts.scenario ?? "BUDGET").trim();
  const year = await loadYear(opts.orgId, opts.entityId, opts.fiscalYear);

  const requested = opts.asOf ? new Date(opts.asOf) : new Date();
  if (Number.isNaN(requested.getTime())) throw new LedgerError("A budget summary needs a valid as-at date.");
  if (requested < year.startsOn) {
    throw new LedgerError(
      `As at ${ISO(requested)} falls before fiscal year ${opts.fiscalYear} starts on ${ISO(year.startsOn)}. ` +
        `There is no year to date yet.`,
    );
  }
  const asOf = requested > year.endsOn ? year.endsOn : requested;

  const ytd = await budgetVsActual({
    orgId: opts.orgId,
    entityId: opts.entityId,
    scenario,
    from: ISO(year.startsOn),
    to: ISO(asOf),
  });

  const chart = await chartIndex(opts.orgId, opts.entityId);
  const fullYear = await prisma.budgetLine.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, scenario, fiscalYear: opts.fiscalYear },
  });
  let incomeFullYear = 0n;
  let expenseFullYear = 0n;
  for (const l of fullYear) {
    if (groupOf(l.accountCode, chart) === "income") incomeFullYear += l.amountMinor;
    else expenseFullYear += l.amountMinor;
  }

  const elapsedDays = daysInclusive(year.startsOn, asOf);
  const totalDays = daysInclusive(year.startsOn, year.endsOn);
  const elapsed = BigInt(elapsedDays);
  const total = BigInt(totalDays);

  const block = (
    key: "income" | "expenses" | "net",
    label: string,
    favourableWhen: Direction,
    budgetFullYear: bigint,
    budgetToDate: bigint,
    actualToDate: bigint,
    projectedFullYear: bigint,
  ): BudgetSummaryBlock => {
    const variance = actualToDate - budgetToDate;
    const projectedVariance = projectedFullYear - budgetFullYear;
    return {
      key,
      label,
      favourableWhen,
      budgetFullYearMinor: budgetFullYear.toString(),
      budgetToDateMinor: budgetToDate.toString(),
      actualToDateMinor: actualToDate.toString(),
      varianceToDateMinor: variance.toString(),
      varianceToDateBps: bpsOf(variance, budgetToDate),
      favourableToDate: favourableWhen === "above" ? variance >= 0n : variance <= 0n,
      projectedFullYearMinor: projectedFullYear.toString(),
      projectedVarianceMinor: projectedVariance.toString(),
      projectedFavourable: favourableWhen === "above" ? projectedVariance >= 0n : projectedVariance <= 0n,
    };
  };

  const incomeActual = BigInt(ytd.income.actualMinor);
  const expenseActual = BigInt(ytd.expenses.actualMinor);
  const incomeProjected = scale(incomeActual, total, elapsed);
  const expenseProjected = scale(expenseActual, total, elapsed);

  const income = block(
    "income", "Income", "above",
    incomeFullYear, BigInt(ytd.income.budgetMinor), incomeActual, incomeProjected,
  );
  const expenses = block(
    "expenses", "Cost of sales and expenses", "below",
    expenseFullYear, BigInt(ytd.expenses.budgetMinor), expenseActual, expenseProjected,
  );
  const net = block(
    "net", "Net result", "above",
    incomeFullYear - expenseFullYear,
    BigInt(ytd.netBudgetMinor),
    BigInt(ytd.netActualMinor),
    incomeProjected - expenseProjected,
  );

  const warnings = [...ytd.warnings];
  // A run rate off a short elapsed period multiplies whatever happened in it,
  // including one large invoice that will not repeat.
  if (elapsed * 4n < total) {
    warnings.push(
      `Only ${elapsedDays} of ${totalDays} days have elapsed. The projection multiplies the year to date by ` +
        `${(totalDays / elapsedDays).toFixed(1)}, so a single unusual month carries straight through it.`,
    );
  }
  if (!fullYear.length) {
    warnings.push(
      `Scenario "${scenario}" holds no budget for ${opts.fiscalYear}, so the full-year figures below are zero ` +
        `by absence rather than by plan.`,
    );
  }

  return {
    scenario,
    fiscalYear: opts.fiscalYear,
    asOf: ISO(asOf),
    currency: ytd.currency,
    yearStartsOn: ISO(year.startsOn),
    yearEndsOn: ISO(year.endsOn),
    elapsedDays,
    totalDays,
    income,
    expenses,
    net,
    projectionBasis:
      `Actual figures are posted to ${ISO(asOf)}. Projected figures are the year to date scaled by ` +
      `${totalDays} days over ${elapsedDays} elapsed — a run rate, not a forecast: it assumes the rest of the ` +
      `year looks like the part that has happened, and knows nothing of seasonality or of what is already committed.`,
    warnings,
  };
}
