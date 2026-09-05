import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import {
  addEmployee,
  updateEmployee,
  runPayroll,
  postPayroll,
  payPayroll,
  settleEndOfService,
  wpsFile,
  payrollSummary,
  type NewEmployee,
  type EmployeeChanges,
  type PayrollEntry,
} from "@/lib/server/ledger/payroll";

export const runtime = "nodejs";

/** The month's payslips, the employee register, and the ledger balances both have to agree with. */
export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    const url = new URL(req.url);
    const entityId = url.searchParams.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);
    /* Salaries are not a general read. The shipped VIEWER role's own
     * description says so, and a Viewer could call this. Nor are they a read
     * that travels between companies: seeing one entity's payroll is not
     * authority over a sister company's, so the grant has to name this one. */
    await requirePermission({ orgId, userId, entityId, permission: "payroll.read" });
    // Absent a month, the current one is the only defensible default — payroll
    // is a monthly cycle and "now" is the month somebody is looking at.
    const period = url.searchParams.get("period") ?? new Date().toISOString().slice(0, 7);
    return json(await payrollSummary({ orgId, entityId, period }));
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

/**
 * Everything that changes something: the employee register, the monthly run and
 * its two postings, an end-of-service settlement, and the bank file.
 *
 * The WPS file comes back as text in JSON rather than as a download, so the
 * caller can show the operator what is about to reach the bank before it does.
 */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      action?: "add-employee" | "update-employee" | "run" | "post" | "pay" | "settle" | "wps";
      entityId?: string;
      employee?: NewEmployee;
      employeeCode?: string;
      changes?: EmployeeChanges;
      period?: string;
      entries?: PayrollEntry[];
      postingDate?: string;
      paidOn?: string;
      bankAccount?: string;
      deductionAccount?: string;
      leftOn?: string;
      settlementAccount?: string;
      employerId?: string;
      employerAgentId?: string;
    };
    if (!b.entityId) return json({ error: "entityId required" }, 400);
    /* Running, posting and paying a payroll, and settling a leaver — for the
     * one employer named in the body, which is why the guard waits for it. */
    await requirePermission({ orgId, userId, entityId: b.entityId, permission: "payroll.run" });

    switch (b.action) {
      case "add-employee": {
        if (!b.employee?.code || !b.employee?.name || !b.employee?.joinedOn) {
          return json({ error: "An employee needs a code, a name and the date they joined." }, 400);
        }
        const e = await addEmployee({ orgId, entityId: b.entityId, employee: b.employee });
        return json({ employee: { id: e.id, code: e.code, name: e.name } });
      }

      case "update-employee": {
        if (!b.employeeCode) return json({ error: "Which employee?" }, 400);
        const e = await updateEmployee({
          orgId, entityId: b.entityId, employeeCode: b.employeeCode, changes: b.changes ?? {},
        });
        return json({ employee: { id: e.id, code: e.code, name: e.name } });
      }

      case "run":
        if (!b.period) return json({ error: "Which month?" }, 400);
        return json(await runPayroll({
          orgId, entityId: b.entityId, period: b.period, entries: b.entries, actorId: userId,
        }));

      case "post":
        if (!b.period) return json({ error: "Which month?" }, 400);
        return json(await postPayroll({
          orgId, entityId: b.entityId, period: b.period,
          postingDate: b.postingDate, deductionAccount: b.deductionAccount, actorId: userId,
        }));

      case "pay":
        if (!b.period) return json({ error: "Which month?" }, 400);
        return json(await payPayroll({
          orgId, entityId: b.entityId, period: b.period,
          paidOn: b.paidOn, bankAccount: b.bankAccount, actorId: userId,
        }));

      case "settle":
        if (!b.employeeCode || !b.leftOn) {
          return json({ error: "A settlement needs the employee and the date they left." }, 400);
        }
        return json(await settleEndOfService({
          orgId, entityId: b.entityId, employeeCode: b.employeeCode, leftOn: b.leftOn,
          settlementAccount: b.settlementAccount, actorId: userId,
        }));

      case "wps":
        if (!b.period) return json({ error: "Which month?" }, 400);
        return json(await wpsFile({
          orgId, entityId: b.entityId, period: b.period,
          employerId: b.employerId, employerAgentId: b.employerAgentId,
        }));

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
