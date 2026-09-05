import { prisma } from "@/lib/server/prisma";
import { LedgerError } from "./post";
import { UNALLOCATED, addValue, createDimension, dimensionalProfitAndLoss } from "./dimensions";

/**
 * Project and job costing.
 *
 * ── How this relates to dimensions.ts ───────────────────────────────────────
 * A project is not a second, parallel way of tagging a posting. It is a value
 * of the ordinary PROJECT dimension, created through addValue() and attributed
 * through exactly the machinery dimensions.ts already has: post.ts writes a
 * JournalLineDimension for { PROJECT: "SITE_A" }, attributeLines() sums those
 * lines per column, and dimensionalProfitAndLoss() proves the columns add back
 * to the real profit and loss. Every figure in this module is read from that
 * one call. Nothing here sums a journal line for itself, because a job-costing
 * report derived a second way would eventually disagree with the cost-centre
 * report over the same postings, and then neither could be believed.
 *
 * What this module adds is the half the ledger cannot hold. A dimension value
 * is a code and a name; the `Project` row is what a job actually is — a budget
 * it was quoted at, a customer it was sold to, a date it started and a date it
 * finished. The ledger holds what it cost. Put together they answer the only
 * question a job-costing screen is asked: is this job making money, and is it
 * going to come in at the price we gave.
 *
 * Two consequences are deliberate:
 *
 *  1. Unassigned is a row, never a footnote and never spread. Cost carrying no
 *     project is the number that decides whether job costing can be trusted at
 *     all — every hour of it is somebody's job, mis-tagged. Hiding it, or
 *     apportioning it across the projects pro rata, turns an honest "we do not
 *     know" into a set of plausible per-job margins that are all slightly
 *     wrong. It is inherited from dimensions.ts's Unallocated column and it is
 *     the same residual, relabelled for this screen.
 *
 *  2. Every report carries the reconciliation. All projects plus Unassigned
 *     must equal the undimensioned profit and loss for the same dates, and the
 *     difference is returned rather than absorbed.
 *
 * Amounts are BigInt minor units and every rate is basis points computed in
 * BigInt. Division that has no answer returns null: a project with no budget
 * has no "percent of budget consumed", and saying so is not the same as
 * reporting zero, or Infinity, or a comforting 100%.
 */

/** The dimension every project is a value of. */
export const PROJECT_DIMENSION = "PROJECT";

/**
 * The row for cost that carries no project.
 *
 * Its key is dimensions.ts's UNALLOCATED, deliberately and exactly: this is the
 * same residual bucket, not a second one alongside it, so a project figure and
 * a cost-centre figure can never disagree about what was left untagged. Only
 * the label differs, because "Unassigned" is the word a job-costing reader
 * expects to see against a job.
 */
export const UNASSIGNED = UNALLOCATED;
const UNASSIGNED_LABEL = "Unassigned";

/**
 * Codes a project may not take. UNALLOCATED is the residual key itself, which
 * addValue() also refuses; UNASSIGNED is the word this report prints beside it,
 * and a job called UNASSIGNED sitting one row above the Unassigned row would be
 * misread by somebody, once, expensively.
 */
const RESERVED = new Set<string>([UNASSIGNED, "UNASSIGNED"]);

export type ProjectStatus = "active" | "on_hold" | "complete" | "cancelled";
const STATUSES: ProjectStatus[] = ["active", "on_hold", "complete", "cancelled"];
/** Statuses a project is still running under, and so still has work in progress. */
const IN_FLIGHT: ProjectStatus[] = ["active", "on_hold"];

export interface ProjectRecord {
  code: string;
  name: string;
  customerName: string | null;
  /** YYYY-MM-DD. */
  startsOn: string;
  endsOn: string | null;
  /** What the job was quoted at, in minor units. */
  budgetMinor: string;
  status: ProjectStatus;
}

/** One recorded change to what a job was quoted at. */
export interface BudgetRevision {
  id: string;
  /** What it was, and what it became — both, so the row reads on its own. */
  priorMinor: string;
  budgetMinor: string;
  /** budget − prior. Negative is a budget that was cut. */
  movementMinor: string;
  reason: string;
  revisedBy: string | null;
  /** The instant it was recorded, in full: two revisions can share a day. */
  revisedAt: string;
}

