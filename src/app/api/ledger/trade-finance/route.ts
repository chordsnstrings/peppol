import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import {
  issueFacility, drawFacility, settleFacility, closeFacility,
  contingentLiabilities, facilityRegister, KINDS,
  type NewFacility, type FacilityStatus,
} from "@/lib/server/ledger/trade-finance";

export const runtime = "nodejs";

/** The register, or the IAS 37.86 contingent liabilities note. */
export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    const q = new URL(req.url).searchParams;
    const entityId = q.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);
    /* The facility register and the IAS 37.86 contingent liabilities note are
     * reports over the ledger — `ledger.read`. */
    await requirePermission({ orgId, userId, entityId, permission: "ledger.read" });

    if (q.get("view") === "note") {
      return json(ledgerJson(await contingentLiabilities({
        orgId, entityId, asOf: q.get("asOf") ?? undefined,
      })));
    }

    return json(ledgerJson({
      ...(await facilityRegister({
        orgId, entityId,
        asOf: q.get("asOf") ?? undefined,
        status: (q.get("status") as FacilityStatus) ?? undefined,
      })),
      kinds: KINDS,
    }));
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
      action?: "issue" | "draw" | "settle" | "close";
      entityId?: string;
      facility?: NewFacility;
      reference?: string;
      amountMinor?: string;
      on?: string;
      memo?: string;
      reason?: "expire" | "cancel";
    };
    if (!b.entityId) return json({ error: "entityId required" }, 400);
    /* Letters of credit and guarantees. Issuing one records a contingent
     * liability the note has to disclose; drawing and settling move real money
     * through accounts that belong to no subledger; closing one ends the
     * exposure. That is `ledger.post` — none of the subledger keys covers a
     * bank facility, and all four actions are the same duty. */
    await requirePermission({ orgId, userId, entityId: b.entityId, permission: "ledger.post" });
    const scope = { orgId, entityId: b.entityId, actorId: userId };

    switch (b.action) {
      case "issue":
        if (!b.facility) return json({ error: "There is no facility to open." }, 400);
        return json(ledgerJson(await issueFacility({ ...scope, facility: b.facility })));

      case "draw":
        if (!b.reference || !b.amountMinor || !b.on) return json({ error: "Which facility, how much, and when?" }, 400);
        return json(ledgerJson(await drawFacility({
          ...scope, reference: b.reference, amountMinor: b.amountMinor, drawnOn: b.on, memo: b.memo,
        })));

      case "settle":
        if (!b.reference || !b.amountMinor || !b.on) return json({ error: "Which facility, how much, and when?" }, 400);
        return json(ledgerJson(await settleFacility({
          ...scope, reference: b.reference, amountMinor: b.amountMinor, settledOn: b.on,
        })));

      case "close":
        if (!b.reference || !b.on) return json({ error: "Which facility, and from when?" }, 400);
        return json(ledgerJson(await closeFacility({
          ...scope, reference: b.reference, closedOn: b.on, reason: b.reason,
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
