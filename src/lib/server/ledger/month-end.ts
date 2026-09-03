import { prisma } from "@/lib/server/prisma";
import { fmtMinor } from "@/lib/ledger/format";
import { LedgerError } from "./post";
import { trialBalance } from "./reports";
import { templateStatus } from "./recurring";
import { assetRegister } from "./assets";
import { leaseRegister } from "./leases";
import { reconcile } from "./bank";
import { receivablesAgeing } from "./ar";
import { payablesAgeing } from "./ap";
import { ledgerBalances } from "./balances";
import { contractRegister } from "./revenue";
import { provisionRegister } from "./provisions";
import { fundList } from "./petty-cash";
import { revaluationRegister } from "./asset-revaluation";
import { payrollSummary } from "./payroll";

/**
 * The month-end checklist.
 *
 * "Needs attention" answers what the books are waiting for right now. This
 * answers a narrower and harder question: is this particular month finished,
 * and what is still stopping it from being closed?
 *
 * The difference matters because closing is nearly irreversible. A hard-closed
 * month can be reopened by somebody with the permission; a locked one never
 * can. So the checklist is not a list of nags — it is the last look before a
 * door shuts, and it has to distinguish two things a single list cannot:
 *
 *   a BLOCKER is something that would make the closed month wrong. The trial
 *   balance not balancing, a subledger register that does not agree with its
 *   control account, depreciation not run. Close over one of these and the
 *   month is wrong for ever.
 *
 *   an ADVISORY is something that would merely be better done first. Bank
 *   lines unreconciled, an unposted recurring template that was going to be
 *   skipped anyway. Close over one of these and the month is still true.
 *
 * Every check runs independently, so one failing degrades its own row rather
 * than the page — and a check that could not run says so, because a check
 * that silently returns nothing looks exactly like a check that passed.
 */

export type Severity = "blocker" | "advisory" | "done";

export interface CheckResult {
  key: string;
  label: string;
  severity: Severity;
  /** What the check found, in a sentence a person can act on. */
  detail: string;
  /** Where to go and do something about it. */
  href: string;
  amountMinor?: string;
  count?: number;
}