export interface ProjectProfitability {
  code: string;
  name: string;
  customerName: string | null;
  status: ProjectStatus;
  startsOn: string;
  endsOn: string | null;
  /** The dates these figures cover — defaulted from the project when not given. */
  from: string;
  to: string;
  currency: string;
  /** Income attributed to the project, on its natural side. */
  revenueMinor: string;
  /** Cost of sales plus operating expenses attributed to the project. */
  costMinor: string;
  grossProfitMinor: string;
  /** Gross profit over revenue, in basis points. Null when there is no revenue. */
  grossMarginBps: string | null;
  budgetMinor: string;
  /** False when the project was set up without a budget — see overBudget. */
  hasBudget: boolean;
  /** Exactly costMinor. There is not a second definition of what was spent. */
  spentMinor: string;
  /** Budget less spent. Negative once the job has overrun. */
  remainingMinor: string;
  /** Spent over budget, in basis points. Null when there is no budget. */
  percentOfBudgetBps: string | null;
  /** Stated, never inferred from the sign of remainingMinor. */
  overBudget: boolean;
  /** How far over, or "0". */
  overBudgetByMinor: string;
  /**
   * Every recorded revision to the budget, most recent first.
   *
   * An empty list is not proof that the figure has never moved. The history
   * begins when `ProjectBudgetRevision` began — before that a revision
   * overwrote one column and left nothing behind — so a job set up earlier may
   * carry a budget that was changed and cannot say so. The screen prints that
   * caveat rather than presenting an empty list as "never revised".
   */
  budgetRevisions: BudgetRevision[];
  /** The dimensional read this came from ties to the real profit and loss. */
  reconciles: boolean;
  differenceMinor: string;
}

export interface ProjectSummaryRow {
  /** The project's code, or UNASSIGNED. */
  key: string;
  label: string;
  /** True for exactly one row, and it is always present. */
  isUnassigned: boolean;
  status: ProjectStatus | null;
  customerName: string | null;
  revenueMinor: string;
  costMinor: string;
  netMinor: string;
  /** Null on the Unassigned row: nobody budgets for work nobody assigned. */
  budgetMinor: string | null;
  percentOfBudgetBps: string | null;
  overBudget: boolean;
  marginBps: string | null;
}

export interface ProjectSummary {
  from: string;
  to: string;
  currency: string;
  /** Projects by code, then Unassigned — last, so it reads as the residual. */
  rows: ProjectSummaryRow[];
  totalRevenueMinor: string;
  totalCostMinor: string;
  totalNetMinor: string;
  /** The trust number. Cost nobody assigned to a job. */
  unassignedCostMinor: string;
  /** That cost as a share of all cost, in basis points. Null when there is none. */
  unassignedShareBps: string | null;
  /** Every project plus Unassigned equals the undimensioned profit and loss. */
  reconciles: boolean;
  differenceMinor: string;
  controlNetProfitMinor: string;
}

export interface WorkInProgressRow {
  code: string;
  name: string;
  customerName: string | null;
  status: ProjectStatus;
  startsOn: string;
  endsOn: string | null;
  costToDateMinor: string;
  invoicedMinor: string;
  /** Cost to date less invoiced. Positive means cost is running ahead of billing. */
  wipMinor: string;
  /** Billed ahead of cost. Stated rather than left to the sign of wipMinor. */
  overBilled: boolean;
  budgetMinor: string;
  percentOfBudgetBps: string | null;
  overBudget: boolean;
}

export interface WorkInProgress {
  asOf: string;
  /** Inception — the first day the ledger has a period for. */
  from: string;
  currency: string;
  /**
   * Always "cost-to-date". Read the comment on workInProgress(): this is not an
   * IFRS 15 measurement and the field exists so nobody can mistake it for one.
   */
  basis: "cost-to-date";
  rows: WorkInProgressRow[];
  totalCostMinor: string;
  totalInvoicedMinor: string;
  totalWipMinor: string;
  /** Projects left out, and why. */
  excludedStatuses: ProjectStatus[];
}

export interface ProjectDetailLine {
  entryId: string;
  reference: string;
  date: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  memo: string | null;
  source: string;
  status: string;
  debitMinor: string;
  creditMinor: string;
  /** Signed, debit-positive, running down the page. */
  runningMinor: string;
}

export interface ProjectDetail {
  code: string;
  name: string;
  from: string;
  to: string;
  currency: string;
  lines: ProjectDetailLine[];
  /** True when `limit` cut the list short. */
  truncated: boolean;
  /**
   * Null when the list was truncated: a total of some of the lines is not a
   * total, and printing one under a shortened list is how a drill-down starts
   * disagreeing with the report it was opened from.
   */
  totals: { revenueMinor: string; costMinor: string; otherMinor: string } | null;
}

/* ------------------------------------------------------------- validation */

/**
 * A project code becomes a dimension value code, so it lives under the same
 * rule: post.ts resolves dimensions through a `${dimensionCode}:${valueCode}`
 * key, and a code carrying a colon could resolve to a different project than
 * the one asked for. addValue() enforces this too — this check exists so the
 * message names the project rather than a dimension the user never mentioned.
 */
const CODE = /^[A-Z0-9][A-Z0-9_]*$/;

