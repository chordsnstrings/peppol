import { requireSession } from "@/lib/server/session";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import { LedgerError } from "@/lib/server/ledger/post";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import {
  creditControlRegister, creditStanding, creditCheck, statementOfAccount,
  dunningPlan, dunningLetter, dunningHistory, recordDunning,
  setCreditLimit, creditLimitHistory,
  placeCreditHold, releaseCreditHold, creditHoldHistory,
  type DunningStage,
} from "@/lib/server/ledger/credit-control";

export const runtime = "nodejs";

/**
 * Credit control over HTTP.
 *
 * Every read here is a different way of looking at the same receivables, so
 * they are one GET with a `view` rather than seven endpoints that would drift
 * apart the first time the open-item key changed.
 *
 * The credit check is a GET on purpose. It is a question — it reads the ledger,
 * answers, and changes nothing — and making it a POST would suggest that asking
 * it does something, which is exactly the misunderstanding that leads to a
 * check being skipped because "it might record a refusal".
 *
 * The writes are the three that matter, and each carries a reason the domain
 * demands rather than this route: setting a limit, placing or releasing a hold,
 * and recording that a letter went out. Nothing here sends anything — there is
 * no mail transport in this product, and `recordDunning` records that a person
 * sent it.
 */
export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    const q = new URL(req.url).searchParams;
    const entityId = q.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);
    /* Exposure, ageing, holds and the dunning ladder are all read from the
     * sales ledger. Placing a hold is `ar.credit_hold`, and it is elsewhere. */
    await requirePermission({ orgId, userId, entityId, permission: "ledger.read" });
    const scope = { orgId, entityId };
    const asOf = q.get("asOf") ?? undefined;
    const partyKey = q.get("partyKey") ?? q.get("code");
    const days = q.get("pastDueDays");
    // "0" is a real threshold — anything past due at all — so only an absent or
    // explicitly empty parameter means "use the default", and "none" turns the
    // test off. Reading a missing value as nought would silently refuse every
    // customer with a single day's lateness.
    const pastDueDays =
      days === null || days === "" ? undefined : days === "none" ? null : Number(days);

    switch (q.get("view")) {
      case "standing": {
        if (!partyKey) return json({ error: "Which customer?" }, 400);
        return json(ledgerJson(await creditStanding({ ...scope, partyKey, asOf })));
      }

      case "check": {
        if (!partyKey) return json({ error: "Which customer?" }, 400);
        return json(ledgerJson(await creditCheck({
          ...scope, partyKey, asOf, pastDueDays,
          additionalMinor: q.get("additionalMinor") ?? 0,
        })));
      }

      case "statement": {
        if (!partyKey) return json({ error: "Which customer's statement?" }, 400);
        return json(ledgerJson(await statementOfAccount({
          ...scope, partyKey, asOf, from: q.get("from") ?? undefined,
        })));
      }

      case "dunning": {
        const cool = q.get("cooloffDays");
        return json(ledgerJson(await dunningPlan({
          ...scope, asOf, cooloffDays: cool === null || cool === "" ? undefined : Number(cool),
        })));
      }

      case "letter": {
        if (!partyKey) return json({ error: "Which customer?" }, 400);
        return json(ledgerJson(await dunningLetter({
          ...scope, partyKey, asOf,
          stage: (q.get("stage") as DunningStage) ?? undefined,
          from: q.get("from") ?? undefined,
        })));
      }

      case "history": {
        if (!partyKey) return json({ error: "Which customer?" }, 400);
        // One request rather than three, because the three answer one question:
        // what has been decided about this account, and when.
        const [limits, holds, notices] = await Promise.all([
          creditLimitHistory({ ...scope, partyKey }),
          creditHoldHistory({ ...scope, partyKey }),
          dunningHistory({ ...scope, partyKey }),
        ]);
        return json(ledgerJson({
          code: limits.code, name: limits.name, currency: limits.currency,
          limits: limits.limits, holds: holds.holds, notices: notices.notices,
        }));
      }

      default:
        return json(ledgerJson(await creditControlRegister({
          ...scope, asOf, pastDueDays,
          includeArchived: q.get("includeArchived") === "1",
        })));
    }
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      action?: "setLimit" | "hold" | "release" | "recordDunning";
      entityId?: string;
      partyKey?: string;
      reason?: string;
      basis?: string;
      limitMinor?: string | number;
      effectiveFrom?: string;
      on?: string;
      sentOn?: string;
      sentTo?: string;
      stage?: DunningStage;
      from?: string;
    };
    if (!b.entityId) return json({ error: "entityId required" }, 400);
    const scope = { orgId, entityId: b.entityId };
    if (!b.partyKey) return json({ error: "Which customer?" }, 400);
    const partyKey = b.partyKey;

    switch (b.action) {
      // A limit is part of managing the sales ledger, and the permission
      // catalogue already says so — inventing a second permission for it would
      // be a way around the first.
      case "setLimit": {
        await requirePermission({ orgId, userId, entityId: b.entityId, permission: "ar.manage" });
        if (b.limitMinor === undefined) return json({ error: "How much is the limit?" }, 400);
        return json(ledgerJson(await setCreditLimit({
          ...scope, partyKey,
          limitMinor: b.limitMinor,
          effectiveFrom: b.effectiveFrom,
          basis: b.basis ?? "",
          actorId: userId,
        })));
      }

      // Holding and releasing is its own permission, because stopping a sale
      // and raising an invoice are different powers held by different people.
      case "hold": {
        await requirePermission({ orgId, userId, entityId: b.entityId, permission: "ar.credit_hold" });
        return json(ledgerJson(await placeCreditHold({
          ...scope, partyKey, reason: b.reason ?? "", on: b.on, actorId: userId,
        })));
      }

      case "release": {
        await requirePermission({ orgId, userId, entityId: b.entityId, permission: "ar.credit_hold" });
        return json(ledgerJson(await releaseCreditHold({
          ...scope, partyKey, reason: b.reason ?? "", on: b.on, actorId: userId,
        })));
      }

      case "recordDunning": {
        await requirePermission({ orgId, userId, entityId: b.entityId, permission: "ar.manage" });
        return json(ledgerJson(await recordDunning({
          ...scope, partyKey, stage: b.stage, sentTo: b.sentTo, sentOn: b.sentOn,
          from: b.from, actorId: userId,
        })));
      }

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