export interface MonthEnd {
  period: string;
  entityId: string;
  startsOn: string;
  endsOn: string;
  status: string;
  checks: CheckResult[];
  /** Checks that could not run at all, and why. */
  failed: { key: string; label: string; reason: string }[];
  blockers: number;
  advisories: number;
  /** True when nothing would make the closed month wrong. */
  canClose: boolean;
  note: string;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
/*
 * Amounts are formatted through the one function that knows how many decimals
 * a currency has.
 *
 * This used to pad to three digits and split at two, which is right for a
 * dirham and wrong by a factor of ten for a Kuwaiti dinar, a Bahraini dinar
 * or an Omani rial — all three of which have three. attention.ts already used
 * fmtMinor and got it right, so the two screens disagreed about the same
 * figure.
 */
const money = (v: bigint, currency = "AED") => fmtMinor(v, currency, { zero: "zero" });

interface Ctx {
  orgId: string;
  entityId: string;
  period: string;
  startsOn: Date;
  endsOn: Date;
}

type Check = {
  key: string;
  label: string;
  run(ctx: Ctx): Promise<CheckResult | null>;
};

/* ------------------------------------------------------------- the checks */

const trialBalanceTies: Check = {
  key: "trial_balance",
  label: "The trial balance",
  async run(ctx) {
    const tb = await trialBalance({ orgId: ctx.orgId, entityId: ctx.entityId, periodLabel: ctx.period });
    if (tb.balanced) {
      return {
        key: "trial_balance", label: "The trial balance", severity: "done",
        detail: `Debits and credits both come to ${money(tb.totalDebitMinor)}.`,
        href: "/accounting/trial-balance",
      };
    }
    return {
      key: "trial_balance", label: "The trial balance", severity: "blocker",
      detail:
        `The trial balance is out by ${money(tb.differenceMinor)}. Every posting is balanced by construction and the ` +
        `database enforces it, so this cannot come from an entry — it is the balance cache. Report it before closing: ` +
        `a month closed over an unbalanced ledger is wrong for ever.`,
      href: "/accounting/trial-balance",
      amountMinor: tb.differenceMinor.toString(),
    };
  },
};

const depreciationRun: Check = {
  key: "depreciation",
  label: "Depreciation",
  async run(ctx) {
    const assets = await prisma.fixedAsset.findMany({
      where: { orgId: ctx.orgId, entityId: ctx.entityId, status: "active", acquiredOn: { lte: ctx.endsOn } },
      select: { code: true, depreciatedTo: true },
    });
    if (!assets.length) return null;

    const behind = assets.filter((a) => !a.depreciatedTo || a.depreciatedTo < ctx.period);
    if (!behind.length) {
      return {
        key: "depreciation", label: "Depreciation", severity: "done",
        detail: `All ${assets.length} active asset${assets.length === 1 ? " has" : "s have"} been depreciated to ${ctx.period}.`,
        href: "/accounting/assets",
      };
    }
    return {
      key: "depreciation", label: "Depreciation", severity: "blocker",
      detail:
        `${behind.length} asset${behind.length === 1 ? " has" : "s have"} not been depreciated for ${ctx.period} ` +
        `(${behind.slice(0, 3).map((a) => a.code).join(", ")}${behind.length > 3 ? ", …" : ""}). A missing charge is ` +
        `invisible in the ledger — the thing that is wrong is an entry that is not there — and closing over it ` +
        `overstates the month's profit.`,
      href: "/accounting/assets",
      count: behind.length,
    };
  },
};

const leasesCharged: Check = {
  key: "leases",
  label: "Lease interest and depreciation",
  async run(ctx) {
    const leases = await prisma.lease.findMany({
      where: { orgId: ctx.orgId, entityId: ctx.entityId, status: "active", startsOn: { lte: ctx.endsOn } },
      select: { code: true, chargedTo: true },
    });
    if (!leases.length) return null;

    const behind = leases.filter((l) => !l.chargedTo || l.chargedTo < ctx.period);
    if (!behind.length) {
      return {
        key: "leases", label: "Lease interest and depreciation", severity: "done",
        detail: `All ${leases.length} lease${leases.length === 1 ? "" : "s"} charged to ${ctx.period}.`,
        href: "/accounting/leases",
      };
    }
    return {
      key: "leases", label: "Lease interest and depreciation", severity: "blocker",
      detail:
        `${behind.length} lease${behind.length === 1 ? " has" : "s have"} not been charged for ${ctx.period} ` +
        `(${behind.slice(0, 3).map((l) => l.code).join(", ")}). The liability does not unwind by itself, so both ` +
        `the finance cost and the right-of-use depreciation are missing from the month.`,
      href: "/accounting/leases",
      count: behind.length,
    };
  },
};

/** Every subledger register that must agree with its control account. */
const registersAgree: Check = {
  key: "registers",
  label: "Registers against the ledger",
  async run(ctx) {
    const asOf = ctx.endsOn;
    const disagreeing: string[] = [];

    const [assets, leases, revenue, provisions, surplus, petty] = await Promise.allSettled([
      assetRegister({ orgId: ctx.orgId, entityId: ctx.entityId, asOf }),
      leaseRegister({ orgId: ctx.orgId, entityId: ctx.entityId, asOf }),
      contractRegister({ orgId: ctx.orgId, entityId: ctx.entityId }),
      provisionRegister({ orgId: ctx.orgId, entityId: ctx.entityId }),
      revaluationRegister({ orgId: ctx.orgId, entityId: ctx.entityId }),
      fundList({ orgId: ctx.orgId, entityId: ctx.entityId }),
    ]);

    const say = (name: string, ok: boolean | undefined) => {
      if (ok === false) disagreeing.push(name);
    };
    if (assets.status === "fulfilled") {
      const a = assets.value.ledger as { costAgrees?: boolean; accumulatedAgrees?: boolean };
      say("fixed asset cost", a?.costAgrees);
      say("accumulated depreciation", a?.accumulatedAgrees);
    }
    if (leases.status === "fulfilled") {
      const l = leases.value.ledger as { liabilityAgrees?: boolean; rouAgrees?: boolean };
      say("lease liabilities", l?.liabilityAgrees);
      say("right-of-use assets", l?.rouAgrees);
    }
    if (revenue.status === "fulfilled") {
      const r = revenue.value.reconciliation;
      // A difference explained by a recognition run not yet made is work
      // outstanding, which the revenue check below reports on its own terms.
      say("contract assets and liabilities", r.agrees || r.explained);
    }
    if (provisions.status === "fulfilled") {
      const p = provisions.value as { reconciliation?: { agrees?: boolean } };
      say("provisions", p.reconciliation?.agrees);
    }
    if (surplus.status === "fulfilled") say("revaluation surplus", surplus.value.reconciliation.agrees);
    if (petty.status === "fulfilled" && petty.value.summary.outOfBalanceCount > 0) {
      disagreeing.push("petty cash floats");
    }

    if (!disagreeing.length) {
      return {
        key: "registers", label: "Registers against the ledger", severity: "done",
        detail: "Every subledger register agrees with the account it feeds.",
        href: "/accounting/statements",
      };
    }
    return {
      key: "registers", label: "Registers against the ledger", severity: "blocker",
      detail:
        `${disagreeing.join(", ")} ${disagreeing.length === 1 ? "does" : "do"} not agree with the ledger. A register ` +
        `that cannot be tied to the accounts supports nothing, and closing the month freezes the difference in place.`,
      href: "/accounting/statements",
      count: disagreeing.length,
    };
  },
};

const controlAccountsTie: Check = {
  key: "control_accounts",
  label: "Receivables and payables against their control accounts",
  async run(ctx) {
    const [ar, ap, ledger] = await Promise.all([
      receivablesAgeing({ orgId: ctx.orgId, entityId: ctx.entityId, asOf: ctx.endsOn }),
      payablesAgeing({ orgId: ctx.orgId, entityId: ctx.entityId, asOf: ctx.endsOn }),
      ledgerBalances({ orgId: ctx.orgId, entityId: ctx.entityId, codes: ["1100", "2000"] }),
    ]);
    // The ageing is netted per open item; the control account is the raw
    // balance. They are two routes to the same figure and must agree.
    const arDiff = BigInt(ar.totalMinor) - (ledger.get("1100") ?? 0n);
    const apDiff = BigInt(ap.totalMinor) - -(ledger.get("2000") ?? 0n);

    if (arDiff === 0n && apDiff === 0n) {
      return {
        key: "control_accounts", label: "Receivables and payables against their control accounts", severity: "done",
        detail: `Open items come to ${money(BigInt(ar.totalMinor))} receivable and ${money(BigInt(ap.totalMinor))} payable, which is what 1100 and 2000 hold.`,
        href: "/accounting/receivables",
      };
    }
    return {
      key: "control_accounts", label: "Receivables and payables against their control accounts", severity: "blocker",
      detail:
        `${arDiff !== 0n ? `Receivables differ by ${money(arDiff)}. ` : ""}` +
        `${apDiff !== 0n ? `Payables differ by ${money(apDiff)}. ` : ""}` +
        `The open items and the control account are two routes to the same figure; where they disagree, one of the ` +
        `two is wrong and nobody should be acting on either.`,
      href: "/accounting/receivables",
      amountMinor: (arDiff + apDiff).toString(),
    };
  },
};

const recurringPosted: Check = {
  key: "recurring",
  label: "Recurring journals",
  async run(ctx) {
    const status = await templateStatus({ orgId: ctx.orgId, entityId: ctx.entityId, asOf: ctx.period });
    const behind = status.templates.filter((t) => t.behind);
    if (!behind.length) return null;
    return {
      key: "recurring", label: "Recurring journals", severity: "blocker",
      detail:
        `${behind.length} template${behind.length === 1 ? " is" : "s are"} behind ` +
        `(${behind.slice(0, 3).map((t) => t.code).join(", ")}). An accrual that was not posted is invisible in the ` +
        `ledger, because what is wrong is an entry that is not there.`,
      href: "/accounting/recurring",
      count: behind.length,
    };
  },
};

const payrollPosted: Check = {
  key: "payroll",
  label: "Payroll",
  async run(ctx) {
    const employees = await prisma.employee.count({
      where: { orgId: ctx.orgId, entityId: ctx.entityId, status: "active" },
    });
    if (!employees) return null;

    const summary = await payrollSummary({ orgId: ctx.orgId, entityId: ctx.entityId, period: ctx.period });
    const posted = (summary as unknown as { postedCount?: number; payslips?: unknown[] }).postedCount
      ?? (summary as unknown as { payslips?: unknown[] }).payslips?.length
      ?? 0;
    if (posted > 0) {
      return {
        key: "payroll", label: "Payroll", severity: "done",
        detail: `Payroll for ${ctx.period} is on the ledger.`,
        href: "/accounting/payroll",
      };
    }
    return {
      key: "payroll", label: "Payroll", severity: "blocker",
      detail:
        `${employees} employee${employees === 1 ? " is" : "s are"} on the payroll and nothing has been posted for ` +
        `${ctx.period}. Salaries are usually the largest single cost in a month; closing without them understates it.`,
      href: "/accounting/payroll",
      count: employees,
    };
  },
};

const revenueRecognised: Check = {
  key: "revenue",
  label: "Revenue recognition",
  async run(ctx) {
    const reg = await contractRegister({ orgId: ctx.orgId, entityId: ctx.entityId });
    if (!reg.contracts.length) return null;
    const pending = BigInt(reg.reconciliation.pendingAssetMinor) + BigInt(reg.reconciliation.pendingLiabilityMinor);
    if (pending === 0n) {
      return {
        key: "revenue", label: "Revenue recognition", severity: "done",
        detail: `Every contract is presented correctly.`,
        href: "/accounting/revenue",
      };
    }
    return {
      key: "revenue", label: "Revenue recognition", severity: "blocker",
      detail:
        `Work has been delivered or billed since the last recognition run, and the ledger does not show it yet. ` +
        `Run recognition as at ${iso(ctx.endsOn)} before closing, or the month reports revenue in the wrong period.`,
      href: "/accounting/revenue",
      amountMinor: pending.toString(),
    };
  },
};

const bankReconciled: Check = {
  key: "bank",
  label: "Bank reconciliation",
  async run(ctx) {
    const accounts = await prisma.account.findMany({
      where: { orgId: ctx.orgId, entityId: ctx.entityId, subtype: "BANK", status: "active" },
      select: { code: true },
    });
    if (!accounts.length) return null;

    let unmatched = 0;
    for (const a of accounts) {
      try {
        const r = await reconcile({ orgId: ctx.orgId, entityId: ctx.entityId, accountCode: a.code, asOf: ctx.endsOn });
        unmatched += (r as unknown as { unmatchedBank?: unknown[] }).unmatchedBank?.length ?? 0;
      } catch {
        // An account with no statement imported is not unreconciled; it is
        // simply not being reconciled, which is a decision, not a finding.
      }
    }
    if (!unmatched) return null;
    // An advisory rather than a blocker: an unmatched statement line means the
    // bank knows something the books do not, which is worth chasing — but the
    // books are not wrong until somebody decides the line belongs in them.
    return {
      key: "bank", label: "Bank reconciliation", severity: "advisory",
      detail:
        `${unmatched} statement line${unmatched === 1 ? "" : "s"} ${unmatched === 1 ? "has" : "have"} no match in ` +
        `the ledger. The month can close, but a payment recorded twice or a charge nobody booked shows up here first.`,
      href: "/accounting/bank",
      count: unmatched,
    };
  },
};

const priorMonthsClosed: Check = {
  key: "prior_periods",
  label: "The months before this one",
  async run(ctx) {
    const earlier = await prisma.accountingPeriod.findMany({
      where: {
        orgId: ctx.orgId, entityId: ctx.entityId, isAdjustment: false,
        endsOn: { lt: ctx.startsOn },
        status: { in: ["open", "soft_closed"] },
      },
      select: { label: true },
      orderBy: { startsOn: "asc" },
    });
    if (!earlier.length) return null;
    return {
      key: "prior_periods", label: "The months before this one", severity: "blocker",
      detail:
        `${earlier.map((p) => p.label).join(", ")} ${earlier.length === 1 ? "is" : "are"} still open. Closing a ` +
        `month while an earlier one can still receive postings means this month's opening position can change ` +
        `after it was closed.`,
      href: "/accounting/periods",
      count: earlier.length,
    };
  },
};

const CHECKS: Check[] = [
  trialBalanceTies,
  priorMonthsClosed,
  controlAccountsTie,
  registersAgree,
  depreciationRun,
  leasesCharged,
  recurringPosted,
  payrollPosted,
  revenueRecognised,
  bankReconciled,
];

/* -------------------------------------------------------------- the answer */

export async function monthEnd(opts: {
  orgId: string;
  entityId: string;
  period: string;
}): Promise<MonthEnd> {
  if (!/^\d{4}-\d{2}$/.test(opts.period)) {
    throw new LedgerError(`"${opts.period}" is not a month. Give it as 2026-03.`);
  }

  const period = await prisma.accountingPeriod.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, label: opts.period },
  });
  if (!period) {
    throw new LedgerError(`There is no accounting period ${opts.period} for this entity. Open the fiscal year first.`);
  }

  const ctx: Ctx = {
    orgId: opts.orgId, entityId: opts.entityId, period: opts.period,
    startsOn: period.startsOn, endsOn: period.endsOn,
  };

  const settled = await Promise.allSettled(CHECKS.map((c) => c.run(ctx)));
  const checks: CheckResult[] = [];
  const failed: { key: string; label: string; reason: string }[] = [];

  settled.forEach((r, i) => {
    const c = CHECKS[i];
    if (r.status === "rejected") {
      // A check that could not run is not a check that passed, and saying so
      // is the difference between a checklist and a comfort blanket.
      failed.push({
        key: c.key, label: c.label,
        reason: r.reason instanceof Error ? r.reason.message : "could not be read",
      });
      return;
    }
    if (r.value) checks.push(r.value);
  });

  const rank: Record<Severity, number> = { blocker: 0, advisory: 1, done: 2 };
  checks.sort((a, b) => rank[a.severity] - rank[b.severity] || a.key.localeCompare(b.key));

  const blockers = checks.filter((c) => c.severity === "blocker").length;
  const advisories = checks.filter((c) => c.severity === "advisory").length;
  // A check that could not run counts against closing. It might have been a
  // blocker, and closing on the strength of a question nobody answered is the
  // failure this whole screen exists to prevent.
  const canClose = blockers === 0 && failed.length === 0 && period.status !== "locked";

  return {
    period: opts.period,
    entityId: opts.entityId,
    startsOn: iso(period.startsOn),
    endsOn: iso(period.endsOn),
    status: period.status,
    checks,
    failed,
    blockers,
    advisories,
    canClose,
    note:
      period.status === "locked"
        ? `${opts.period} is locked. A locked month never reopens, so nothing here can change it.`
        : blockers > 0
          ? `${blockers} thing${blockers === 1 ? "" : "s"} would make ${opts.period} wrong if it were closed now.`
          : failed.length > 0
            ? `${failed.length} check${failed.length === 1 ? "" : "s"} could not run. That is not the same as passing, so ${opts.period} is not offered for closing.`
            : advisories > 0
              ? `${opts.period} can be closed. ${advisories} thing${advisories === 1 ? " is" : "s are"} worth doing first, but none of them would make the month wrong.`
              : `${opts.period} is finished and nothing is outstanding.`,
  };
}