function projectCode(raw: string): string {
  const code = (raw ?? "").trim().toUpperCase();
  if (!CODE.test(code)) {
    throw new LedgerError(
      `A project code must be letters, digits and underscores only — "${raw}" is not. Use something like SITE_A or JOB_1042.`,
    );
  }
  if (RESERVED.has(code)) {
    throw new LedgerError(
      `"${code}" names the row for cost that carries no project, so it cannot also be a project. Choose another code.`,
    );
  }
  return code;
}

function projectName(raw: string | undefined): string {
  const name = (raw ?? "").trim();
  if (!name) {
    throw new LedgerError(`A project needs a name somebody will recognise on a report, such as "Marina Tower fit-out".`);
  }
  return name;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(raw: string | Date, what: string): Date {
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) throw new LedgerError(`The ${what} is not a valid date.`);
    return raw;
  }
  const text = (raw ?? "").trim();
  if (!DATE_ONLY.test(text)) {
    throw new LedgerError(`The ${what} must be a date in the form YYYY-MM-DD — "${raw}" is not.`);
  }
  const d = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new LedgerError(`The ${what} is not a valid date.`);
  return d;
}

/** Amounts arrive as minor units and stay there — a float never touches one. */
function parseMinor(raw: number | bigint | string, what: string): bigint {
  if (typeof raw === "number" && !Number.isInteger(raw)) {
    throw new LedgerError(`The ${what} must be whole minor units (fils), not ${raw}.`);
  }
  if (typeof raw === "string" && !/^-?\d+$/.test(raw.trim())) {
    throw new LedgerError(`The ${what} must be whole minor units (fils), not "${raw}".`);
  }
  const v = BigInt(typeof raw === "string" ? raw.trim() : raw);
  if (v < 0n) throw new LedgerError(`The ${what} cannot be negative. A job quoted at nothing has a budget of 0.`);
  return v;
}

