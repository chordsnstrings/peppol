import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import {
  provisionRegister,
  provisionNote,
  recordProvision,
  remeasure,
  unwindDiscount,
  utilise,
  release,
  promote,
  type ProvisionCategory,
  type ProvisionKind,
} from "@/lib/server/ledger/provisions";
import { ledgerJson } from "@/lib/server/ledger/serialize";

export const runtime = "nodejs";

/**
 * Provisions and contingencies under IAS 37.
 *
 * Every handler passes both the session's org and the request's entity through
 * to the module. The entity id arrives from the client and is never trusted on
 * its own — it is only ever a filter applied inside the caller's org, so a
 * guessed id reads nothing and writes nothing.
 *
 * There is no "edit" verb here on purpose. Everything that changes a provision
 * is an accounting event with a date and a journal — a remeasurement, an
 * unwinding, a utilisation, a release, a promotion — and giving the client a
 * way to patch the carrying amount directly would let the register drift away
 * from the ledger it is reconciled against.
 */

export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    const params = new URL(req.url).searchParams;
    const entityId = params.get("entityId");
    if (!entityId) return json({ error: "entityId is required." }, 400);
    /* The register and the IAS 37.84 movement note are reports over the
     * ledger — `ledger.read`. */
    await requirePermission({ orgId, userId, entityId, permission: "ledger.read" });

    if (params.get("view") === "note") {
      const asOf = params.get("asOf");
      if (!asOf) {
        return json({ error: "asOf is required — the IAS 37.84 note is a movement between two dates." }, 400);
      }
      return json(ledgerJson(await provisionNote({ orgId, entityId, asOf })));
    }

    return json(ledgerJson(await provisionRegister({ orgId, entityId })));
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
      action?: "record" | "remeasure" | "unwind" | "utilise" | "release" | "promote";
      entityId?: string;
      code?: string;
      name?: string;
      category?: ProvisionCategory;
      kind?: ProvisionKind;
      recognisedOn?: string;
      estimateMinor?: string;
      discountRateBps?: number;
      expectedOn?: string | null;
      accountCode?: string;
      expenseAccount?: string;
      note?: string;
      on?: string;
      period?: string;
      amountMinor?: string;
      cashAccount?: string;
      reference?: string;
      reason?: string;
    };
    if (!b.entityId) return json({ error: "entityId is required." }, 400);
    /* Every action here is an accounting event with a date and a journal —
     * recognising, remeasuring, unwinding, utilising, releasing, promoting —
     * and a provision belongs to no subledger, so none of the subledger keys
     * reach it. `ledger.post` is "put entries into the ledger by hand", which
     * is what all six are. One guard, because no action among them lets
     * somebody do less than the others: releasing a provision writes profit
     * back just as recognising one writes it away. */
    await requirePermission({ orgId, userId, entityId: b.entityId, permission: "ledger.post" });

    switch (b.action) {
      case "record": {
        if (!b.code || !b.name || !b.recognisedOn || b.estimateMinor === undefined) {
          return json(
            { error: "A provision needs a code, a name, the date it arose, and the best estimate of the outflow." },
            400,
          );
        }
        return json(ledgerJson(await recordProvision({
          orgId, entityId: b.entityId,
          code: b.code, name: b.name,
          category: b.category, kind: b.kind,
          recognisedOn: b.recognisedOn,
          estimateMinor: b.estimateMinor,
          discountRateBps: b.discountRateBps,
          // An empty date field is "no expected date", not the epoch.
          expectedOn: b.expectedOn ? b.expectedOn : null,
          accountCode: b.accountCode,
          expenseAccount: b.expenseAccount,
          note: b.note,
          actorId: userId,
        })));
      }

      case "remeasure":
        if (!b.code || !b.on || b.estimateMinor === undefined) {
          return json({ error: "A remeasurement needs the provision, the date, and the current best estimate." }, 400);
        }
        return json(ledgerJson(await remeasure({
          orgId, entityId: b.entityId, code: b.code, on: b.on,
          estimateMinor: b.estimateMinor, note: b.note, actorId: userId,
        })));

      case "unwind":
        if (!b.code || !b.period) return json({ error: "Which provision, and which month?" }, 400);
        return json(ledgerJson(await unwindDiscount({
          orgId, entityId: b.entityId, code: b.code, period: b.period,
          actorType: "HUMAN", actorId: userId,
        })));

      case "utilise":
        if (!b.code || !b.on || !b.amountMinor) {
          return json({ error: "Charging a provision needs the provision, the date, and the amount." }, 400);
        }
        return json(ledgerJson(await utilise({
          orgId, entityId: b.entityId, code: b.code, on: b.on,
          amountMinor: b.amountMinor, cashAccount: b.cashAccount,
          reference: b.reference, note: b.note, actorId: userId,
        })));

      case "release":
        if (!b.code || !b.on) return json({ error: "A release needs the provision and the date." }, 400);
        return json(ledgerJson(await release({
          orgId, entityId: b.entityId, code: b.code, on: b.on,
          reason: b.reason ?? "", actorId: userId,
        })));

      case "promote":
        if (!b.code || !b.on) {
          return json(
            { error: "A promotion needs the provision and the date the outflow became probable (IAS 37.30)." },
            400,
          );
        }
        return json(ledgerJson(await promote({
          orgId, entityId: b.entityId, code: b.code, on: b.on, actorId: userId,
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