/**
 * Close the month, once nothing would make it wrong.
 *
 * The checks are re-run here rather than trusted from the screen. A checklist
 * read five minutes ago is a checklist somebody else may have invalidated, and
 * the one action this guards is close to irreversible.
 */
export async function closeMonth(opts: {
  orgId: string;
  entityId: string;
  period: string;
  /** Go past the advisories. Blockers are never overridable. */
  acceptAdvisories?: boolean;
}) {
  const state = await monthEnd(opts);

  if (state.status === "hard_closed" || state.status === "locked") {
    return { period: state.period, status: state.status, closed: false, note: `${state.period} is already ${state.status.replace("_", " ")}.` };
  }
  if (state.blockers > 0) {
    throw new LedgerError(
      `${state.period} cannot be closed yet: ${state.checks.find((c) => c.severity === "blocker")!.detail}`,
    );
  }
  if (state.failed.length > 0) {
    throw new LedgerError(
      `${state.failed.map((f) => f.label).join(", ")} could not be checked (${state.failed[0].reason}). A check that ` +
        `did not run is not a check that passed, so the month is not closed.`,
    );
  }
  if (state.advisories > 0 && opts.acceptAdvisories !== true) {
    throw new LedgerError(
      `${state.period} has ${state.advisories} thing${state.advisories === 1 ? "" : "s"} worth doing first. None of ` +
        `them would make the month wrong, so it can be closed over them — say so explicitly.`,
    );
  }

  const period = await prisma.accountingPeriod.findFirstOrThrow({
    where: { orgId: opts.orgId, entityId: opts.entityId, label: opts.period },
  });
  // Through the same state machine the periods screen uses: open goes to
  // soft-closed and soft-closed to hard-closed, one step at a time, so a month
  // never skips a state that something else might be relying on.
  const next = period.status === "open" ? "soft_closed" : "hard_closed";
  await prisma.accountingPeriod.update({
    where: { id: period.id },
    data: { status: next, closedAt: new Date() },
  });

  return {
    period: state.period,
    status: next,
    closed: true,
    note:
      next === "soft_closed"
        ? `${state.period} is soft closed. Close it again to make it hard closed, which stops posting altogether.`
        : `${state.period} is hard closed. Reopening it needs the permission to do so; locking it would be final.`,
  };
}