function parseStatus(raw: string): ProjectStatus {
  const s = (raw ?? "").trim().toLowerCase();
  if (!(STATUSES as string[]).includes(s)) {
    throw new LedgerError(`A project is ${STATUSES.join(", ")} — "${raw}" is none of those.`);
  }
  return s as ProjectStatus;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Basis points, in BigInt, truncated toward zero so a share is never overstated
 * in magnitude. A zero denominator has no answer and gets null — "there is no
 * budget" and "the budget is untouched" are different facts and must not print
 * the same.
 */
const bps = (numerator: bigint, denominator: bigint): bigint | null =>
  denominator === 0n ? null : (numerator * 10_000n) / denominator;

const str = (v: bigint | null) => (v === null ? null : v.toString());

type Row = {
  id: string;
  code: string;
  name: string;
  customerName: string | null;
  startsOn: Date;
  endsOn: Date | null;
  budgetMinor: bigint;
  status: string;
};

const toRecord = (p: Row): ProjectRecord => ({
  code: p.code,
  name: p.name,
  customerName: p.customerName,
  startsOn: iso(p.startsOn),
  endsOn: p.endsOn ? iso(p.endsOn) : null,
  budgetMinor: p.budgetMinor.toString(),
  status: p.status as ProjectStatus,
});

async function findProject(orgId: string, entityId: string, code: string): Promise<Row> {
  const project = await prisma.project.findUnique({
    where: { orgId_entityId_code: { orgId, entityId, code } },
  });
  if (!project) {
    throw new LedgerError(`There is no project ${code} in this entity. Create it before reporting on it, or check the code.`);
  }
  return project;
}

/** The book every statement is read from, as statements.ts and dimensions.ts do. */
async function primaryBook(orgId: string, entityId: string) {
  const book = await prisma.book.findFirst({ where: { orgId, entityId, code: "PRIMARY" } });
  if (!book) throw new LedgerError("No ledger has been opened for this entity.");
  return book;
}

/**
 * The PROJECT dimension, resolved for a read.
 *
 * Reads never create it. A report is not the place to quietly write setup into
 * the database, and "no PROJECT dimension" only ever means "no project has been
 * created yet", which is a sentence worth saying out loud.
 */
async function projectDimension(orgId: string) {
  const dimension = await prisma.dimension.findUnique({
    where: { orgId_code: { orgId, code: PROJECT_DIMENSION } },
  });
  if (!dimension) {
    throw new LedgerError(
      "No projects have been set up in this organisation, so there is nothing to cost against. Create a project first — every cost is unassigned until one exists.",
    );
  }
  return dimension;
}

/* ------------------------------------------------------------- maintenance */

/**
 * Create a project, and with it the means to tag cost to it.
 *
 * The `Project` row and the dimension value are two halves of one thing: the
 * row carries the budget, the customer and the dates; the value is what a
 * posting actually points at. The value is written first, so a failure leaves a
 * value nobody uses rather than a project nothing can be tagged to — the second
 * would look like a ledger fault to whoever hit it at month end.
 */
export async function createProject(opts: {
  orgId: string;
  entityId: string;
  code: string;
  name: string;
  customerName?: string | null;
  startsOn: string | Date;
  endsOn?: string | Date | null;
  budgetMinor?: number | bigint | string;
  status?: string;
}): Promise<ProjectRecord> {
  const code = projectCode(opts.code);
  const name = projectName(opts.name);
  const startsOn = parseDate(opts.startsOn, "project start date");
  const endsOn = opts.endsOn === undefined || opts.endsOn === null ? null : parseDate(opts.endsOn, "project end date");
  const budgetMinor = opts.budgetMinor === undefined ? 0n : parseMinor(opts.budgetMinor, "project budget");
  const status = opts.status === undefined ? "active" : parseStatus(opts.status);

  // The database enforces this too; checking here names both dates so the
  // message can be acted on without reading a constraint name.
  if (endsOn && endsOn < startsOn) {
    throw new LedgerError(`Project ${code} would end on ${iso(endsOn)}, before it starts on ${iso(startsOn)}. Check the dates.`);
  }

  const existing = await prisma.project.findUnique({
    where: { orgId_entityId_code: { orgId: opts.orgId, entityId: opts.entityId, code } },
  });
  if (existing) {
    throw new LedgerError(
      `Project ${code} already exists in this entity — it is "${existing.name}". Use a different code, or update the existing project.`,
    );
  }

  // Idempotent setup, in the shape createDimension() and openBooks() use. The
  // dimension is only created when it is missing: upserting would rename a
  // PROJECT dimension somebody had already named something else.
  const dimension = await prisma.dimension.findUnique({
    where: { orgId_code: { orgId: opts.orgId, code: PROJECT_DIMENSION } },
  });
  if (!dimension) {
    await createDimension({ orgId: opts.orgId, code: PROJECT_DIMENSION, name: "Project" });
  }
  await addValue({ orgId: opts.orgId, dimensionCode: PROJECT_DIMENSION, code, name });

  const created = await prisma.project.create({
    data: {
      orgId: opts.orgId,
      entityId: opts.entityId,
      code,
      name,
      customerName: opts.customerName?.trim() || null,
      startsOn,
      endsOn,
      budgetMinor,
      status,
    },
  });
  return toRecord(created);
}

/**
 * Change what a project is. The code is not among the things that can change:
 * every posting already tagged to this job points at the dimension value by
 * code, so renaming it would leave that cost pointing at nothing and the job
 * would appear to have cost nothing at all. Raise a new project instead.
 *
 * ── Revising the budget ────────────────────────────────────────────────────
 *
 * The budget was one column, and a revision overwrote it. That is not a small
 * loss: the budget is what every percentage on the job is measured against, so
 * an overspend disappeared the moment somebody raised the number, and nothing
 * anywhere said who had raised it or why. Scope does move and budgets do get
 * revised — refusing the change would only push it into a spreadsheet beside
 * the ledger — so the change is allowed and the figure it replaces is kept.
 *
 * A revision therefore takes a reason, and it is required rather than
 * encouraged: the database's own CHECK refuses a blank one, and a revision
 * nobody has to justify is the thing the table exists to prevent. The reason is
 * asked for here, before the write, so the refusal names the project rather
 * than a constraint.
 *
 * The write is conditional on the budget still being what was read. Two people
 * revising at once would otherwise both record the same prior figure, and the
 * history would then say the budget went from A to B and from A to C when what
 * really happened was A to B to C.
 */
export async function updateProject(opts: {
  orgId: string;
  entityId: string;
  code: string;
  name?: string;
  customerName?: string | null;
  endsOn?: string | Date | null;
  budgetMinor?: number | bigint | string;
  /** Why the budget moved. Required when it does, and kept with the revision. */
  reason?: string;
  /** Who moved it. Whoever is signed in — never a value the browser supplies. */
  revisedBy?: string;
  status?: string;
}): Promise<ProjectRecord> {
  const code = projectCode(opts.code);
  const project = await findProject(opts.orgId, opts.entityId, code);

  const name = opts.name === undefined ? project.name : projectName(opts.name);
  const endsOn =
    opts.endsOn === undefined ? project.endsOn : opts.endsOn === null ? null : parseDate(opts.endsOn, "project end date");
  const budgetMinor = opts.budgetMinor === undefined ? project.budgetMinor : parseMinor(opts.budgetMinor, "project budget");
  const status = opts.status === undefined ? (project.status as ProjectStatus) : parseStatus(opts.status);

  if (endsOn && endsOn < project.startsOn) {
    throw new LedgerError(
      `Project ${code} would end on ${iso(endsOn)}, before it starts on ${iso(project.startsOn)}. Check the dates.`,
    );
  }
  if (status === "complete" && !endsOn) {
    throw new LedgerError(
      `Project ${code} cannot be complete without the date it finished. Close it with closeProject, which stamps that date for you.`,
    );
  }

  const revised = budgetMinor !== project.budgetMinor;
  const reason = (opts.reason ?? "").trim();
  if (revised && !reason) {
    throw new LedgerError(
      `Changing the budget on ${code} needs a reason. The budget is what every percentage on this job is measured ` +
        `against, so a figure that moves with nothing said about why makes an overspend disappear instead of ` +
        `explaining it — a variation agreed, a rate renegotiated, scope added. Whatever it was, write it down.`,
    );
  }

  // The report reads its labels from the dimension value, so a renamed project
  // has to be renamed on both halves or the screen keeps the old name.
  if (name !== project.name) {
    await addValue({ orgId: opts.orgId, dimensionCode: PROJECT_DIMENSION, code, name });
  }

  const data = {
    name,
    customerName: opts.customerName === undefined ? project.customerName : opts.customerName?.trim() || null,
    endsOn,
    budgetMinor,
    status,
  };

  // The change and the record of it are one write. A revision row without the
  // change would be a history of something that did not happen, and the change
  // without the row is the loss this whole table exists to stop.
  const updated = await prisma.$transaction(async (tx) => {
    if (!revised) {
      return tx.project.update({
        where: { orgId_entityId_code: { orgId: opts.orgId, entityId: opts.entityId, code } },
        data,
      });
    }

    const moved = await tx.project.updateMany({
      where: { orgId: opts.orgId, entityId: opts.entityId, code, budgetMinor: project.budgetMinor },
      data,
    });
    if (moved.count !== 1) {
      throw new LedgerError(
        `The budget on ${code} was changed by somebody else while this revision was in flight, so it has not been ` +
          `applied. Reload the job and decide again against the figure it now carries.`,
      );
    }

    await tx.projectBudgetRevision.create({
      data: {
        orgId: opts.orgId,
        projectId: project.id,
        priorMinor: project.budgetMinor,
        budgetMinor,
        reason,
        revisedBy: opts.revisedBy?.trim() || null,
      },
    });

    return tx.project.findUniqueOrThrow({
      where: { orgId_entityId_code: { orgId: opts.orgId, entityId: opts.entityId, code } },
    });
  });
  return toRecord(updated);
}

/**
 * What a job has been quoted at, over time, most recent first.
 *
 * Scoped through the project rather than by id: a revision belongs to one job
 * in one entity, and reading it by project id alone would let a caller holding
 * an id from another entity read its budget history.
 */
export async function budgetHistory(opts: {
  orgId: string; entityId: string; code: string;
}): Promise<BudgetRevision[]> {
  const project = await findProject(opts.orgId, opts.entityId, projectCode(opts.code));
  return revisionsOf(opts.orgId, project.id);
}

async function revisionsOf(orgId: string, projectId: string): Promise<BudgetRevision[]> {
  const rows = await prisma.projectBudgetRevision.findMany({
    where: { orgId, projectId },
    // The id breaks a tie, so two revisions recorded in the same millisecond
    // still come back in one fixed order rather than in whichever order the
    // database happened to return them this time.
    orderBy: [{ revisedAt: "desc" }, { id: "desc" }],
  });
  return rows.map((r) => ({
    id: r.id,
    priorMinor: r.priorMinor.toString(),
    budgetMinor: r.budgetMinor.toString(),
    movementMinor: (r.budgetMinor - r.priorMinor).toString(),
    reason: r.reason,
    revisedBy: r.revisedBy,
    revisedAt: r.revisedAt.toISOString(),
  }));
}

/**
 * Finish a job: mark it complete and stamp the date it finished.
 *
 * Closing is idempotent — re-running a month-end routine must not fail on the
 * projects it closed the first time. It does not touch the ledger: a project's
 * cost is whatever was posted to it, and closing a job is an administrative act,
 * not an accounting entry.
 *
 * The dimension value is archived, which dimensions.ts deliberately keeps as a
 * column so last year's cost does not silently move into Unassigned. Be clear
 * about what that does and does not buy: post.ts does not currently check
 * DimensionValue.status, so archiving records the intent that no further cost
 * be tagged here — it does not enforce it. Nothing in this module can prevent a
 * late posting to a closed job, and pretending otherwise would be worse than
 * saying so.
 */
export async function closeProject(opts: {
  orgId: string;
  entityId: string;
  code: string;
  endsOn?: string | Date;
}): Promise<ProjectRecord> {
  const code = projectCode(opts.code);
  const project = await findProject(opts.orgId, opts.entityId, code);

  if (project.status === "cancelled") {
    throw new LedgerError(
      `Project ${code} was cancelled, so it cannot be completed. Set it back to active first if the work restarted.`,
    );
  }
  if (project.status === "complete") return toRecord(project);

  const endsOn = parseDate(opts.endsOn ?? today(), "project end date");
  if (endsOn < project.startsOn) {
    throw new LedgerError(
      `Project ${code} cannot finish on ${iso(endsOn)}, before it started on ${iso(project.startsOn)}. Check the date.`,
    );
  }

  const updated = await prisma.project.update({
    where: { orgId_entityId_code: { orgId: opts.orgId, entityId: opts.entityId, code } },
    data: { status: "complete", endsOn },
  });

  const dimension = await prisma.dimension.findUnique({
    where: { orgId_code: { orgId: opts.orgId, code: PROJECT_DIMENSION } },
  });
  if (dimension) {
    await prisma.dimensionValue.updateMany({
      where: { dimensionId: dimension.id, code },
      data: { status: "archived" },
    });
  }

  return toRecord(updated);
}

/** Every project in the entity, newest work first is not useful — by code. */
export async function listProjects(opts: { orgId: string; entityId: string; status?: string }): Promise<ProjectRecord[]> {
  const status = opts.status === undefined ? undefined : parseStatus(opts.status);
  const rows = await prisma.project.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, ...(status ? { status } : {}) },
    orderBy: { code: "asc" },
  });
  return rows.map(toRecord);
}

