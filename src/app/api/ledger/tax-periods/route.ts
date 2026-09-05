import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import {
  getRegistration,
  outstandingReturns,
  recordFiling,
  recordRegistration,
  taxPeriodsBetween,
  type TaxFrequency,
  type TaxRegime,
} from "@/lib/server/ledger/tax-periods";

export const runtime = "nodejs";

/**
 * The entity's tax registration, the periods it implies, and what is
 * outstanding.
 *
 * Nothing here talks to EmaraTax. The POST records that a human filed a return;
 * it does not file one, and the distinction is the whole reason the module
 * exists — "is this filed" was previously answered by inferring it from whether
 * a month had been closed.
 */

export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    const url = new URL(req.url);
    const entityId = url.searchParams.get("entityId");
    if (!entityId) return json({ error: "entityId is required." }, 400);
    /* The registration, its periods and what has been filed. Recording a
     * filing is `tax.file`, on the POST. */
    await requirePermission({ orgId, userId, entityId, permission: "ledger.read" });
    const regime = (url.searchParams.get("regime") ?? "VAT") as TaxRegime;
    const asOf = url.searchParams.get("asOf") ?? undefined;

    const registration = await getRegistration({ orgId, entityId, regime });
    const outstanding = await outstandingReturns({
      orgId,
      entityId,
      regime,
      ...(asOf ? { asOf } : {}),
      ...(url.searchParams.get("since") ? { since: url.searchParams.get("since")! } : {}),
    });

    // The periods over a range, so a screen can offer the registrant's own
    // periods in a picker instead of the calendar quarters that were only ever
    // right for one stagger in three. Absent a range, nothing is derived: a
    // guessed range would be the same mistake one level up.
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const periods = registration && from && to ? taxPeriodsBetween(registration, from, to) : [];

    return json(ledgerJson({ registration, periods, outstanding }));
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
      action?: string;
      entityId?: string;
      regime?: TaxRegime;
      // register
      trn?: string | null;
      frequency?: TaxFrequency;
      firstPeriodEndMonth?: number | string;
      registeredOn?: string | null;
      deregisteredOn?: string | null;
      // file
      periodLabel?: string;
      filedOn?: string;
      reference?: string;
      netVatMinor?: string;
      notes?: string;
    };
    if (!b.entityId) return json({ error: "entityId is required." }, 400);

    /* Recording a registration decides which periods every return is filed for,
       and recording a filing is the statement that one went. Both are the "file
       returns" duty. */
    await requirePermission({ orgId, userId, entityId: b.entityId, permission: "tax.file" });

    if (b.action === "register") {
      if (!b.frequency || b.firstPeriodEndMonth === undefined || b.firstPeriodEndMonth === null) {
        return json(
          { error: "A registration needs a frequency and the month its first tax period ends in." },
          400,
        );
      }
      return json(
        ledgerJson(
          await recordRegistration({
            orgId,
            entityId: b.entityId,
            regime: b.regime,
            trn: b.trn,
            frequency: b.frequency,
            firstPeriodEndMonth: Number(b.firstPeriodEndMonth),
            registeredOn: b.registeredOn,
            deregisteredOn: b.deregisteredOn,
          }),
        ),
      );
    }

    if (b.action === "file") {
      if (!b.periodLabel) {
        return json({ error: "A filing needs the tax period it covers." }, 400);
      }
      return json(
        ledgerJson(
          await recordFiling({
            orgId,
            entityId: b.entityId,
            regime: b.regime,
            periodLabel: b.periodLabel,
            filedOn: b.filedOn,
            // Who said it went. Taken from the session rather than the body:
            // a filing somebody else's name is on is a filing nobody signed.
            filedBy: userId,
            reference: b.reference,
            netVatMinor: b.netVatMinor,
            notes: b.notes,
          }),
        ),
      );
    }

    return json({ error: 'action must be "register" or "file".' }, 400);
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
