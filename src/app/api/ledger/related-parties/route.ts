import { requireSession } from "@/lib/server/session";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import {
  declareRelatedParty, endRelationship, declareCompensation, attest,
  relatedPartyNote, RELATIONSHIPS, COMP_CATEGORIES,
  type Relationship, type CompCategory,
} from "@/lib/server/ledger/related-parties";

export const runtime = "nodejs";

/** The IAS 24 note for a period, with its own completeness attached. */
export async function GET(req: Request) {
  try {
    const { orgId } = await requireSession();
    const q = new URL(req.url).searchParams;
    const entityId = q.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);

    const period = q.get("period") ?? String(new Date().getUTCFullYear());
    const from = q.get("from") ?? `${period}-01-01`;
    const to = q.get("to") ?? `${period}-12-31`;

    return json(ledgerJson({
      ...(await relatedPartyNote({ orgId, entityId, period, from, to })),
      relationships: RELATIONSHIPS,
      categories: COMP_CATEGORIES,
    }));
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      action?: "declare" | "end" | "compensation" | "attest";
      entityId?: string;
      party?: {
        partyKey: string; name?: string; relationship: Relationship;
        declaredBy: string; declaredOn?: string; startedOn: string; endedOn?: string | null; notes?: string;
      };
      id?: string;
      endedOn?: string;
      period?: string;
      category?: CompCategory;
      amountMinor?: string;
      headcount?: number;
      declaredBy?: string;
      attestedBy?: string;
      attestedOn?: string;
      parentName?: string | null;
      ultimateControllingParty?: string | null;
      noControllingParty?: boolean;
      notes?: string;
    };
    if (!b.entityId) return json({ error: "entityId required" }, 400);
    const scope = { orgId, entityId: b.entityId };

    switch (b.action) {
      case "declare":
        if (!b.party) return json({ error: "There is nothing to declare." }, 400);
        return json(ledgerJson({ party: await declareRelatedParty({ ...scope, party: b.party }) }));

      case "end":
        if (!b.id || !b.endedOn) return json({ error: "Which declaration, and from what date?" }, 400);
        return json(ledgerJson({ party: await endRelationship({ ...scope, id: b.id, endedOn: b.endedOn }) }));

      case "compensation":
        if (!b.period || !b.category) return json({ error: "Which period, and which category?" }, 400);
        return json(ledgerJson({
          row: await declareCompensation({
            ...scope, period: b.period, category: b.category,
            amountMinor: b.amountMinor ?? "0", headcount: b.headcount ?? 0,
            declaredBy: b.declaredBy ?? "",
          }),
        }));

      case "attest":
        if (!b.period) return json({ error: "Which period?" }, 400);
        return json(ledgerJson({
          attestation: await attest({
            ...scope, period: b.period,
            attestedBy: b.attestedBy ?? "",
            attestedOn: b.attestedOn,
            parentName: b.parentName,
            ultimateControllingParty: b.ultimateControllingParty,
            noControllingParty: b.noControllingParty,
            notes: b.notes,
          }),
        }));

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