/* ---------------------------------------------------------------- reporting */

const fig = (rec: Record<string, string>, key: string): bigint => BigInt(rec[key] ?? "0");

/**
 * One read of the ledger, shared by every report below. This is the existing
 * dimensional read — the same one the cost-centre screen uses — asked for the
 * PROJECT axis. Job costing has no private path to the general ledger.
 */
async function projectColumns(opts: { orgId: string; entityId: string; from: string; to: string }) {
  await projectDimension(opts.orgId);
  return dimensionalProfitAndLoss({ ...opts, dimensionCode: PROJECT_DIMENSION });
}

/**
 * What one job earned, what it cost, and how that sits against what it was
 * quoted at.
 *
 * With no dates it covers the project's own life: from the day it started to
 * the day it finished, or to today while it is still running. That is the range
 * somebody means by "how is this job doing".
 */
export async function projectProfitability(opts: {
  orgId: string;
  entityId: string;
  projectCode: string;
  from?: string;
  to?: string;
}): Promise<ProjectProfitability> {
  const code = projectCode(opts.projectCode);
  const project = await findProject(opts.orgId, opts.entityId, code);

  const from = opts.from ?? iso(project.startsOn);
  const to = opts.to ?? (project.endsOn ? iso(project.endsOn) : today());

  const pl = await projectColumns({ orgId: opts.orgId, entityId: opts.entityId, from, to });

  const revenue = fig(pl.revenue.totalMinor, code);
  const cost = fig(pl.costOfSales.totalMinor, code) + fig(pl.expenses.totalMinor, code);
  const gross = revenue - cost;

  const budget = project.budgetMinor;
  const hasBudget = budget > 0n;
  const over = hasBudget && cost > budget;

  return {
    code,
    name: project.name,
    customerName: project.customerName,
    status: project.status as ProjectStatus,
    startsOn: iso(project.startsOn),
    endsOn: project.endsOn ? iso(project.endsOn) : null,
    from,
    to,
    currency: pl.currency,
    revenueMinor: revenue.toString(),
    costMinor: cost.toString(),
    grossProfitMinor: gross.toString(),
    grossMarginBps: str(bps(gross, revenue)),
    budgetMinor: budget.toString(),
    hasBudget,
    spentMinor: cost.toString(),
    remainingMinor: (budget - cost).toString(),
    // No budget, no percentage. Reporting 0% or Infinity here would both be
    // inventions, and the first reads as reassurance.
    percentOfBudgetBps: str(bps(cost, budget)),
    overBudget: over,
    overBudgetByMinor: (over ? cost - budget : 0n).toString(),
    budgetRevisions: await revisionsOf(opts.orgId, project.id),
    reconciles: pl.reconciles,
    differenceMinor: pl.differenceMinor,
  };
}

