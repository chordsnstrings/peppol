import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import { LedgerError } from "@/lib/server/ledger/post";
import {
  recordCheque, depositCheque, clearCheque, bounceCheque, representCheque,
  returnCheque, cancelCheque, chequeRegister, dueSoon, chequeDetail,
  type ChequeDirection,
} from "@/lib/server/ledger/cheques";

export const runtime = "nodejs";

/**
 * Every cheque read and write is scoped by the session's org *and* by the
 * entity in the request. A cheque id is never authority on its own — the module
 * looks each one up by all three, so an id from another tenant simply does not
 * resolve, and the route never has to remember to check.
 */

/** The register and the diary, or one cheque with its history. */
export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    const q = new URL(req.url).searchParams;

    const entityId = q.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);
    /* The register and the diary are reports. The diary in particular says
     * whether the bank will cover what is dated to be presented, which is a
     * figure anybody reading the books is entitled to see. */
    await requirePermission({ orgId, userId, entityId, permission: "ledger.read" });

    const chequeId = q.get("chequeId");
    if (chequeId) {
      return json(ledgerJson(await chequeDetail({ orgId, entityId, chequeId, asOf: q.get("asOf") ?? undefined })));
    }

    const asOf = q.get("asOf") ?? undefined;
    const days = Number(q.get("days") ?? 30);

    if (q.get("view") === "due") {
      return json(ledgerJson(await dueSoon({ orgId, entityId, asOf, days: Number.isFinite(days) ? days : 30 })));
    }

    // The screen leads with both, and they answer different questions: the
    // register is where the paper is, the diary is what happens next.
    const [register, diary] = await Promise.all([
      chequeRegister({ orgId, entityId, asOf }),
      dueSoon({ orgId, entityId, asOf, days: Number.isFinite(days) ? days : 30 }),
    ]);
    return json(ledgerJson({ register, diary }));
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

/** Record a cheque, or move it one legal step along. */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      action?: "record" | "deposit" | "clear" | "bounce" | "represent" | "return" | "cancel";
      entityId?: string;
      chequeId?: string;
      direction?: ChequeDirection;
      number?: string;
      counterparty?: string;
      counterpartyId?: string | null;
      bankName?: string | null;
      bankAccount?: string;
      writtenOn?: string;
      dueOn?: string;
      amountMinor?: string | number;
      currency?: string;
      settlesId?: string | null;
      note?: string | null;
      on?: string;
      reason?: string;
      reference?: string | null;
      fxRate?: number;
    };

    if (!b.entityId) return json({ error: "entityId required" }, 400);
    const scope = { orgId, entityId: b.entityId };
    const guard = (permission: string) => requirePermission({ orgId, userId, entityId: scope.entityId, permission });

    /*
     * Three different powers share this entry point, so the guards are per
     * action rather than one at the top.
     *
     * Taking a cheque in or handing one over is a settlement: it takes the debt
     * out of trade receivables, or takes ours off the supplier's account. That
     * is the same act as posting a receipt or a payment, so it takes the same
     * key, chosen by the direction of the cheque.
     *
     * Depositing, clearing, bouncing and re-presenting are the bank's news. A
     * deposit raises no journal at all — the paper moved from a drawer to a
     * counter — and the other three are learned from the statement and matched
     * against it, which is what `bank.reconcile` is for. The cashier who banks
     * the cheques and watches them clear should not need the key that raises
     * invoices to record what the bank did.
     *
     * Returning or cancelling the paper unwinds the settlement and puts the
     * debt back on the customer or the supplier, so it goes back to the trade
     * key — and which one depends on the cheque, not on the request, so the
     * direction is read from the register rather than taken from the body.
     */
    if (b.action === "record") {
      if (b.direction === "RECEIVED") await guard("ar.manage");
      else if (b.direction === "ISSUED") await guard("ap.manage");
    } else if (b.action === "deposit" || b.action === "clear" || b.action === "bounce" || b.action === "represent") {
      await guard("bank.reconcile");
    } else if ((b.action === "return" || b.action === "cancel") && b.chequeId) {
      const { cheque } = await chequeDetail({ ...scope, chequeId: b.chequeId });
      await guard(cheque.direction === "RECEIVED" ? "ar.manage" : "ap.manage");
    }

    if (b.action === "record") {
      if (!b.direction || !b.number || !b.counterparty || !b.writtenOn || !b.dueOn || b.amountMinor === undefined) {
        return json(
          { error: "A cheque needs a direction, a number, a counterparty, the date written, the date due and an amount." },
          400,
        );
      }
      return json(ledgerJson(await recordCheque({
        ...scope,
        direction: b.direction,
        number: b.number,
        counterparty: b.counterparty,
        counterpartyId: b.counterpartyId ?? null,
        bankName: b.bankName ?? null,
        bankAccount: b.bankAccount,
        writtenOn: b.writtenOn,
        dueOn: b.dueOn,
        amountMinor: b.amountMinor,
        currency: b.currency,
        settlesId: b.settlesId ?? null,
        note: b.note ?? null,
        fxRate: b.fxRate,
        actorId: userId,
      })));
    }

    if (!b.chequeId) return json({ error: "Which cheque?" }, 400);
    const move = { ...scope, chequeId: b.chequeId, actorId: userId };

    switch (b.action) {
      case "deposit":
        return json(ledgerJson(await depositCheque({ ...move, on: b.on, reference: b.reference ?? null })));

      case "clear":
        if (!b.on) return json({ error: "Which day did the bank pay it?" }, 400);
        return json(ledgerJson(await clearCheque({ ...move, on: b.on, fxRate: b.fxRate })));

      case "bounce":
        if (!b.on) return json({ error: "Which day was it returned unpaid?" }, 400);
        // The reason is deliberately not defaulted here: the subledger refuses
        // an empty one and says why, and a route that invented "returned
        // unpaid" would take that refusal away.
        return json(ledgerJson(await bounceCheque({ ...move, on: b.on, reason: b.reason ?? "", fxRate: b.fxRate })));

      case "represent":
        if (!b.on) return json({ error: "Which day was it presented again?" }, 400);
        return json(ledgerJson(await representCheque({ ...move, on: b.on, note: b.note ?? null, fxRate: b.fxRate })));

      case "return":
        return json(ledgerJson(await returnCheque({ ...move, on: b.on, reason: b.reason ?? null, fxRate: b.fxRate })));

      case "cancel":
        return json(ledgerJson(await cancelCheque({ ...move, on: b.on, reason: b.reason ?? null, fxRate: b.fxRate })));

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
