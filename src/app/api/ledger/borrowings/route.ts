import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import { LedgerError } from "@/lib/server/ledger/post";
import {
  addBorrowing, drawDown, postInstalment, reclassifyCurrentPortion,
  borrowingRegister, borrowingSchedule, maturityAnalysis,
  addCovenant, testCovenants,
  type NewBorrowing, type NewCovenant,
} from "@/lib/server/ledger/borrowings";

export const runtime = "nodejs";

/**
 * Every read and write is scoped by the session's org AND by the entity in the
 * request, and the module looks each facility up by all three — so a code from
 * another tenant simply does not resolve, and the route never has to remember
 * to check.
 */

/**
 * The register with its maturity analysis; or one facility's amortisation
 * table; or the covenant tests; or the IFRS 7 note on its own.
 */
export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    const q = new URL(req.url).searchParams;

    const entityId = q.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);
    /* The register, the maturity analysis, one facility's schedule and the
     * covenant tests are all reports over the ledger — `ledger.read`. A
     * breached covenant is something the people who read the accounts need to
     * see, not a secret from them. */
    await requirePermission({ orgId, userId, entityId, permission: "ledger.read" });
    const asOf = q.get("asOf") ?? new Date().toISOString().slice(0, 10);

    const code = q.get("code");
    if (code) return json(ledgerJson(await borrowingSchedule({ orgId, entityId, code })));

    const view = q.get("view");
    if (view === "maturity") return json(ledgerJson(await maturityAnalysis({ orgId, entityId, asOf })));
    if (view === "covenants") {
      return json(ledgerJson(await testCovenants({ orgId, entityId, asOf, from: q.get("from") ?? undefined })));
    }
    return json(ledgerJson(await borrowingRegister({ orgId, entityId, asOf })));
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

/**
 * Record a facility, draw it, post an instalment, split the current portion, or
 * record a covenant.
 */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      action?: "add" | "draw" | "instalment" | "reclassify" | "covenant";
      entityId?: string;
      borrowing?: NewBorrowing;
      covenant?: NewCovenant;
      code?: string;
      instalmentNo?: number;
      paidOn?: string;
      receivedOn?: string;
      asOf?: string;
      cashAccount?: string;
    };
    if (!b.entityId) return json({ error: "entityId required" }, 400);
    /* Drawing a facility, posting an instalment and splitting the current
     * portion are journals into accounts no subledger owns, so `ledger.post`.
     *
     * `add` and `covenant` write no journal by themselves and were considered
     * for something lighter. They are guarded with the rest because a
     * facility's rate and schedule decide every instalment that follows it,
     * and a covenant is the test the register reports against — guarding the
     * postings while leaving the numbers behind them open would be guarding
     * the wrong end. */
    await requirePermission({ orgId, userId, entityId: b.entityId, permission: "ledger.post" });
    const scope = { orgId, entityId: b.entityId };

    switch (b.action) {
      case "add": {
        if (!b.borrowing?.code || !b.borrowing?.lender || !b.borrowing?.drawdownOn) {
          return json({ error: "A facility needs a code, the lender, and the date it is drawn." }, 400);
        }
        const created = await addBorrowing({ ...scope, borrowing: b.borrowing });
        return json(ledgerJson({
          borrowing: {
            code: created.code, lender: created.lender, status: created.status,
            instalmentMinor: created.instalmentMinor, effectiveRateBps: created.effectiveRateBps,
          },
        }));
      }

      case "draw":
        if (!b.code) return json({ error: "Which facility?" }, 400);
        return json(ledgerJson(await drawDown({
          ...scope, code: b.code, receivedOn: b.receivedOn,
          cashAccount: b.cashAccount, actorId: userId,
        })));

      case "instalment":
        if (!b.code || !b.instalmentNo) {
          return json({ error: "An instalment needs the facility and which instalment it is." }, 400);
        }
        return json(ledgerJson(await postInstalment({
          ...scope, code: b.code, instalmentNo: Number(b.instalmentNo),
          paidOn: b.paidOn, cashAccount: b.cashAccount, actorId: userId,
        })));

      case "reclassify":
        if (!b.asOf) return json({ error: "A split needs the reporting date it is measured at." }, 400);
        return json(ledgerJson(await reclassifyCurrentPortion({ ...scope, asOf: b.asOf, actorId: userId })));

      case "covenant":
        if (!b.covenant?.borrowingCode || !b.covenant?.code) {
          return json({ error: "A covenant needs the facility it belongs to and a code of its own." }, 400);
        }
        return json(ledgerJson({ covenant: await addCovenant({ ...scope, covenant: b.covenant }) }));

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
