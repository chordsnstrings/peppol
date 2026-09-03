import { requireSession } from "@/lib/server/session";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import {
  addLease, activateLease, runLeasePeriod, payLease, leaseRegister, leaseSchedule,
  type NewLease, type Exemption,
} from "@/lib/server/ledger/leases";

export const runtime = "nodejs";

/**
 * The lease register, with the ledger balances it should agree with — or, when
 * a lease code is given, that lease's amortisation table.
 */
export async function GET(req: Request) {
  try {
    const { orgId } = await requireSession();
    const params = new URL(req.url).searchParams;
    const entityId = params.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);

    const leaseCode = params.get("leaseCode");
    if (leaseCode) return json(await leaseSchedule({ orgId, entityId, leaseCode }));
    return json(await leaseRegister({ orgId, entityId }));
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

/** Record a lease, commence it, charge a month, or record a payment. */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      action?: "add" | "activate" | "run" | "pay";
      entityId?: string;
      lease?: NewLease;
      leaseCode?: string;
      exempt?: Exemption | "";
      period?: string;
      paidOn?: string;
      amountMinor?: string;
      cashAccount?: string;
    };
    if (!b.entityId) return json({ error: "entityId required" }, 400);

    switch (b.action) {
      case "add": {
        if (!b.lease?.code || !b.lease?.name || !b.lease?.startsOn || !b.lease?.endsOn) {
          return json({ error: "A lease needs a code, a name, and the dates it runs between." }, 400);
        }
        const lease = await addLease({ orgId, entityId: b.entityId, lease: b.lease });
        return json({ lease: { id: lease.id, code: lease.code, name: lease.name, status: lease.status } });
      }

      case "activate":
        if (!b.leaseCode) return json({ error: "Which lease?" }, 400);
        return json(await activateLease({
          orgId, entityId: b.entityId, leaseCode: b.leaseCode,
          // An empty string is the "no exemption" option in the form; it must
          // not reach the elector as a truthy value.
          exempt: b.exempt ? b.exempt : undefined,
          actorId: userId,
        }));

      case "run":
        if (!b.period) return json({ error: "Which month?" }, 400);
        return json(await runLeasePeriod({
          orgId, entityId: b.entityId, period: b.period,
          actorType: "HUMAN", actorId: userId,
        }));

      case "pay":
        if (!b.leaseCode || !b.period) {
          return json({ error: "A lease payment needs the lease and the month it settles." }, 400);
        }
        return json(await payLease({
          orgId, entityId: b.entityId, leaseCode: b.leaseCode, period: b.period,
          paidOn: b.paidOn, amountMinor: b.amountMinor, cashAccount: b.cashAccount,
          actorId: userId,
        }));

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