/**
 * Every project as a row, and Unassigned as a row beside them.
 *
 * The Unassigned row is the point of this report as much as the projects are.
 * It is never hidden when it is zero and never spread across the jobs, because
 * a per-job margin that quietly includes a share of cost nobody could place is
 * a number that will be defended in a meeting and cannot be.
 */
export async function projectSummary(opts: {
  orgId: string;
  entityId: string;
  from: string;
  to: string;
}): Promise<ProjectSummary> {
  const pl = await projectColumns(opts);
  const projects = await prisma.project.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId },
    orderBy: { code: "asc" },
  });
  const byCode = new Map(projects.map((p) => [p.code, p]));

  const build = (key: string, label: string, project: Row | undefined): ProjectSummaryRow => {
    const revenue = fig(pl.revenue.totalMinor, key);
    const cost = fig(pl.costOfSales.totalMinor, key) + fig(pl.expenses.totalMinor, key);
    const budget = project?.budgetMinor ?? null;
    return {
      key,
      label,
      isUnassigned: key === UNASSIGNED,
      status: project ? (project.status as ProjectStatus) : null,
      customerName: project?.customerName ?? null,
      revenueMinor: revenue.toString(),
      costMinor: cost.toString(),
      netMinor: (revenue - cost).toString(),
      budgetMinor: budget === null ? null : budget.toString(),
      percentOfBudgetBps: budget === null ? null : str(bps(cost, budget)),
      overBudget: budget !== null && budget > 0n && cost > budget,
      marginBps: str(bps(revenue - cost, revenue)),
    };
  };

  // Built from the ledger's own columns, so a value somebody added to the
  // PROJECT dimension by hand still shows its cost instead of it vanishing.
  const rows: ProjectSummaryRow[] = pl.columns
    .filter((c) => !c.isUnallocated)
    .map((c) => build(c.key, byCode.get(c.key)?.name ?? c.label, byCode.get(c.key)));

  // And a project whose dimension value has gone missing is still listed, at
  // zero, rather than disappearing from the report that is meant to list it.
  const shown = new Set(rows.map((r) => r.key));
  for (const p of projects) {
    if (!shown.has(p.code)) rows.push(build(p.code, p.name, p));
  }
  rows.sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
  rows.push(build(UNASSIGNED, UNASSIGNED_LABEL, undefined));

  const totalRevenue = rows.reduce((a, r) => a + BigInt(r.revenueMinor), 0n);
  const totalCost = rows.reduce((a, r) => a + BigInt(r.costMinor), 0n);
  const totalNet = rows.reduce((a, r) => a + BigInt(r.netMinor), 0n);
  const unassignedCost = BigInt(rows[rows.length - 1].costMinor);

  // Checked here over the rows this report actually prints, not merely inherited
  // from the dimensional read: if a row were dropped or double-counted while
  // building the list above, that is exactly what this catches.
  const control = BigInt(pl.reconciliation.controlNetProfitMinor);
  const difference = totalNet - control;

  return {
    from: pl.from,
    to: pl.to,
    currency: pl.currency,
    rows,
    totalRevenueMinor: totalRevenue.toString(),
    totalCostMinor: totalCost.toString(),
    totalNetMinor: totalNet.toString(),
    unassignedCostMinor: unassignedCost.toString(),
    unassignedShareBps: str(bps(unassignedCost, totalCost)),
    reconciles: pl.reconciles && difference === 0n,
    differenceMinor: difference.toString(),
    controlNetProfitMinor: pl.reconciliation.controlNetProfitMinor,
  };
}

