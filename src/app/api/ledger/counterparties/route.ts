import { requireSession } from "@/lib/server/session";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import { LedgerError } from "@/lib/server/ledger/post";
import {
  createCounterparty, updateCounterparty, archiveCounterparty, restoreCounterparty,
  placeOnHold, releaseHold, counterpartyStatement, creditStatus, dunningList,
  checkCreditBeforeSale, listCounterparties,
  type NewCounterparty, type CounterpartyChange,
} from "@/lib/server/ledger/counterparties";

export const runtime = "nodejs";

/**
 * Counterparties and credit control over HTTP.
 *
 * Every read is a different way of looking at the same receivables, so they are
 * one GET with a `view` rather than four endpoints that could drift apart: the
 * list, one customer's statement, one customer's credit standing, and the
 * collections list.
 *
 * Nothing in this route posts anything, and the one call that could be mistaken
 * for an action — the credit check — is a GET precisely because it is a
 * question. Holds are the only writes that touch credit control, and each of
 * them demands a reason.
 */
export async function GET(req: Request) {
  try {
    const { orgId } = await requireSession();
    const q = new URL(req.url).searchParams;
    const entityId = q.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);
    const scope = { orgId, entityId };
    const asOf = q.get("asOf") ? new Date(q.get("asOf") as string) : undefined;
    const code = q.get("code");

    switch (q.get("view")) {
      case "statement": {
        if (!code) return json({ error: "Which customer's statement?" }, 400);
        return json(ledgerJson(await counterpartyStatement({
          ...scope, code,
          from: q.get("from") ?? undefined,
          to: q.get("to") ?? undefined,
        })));
      }

      case "credit": {
        if (!code) return json({ error: "Which customer?" }, 400);
        return json(ledgerJson(await creditStatus({ ...scope, code, asOf })));
      }

      case "dunning": {
        const min = q.get("minAgeDays");
        return json(ledgerJson(await dunningList({
          ...scope, asOf,
          minAgeDays: min === null ? undefined : Number(min),
        })));
      }

      case "check": {
        // A question, not an act: it reads the ledger and answers, and the
        // caller decides what to do with the answer.
        if (!code) return json({ error: "Which customer?" }, 400);
        const amount = q.get("amountMinor");
        if (!amount) return json({ error: "How much is the sale?" }, 400);
        return json(ledgerJson(await checkCreditBeforeSale({ ...scope, code, amountMinor: amount, asOf })));
      }

      default:
        return json(ledgerJson(await listCounterparties({
          ...scope, asOf,
          includeArchived: q.get("includeArchived") === "1",
          kind: q.get("kind") ?? undefined,
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
      action?: "create" | "update" | "archive" | "restore" | "hold" | "release";
      entityId?: string;
      code?: string;
      reason?: string;
      counterparty?: NewCounterparty;
      change?: CounterpartyChange;
    };
    if (!b.entityId) return json({ error: "entityId required" }, 400);
    const scope = { orgId, entityId: b.entityId };

    switch (b.action) {
      case "create":
        if (!b.counterparty) return json({ error: "There is no counterparty to create." }, 400);
        return json(ledgerJson({ counterparty: await createCounterparty({ ...scope, counterparty: b.counterparty }) }));

      case "update":
        if (!b.code || !b.change) return json({ error: "Which counterparty, and what change?" }, 400);
        return json(ledgerJson({ counterparty: await updateCounterparty({ ...scope, code: b.code, change: b.change }) }));

      case "archive":
        if (!b.code) return json({ error: "Which counterparty?" }, 400);
        return json(ledgerJson({ counterparty: await archiveCounterparty({ ...scope, code: b.code }) }));

      case "restore":
        if (!b.code) return json({ error: "Which counterparty?" }, 400);
        return json(ledgerJson({ counterparty: await restoreCounterparty({ ...scope, code: b.code }) }));

      // The reason is required by the domain rather than checked here, so the
      // rule holds for every caller and not only for this route.
      case "hold":
        if (!b.code) return json({ error: "Which counterparty?" }, 400);
        return json(ledgerJson(await placeOnHold({ ...scope, code: b.code, reason: b.reason ?? "", actorId: userId })));

      case "release":
        if (!b.code) return json({ error: "Which counterparty?" }, 400);
        return json(ledgerJson(await releaseHold({ ...scope, code: b.code, reason: b.reason ?? "", actorId: userId })));

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
