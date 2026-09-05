import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import {
  leaveRegister,
  leaveBalance,
  leaveRecords,
  recordLeave,
  encashLeave,
  provisionForPeriod,
  type LeaveKind,
} from "@/lib/server/ledger/leave";
import { ledgerJson } from "@/lib/server/ledger/serialize";

export const runtime = "nodejs";

/**
 * Annual leave, and the untaken-leave provision on 2260.
 *
 * Every handler passes both the session's org and the request's entity through
 * to the module. The entity id arrives from the client and is never trusted on
 * its own — it is only ever a filter applied inside the caller's org, so a
 * guessed id reads nothing and writes nothing.
 *
 * There is no verb here for editing a leave record. A record is what happened;
 * a mistaken one is a different problem from a changed one, and letting the
 * client patch `daysTenth` would move a balance that a posted provision has
 * already been measured against.
 */

export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    const params = new URL(req.url).searchParams;
    const entityId = params.get("entityId");
    if (!entityId) return json({ error: "entityId is required." }, 400);
    /* Leave is payroll data, so `payroll.read` and not `ledger.read`.
     *
     * The register does not merely list absences. It values every employee's
     * untaken days at their CURRENT wage, row by row, because Article 29(3)
     * says that is what they would be paid — so divide one person's provision
     * by their days and you have their daily rate, and from that their salary.
     * The shipped VIEWER role says in as many words that "salaries are not a
     * general read", and a Viewer holding `ledger.read` could read the whole
     * payroll off this one screen.
     *
     * It costs something real. Under the shipped roles the accountant who
     * reconciles account 2260 does not hold `payroll.read` and will be refused
     * until somebody grants it. That is the better of the two mistakes: a
     * refusal names itself and says who can fix it, whereas a workspace
     * quietly publishing its salaries says nothing at all. */
    await requirePermission({ orgId, userId, entityId, permission: "payroll.read" });

    // Absent a date, today: leave is earned every day, so "now" is the only
    // date a reader who did not name one can have meant.
    const asOf = params.get("asOf") ?? new Date().toISOString().slice(0, 10);
    const code = params.get("code");

    if (params.get("view") === "balance") {
      if (!code) return json({ error: "Which employee?" }, 400);
      return json(ledgerJson(await leaveBalance({ orgId, entityId, code, asOf })));
    }

    const [register, records] = await Promise.all([
      leaveRegister({ orgId, entityId, asOf }),
      leaveRecords({ orgId, entityId, code: code ?? undefined }),
    ]);
    return json(ledgerJson({ ...register, records }));
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      action?: "record" | "encash" | "provision";
      entityId?: string;
      code?: string;
      kind?: LeaveKind;
      startsOn?: string;
      endsOn?: string;
      daysTenth?: number;
      paid?: boolean;
      note?: string;
      on?: string;
      paymentAccount?: string;
      period?: string;
      expenseAccount?: string;
    };
    if (!b.entityId) return json({ error: "entityId is required." }, 400);
    /* `encash` pays leave out at the employee's wage and `provision` measures
     * the whole workforce's untaken leave at theirs and posts it to salary
     * cost on 6000 — calculating and posting pay, which is `payroll.run` word
     * for word.
     *
     * `record` has the narrower key it wanted. Writing down that somebody was
     * away last week names no money at all, and `payroll.run` — "calculate and
     * post a payroll, including end-of-service" — meant an office manager
     * keeping the leave register had to be given the power to pay everybody.
     * `leave.record` still is not nothing, and its own effect says why: a leave
     * record moves the balance the provision and the encashment are computed
     * from, so it moves a payroll figure at one remove. That is a reason to
     * name the act, not a reason to hand over the payroll to do it. */
    const key = b.action === "record" ? "leave.record" : "payroll.run";
    await requirePermission({ orgId, userId, entityId: b.entityId, permission: key });

    switch (b.action) {
      case "record":
        if (!b.code || !b.startsOn || !b.endsOn) {
          return json({ error: "A leave record needs the employee, the first day and the last day." }, 400);
        }
        return json(ledgerJson(await recordLeave({
          orgId, entityId: b.entityId, code: b.code, kind: b.kind,
          startsOn: b.startsOn, endsOn: b.endsOn,
          // An empty days field means "count the calendar days", not nil days.
          daysTenth: b.daysTenth === undefined || b.daysTenth === null ? undefined : b.daysTenth,
          paid: b.paid, note: b.note,
        })));

      case "encash":
        if (!b.code || !b.on || b.daysTenth === undefined) {
          return json(
            { error: "Paying leave out needs the employee, the date, and how many days are being bought back." },
            400,
          );
        }
        return json(ledgerJson(await encashLeave({
          orgId, entityId: b.entityId, code: b.code,
          daysTenth: b.daysTenth, on: b.on,
          paymentAccount: b.paymentAccount, note: b.note, actorId: userId,
        })));

      case "provision":
        if (!b.period) return json({ error: "Which month?" }, 400);
        return json(ledgerJson(await provisionForPeriod({
          orgId, entityId: b.entityId, period: b.period,
          expenseAccount: b.expenseAccount, actorId: userId,
        })));

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
