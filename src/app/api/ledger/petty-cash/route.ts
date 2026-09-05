import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import { LedgerError } from "@/lib/server/ledger/post";
import {
  openFund, recordSpend, reimburse, returnCash, closeFund,
  fundList, fundDetail,
} from "@/lib/server/ledger/petty-cash";

export const runtime = "nodejs";

/**
 * Every petty cash read and write is scoped by the session's org *and* by the
 * entity in the request. A fund id is never authority on its own — the module
 * looks the fund up by all three, so an id from another tenant simply does not
 * resolve.
 */

/** The floats and whether they reconcile, or one float with its movements. */
export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    const q = new URL(req.url).searchParams;

    const entityId = q.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);
    /* Whether each float still reconciles — cash plus receipts against the
     * float — is a report, and it is one more people should read, not fewer. */
    await requirePermission({ orgId, userId, entityId, permission: "ledger.read" });

    const fundId = q.get("fundId");
    if (fundId) return json(ledgerJson(await fundDetail({ orgId, entityId, fundId })));

    const status = q.get("status");
    return json(ledgerJson(await fundList({
      orgId,
      entityId,
      status: status === "active" || status === "closed" ? status : undefined,
    })));
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

/** Open a float, record a receipt, reimburse it, take cash back, or close it. */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      action?: "open" | "spend" | "reimburse" | "return" | "close";
      entityId?: string;
      fundId?: string;
      code?: string;
      name?: string;
      custodian?: string;
      floatMinor?: string | number;
      accountCode?: string;
      currency?: string;
      openedOn?: string;
      movedOn?: string;
      description?: string;
      amountMinor?: string | number;
      vatMinor?: string | number;
      supplierTrn?: string | null;
      receiptRef?: string | null;
      bankAccount?: string;
      reason?: string;
      fxRate?: number;
    };

    if (!b.entityId) return json({ error: "entityId required" }, 400);

    /*
     * The split follows the bank, because that is what actually differs here.
     *
     * Opening a float, reimbursing it and taking cash back all move money in or
     * out of the bank account — Cr bank for the advance, Cr bank for the exact
     * total of the receipts, Dr bank for what the custodian hands back — and
     * every one of them lands on the statement as a line somebody has to match.
     * Closing a float ends that arrangement. They are the cashier's work, so
     * they take `bank.reconcile`: it is the key the shipped Cashier role holds,
     * and reimbursing is the moment somebody other than the custodian looks at
     * the receipts, which is the only real control a tin has.
     *
     * Recording a receipt is the one action that touches neither the bank nor
     * the ledger — under the imprest treatment it stays in the subledger until
     * the float is reimbursed. What it is, is a small purchase with input tax
     * on it, refused unless the supplier's TRN is a real one, so it takes the
     * purchase-ledger key. `bank.reconcile` would be wrong for it precisely
     * because no money moves.
     */
    const key = b.action === "spend" ? "ap.manage" : "bank.reconcile";
    await requirePermission({ orgId, userId, entityId: b.entityId, permission: key });

    switch (b.action) {
      case "open":
        if (!b.code || !b.name || !b.custodian || b.floatMinor === undefined) {
          return json({ error: "A float needs a code, a name, a custodian and an amount." }, 400);
        }
        return json(ledgerJson(await openFund({
          orgId, entityId: b.entityId,
          code: b.code, name: b.name, custodian: b.custodian, floatMinor: b.floatMinor,
          accountCode: b.accountCode, currency: b.currency, openedOn: b.openedOn,
          bankAccount: b.bankAccount, fxRate: b.fxRate, actorId: userId,
        })));

      case "spend":
        // The date is asked for rather than defaulted to today. A receipt has a
        // date printed on it, and it is often not the day it is keyed — the
        // custodian empties their wallet on Sunday — so inventing one here
        // would put the spend in the wrong week, and at a month end in the
        // wrong month. `recordSpend` refuses a movement with no date for the
        // same reason; this says so before the round trip.
        if (!b.fundId || !b.description || b.amountMinor === undefined || !b.movedOn) {
          return json({ error: "Which fund, what was bought, how much, and on what date?" }, 400);
        }
        return json(ledgerJson(await recordSpend({
          orgId, entityId: b.entityId, fundId: b.fundId,
          movedOn: b.movedOn,
          description: b.description,
          amountMinor: b.amountMinor,
          accountCode: b.accountCode,
          vatMinor: b.vatMinor,
          supplierTrn: b.supplierTrn,
          receiptRef: b.receiptRef,
        })));

      case "reimburse":
        if (!b.fundId) return json({ error: "Which fund?" }, 400);
        // The amount is deliberately not a parameter: an imprest float is
        // restored by the exact total of its receipts, never by an amount the
        // client names.
        return json(ledgerJson(await reimburse({
          orgId, entityId: b.entityId, fundId: b.fundId,
          movedOn: b.movedOn, bankAccount: b.bankAccount, fxRate: b.fxRate, actorId: userId,
        })));

      case "return":
        if (!b.fundId || b.amountMinor === undefined) return json({ error: "Which fund, and how much came back?" }, 400);
        return json(ledgerJson(await returnCash({
          orgId, entityId: b.entityId, fundId: b.fundId, amountMinor: b.amountMinor,
          movedOn: b.movedOn, bankAccount: b.bankAccount, reason: b.reason, fxRate: b.fxRate, actorId: userId,
        })));

      case "close":
        if (!b.fundId) return json({ error: "Which fund?" }, 400);
        return json(ledgerJson(await closeFund({ orgId, entityId: b.entityId, fundId: b.fundId })));

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