/**
 * Work in progress: cost incurred on jobs that are still running, less what has
 * been invoiced against them.
 *
 * READ THIS BEFORE USING THE NUMBER. This is a cost-to-date view and it is NOT
 * IFRS 15 revenue recognition. There is no percentage-of-completion here, no
 * estimate of costs to complete, no contract asset or contract liability, and
 * no judgement about whether a performance obligation is satisfied over time or
 * at a point in time. It is arithmetic on postings: what the ledger says the
 * job has cost, minus what the ledger says has been billed for it. Calling that
 * revenue recognition would be worse than not having the report at all, because
 * it would put an unaudited estimate into a set of accounts wearing the name of
 * a standard it does not follow. Nothing here posts, and nothing here belongs
 * on a balance sheet without an accountant's judgement applied on top of it.
 *
 * Only projects that are active or on hold appear. A completed job has no work
 * in progress by definition, and a cancelled one is a write-off decision rather
 * than work still in flight — both are named in excludedStatuses rather than
 * left for the reader to deduce from an absence.
 */
export async function workInProgress(opts: {
  orgId: string;
  entityId: string;
  asOf: string;
}): Promise<WorkInProgress> {
  const asOfDate = parseDate(opts.asOf, "as-at date");
  const asOf = iso(asOfDate);

  await primaryBook(opts.orgId, opts.entityId);

  // Inception to date, so a job that started in a previous year still carries
  // its whole cost. The first period the entity has is as far back as the
  // ledger goes.
  const first = await prisma.accountingPeriod.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId },
    orderBy: { startsOn: "asc" },
    select: { startsOn: true },
  });
  const from = first ? iso(first.startsOn) : asOf;

  const pl = await projectColumns({ orgId: opts.orgId, entityId: opts.entityId, from, to: asOf });

  const projects = await prisma.project.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, status: { in: IN_FLIGHT } },
    orderBy: { code: "asc" },
  });

  const rows: WorkInProgressRow[] = projects.map((p) => {
    const cost = fig(pl.costOfSales.totalMinor, p.code) + fig(pl.expenses.totalMinor, p.code);
    const invoiced = fig(pl.revenue.totalMinor, p.code);
    const wip = cost - invoiced;
    return {
      code: p.code,
      name: p.name,
      customerName: p.customerName,
      status: p.status as ProjectStatus,
      startsOn: iso(p.startsOn),
      endsOn: p.endsOn ? iso(p.endsOn) : null,
      costToDateMinor: cost.toString(),
      invoicedMinor: invoiced.toString(),
      wipMinor: wip.toString(),
      overBilled: wip < 0n,
      budgetMinor: p.budgetMinor.toString(),
      percentOfBudgetBps: str(bps(cost, p.budgetMinor)),
      overBudget: p.budgetMinor > 0n && cost > p.budgetMinor,
    };
  });

  return {
    asOf,
    from,
    currency: pl.currency,
    basis: "cost-to-date",
    rows,
    totalCostMinor: rows.reduce((a, r) => a + BigInt(r.costToDateMinor), 0n).toString(),
    totalInvoicedMinor: rows.reduce((a, r) => a + BigInt(r.invoicedMinor), 0n).toString(),
    totalWipMinor: rows.reduce((a, r) => a + BigInt(r.wipMinor), 0n).toString(),
    excludedStatuses: ["complete", "cancelled"],
  };
}

/**
 * The postings behind a project's figures, so a number can be traced to the
 * entries that made it. These are the same lines attributeLines() sums for the
 * PROJECT column — the drill-down, not a second opinion.
 *
 * Amounts are functional currency, because that is what the reports above are
 * in; showing the transaction currency here would make a trace that does not
 * add up to the number it was opened from.
 */
export async function projectDetail(opts: {
  orgId: string;
  entityId: string;
  projectCode: string;
  from?: string;
  to?: string;
  limit?: number;
}): Promise<ProjectDetail> {
  const code = projectCode(opts.projectCode);
  const project = await findProject(opts.orgId, opts.entityId, code);
  const dimension = await projectDimension(opts.orgId);
  const book = await primaryBook(opts.orgId, opts.entityId);

  const value = await prisma.dimensionValue.findUnique({
    where: { dimensionId_code: { dimensionId: dimension.id, code } },
  });
  if (!value) {
    throw new LedgerError(
      `Project ${code} has no ${PROJECT_DIMENSION} value, so nothing can have been tagged to it. Re-create the project to restore it.`,
    );
  }

  const from = opts.from ?? iso(project.startsOn);
  const to = opts.to ?? (project.endsOn ? iso(project.endsOn) : today());
  const fromDate = parseDate(from, "from date");
  const toDate = parseDate(to, "to date");
  if (toDate < fromDate) throw new LedgerError("The period ends before it starts.");

  const limit = opts.limit ?? 500;
  const found = await prisma.journalLine.findMany({
    where: {
      orgId: opts.orgId,
      dimensions: { some: { dimensionId: dimension.id, valueId: value.id } },
      entry: {
        entityId: opts.entityId,
        bookId: book.id,
        // A reversed entry's own lines still stand — correction is by mirror
        // entry — exactly as dimensions.ts and statements.ts read them.
        status: { in: ["posted", "reversed"] },
        entryDate: { gte: fromDate, lte: toDate },
      },
    },
    select: {
      lineNo: true,
      memo: true,
      functionalAmountMinor: true,
      account: { select: { code: true, name: true, type: true } },
      entry: { select: { id: true, series: true, number: true, entryDate: true, memo: true, source: true, status: true } },
    },
    orderBy: [{ entry: { entryDate: "asc" } }, { lineNo: "asc" }],
    take: limit + 1,
  });

  const truncated = found.length > limit;
  const listed = truncated ? found.slice(0, limit) : found;

  let running = 0n;
  const lines: ProjectDetailLine[] = listed.map((l) => {
    running += l.functionalAmountMinor;
    return {
      entryId: l.entry.id,
      reference: `${l.entry.series}-${l.entry.number}`,
      date: iso(l.entry.entryDate),
      accountCode: l.account.code,
      accountName: l.account.name,
      accountType: l.account.type,
      memo: l.memo ?? l.entry.memo,
      source: l.entry.source,
      status: l.entry.status,
      debitMinor: (l.functionalAmountMinor > 0n ? l.functionalAmountMinor : 0n).toString(),
      creditMinor: (l.functionalAmountMinor < 0n ? -l.functionalAmountMinor : 0n).toString(),
      runningMinor: running.toString(),
    };
  });

  let revenue = 0n;
  let cost = 0n;
  let other = 0n;
  for (const l of listed) {
    if (l.account.type === "INCOME") revenue -= l.functionalAmountMinor;
    else if (l.account.type === "EXPENSE") cost += l.functionalAmountMinor;
    else other += l.functionalAmountMinor;
  }

  return {
    code,
    name: project.name,
    from,
    to,
    currency: book.functionalCurrency,
    lines,
    truncated,
    totals: truncated
      ? null
      : { revenueMinor: revenue.toString(), costMinor: cost.toString(), otherMinor: other.toString() },
  };
}
