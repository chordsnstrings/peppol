import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import {
  declareRelatedParty, endRelationship, declareCompensation, attest, assessNotRelated,
  relatedPartyNote, RELATIONSHIPS, COMP_CATEGORIES,
  type Relationship, type CompCategory,
} from "@/lib/server/ledger/related-parties";

export const runtime = "nodejs";

/** The IAS 24 note for a period, with its own completeness attached. */
export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    const q = new URL(req.url).searchParams;
    const entityId = q.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);
    /* The IAS 24 note is part of the financial statements, and `ledger.read`
     * is "see the chart, the journals, the statements and every report".
     *
     * The one thing that gave pause: the note carries key management
     * compensation, and where the headcount is one that figure is one
     * person's pay — which is a genuine argument for `payroll.read`. It is not
     * the argument taken here, because this note exists to be published in the
     * accounts, and a Viewer who may read the accounts may read the note that
     * goes out with them. If the module ever grew a per-person breakdown that
     * the note does not publish, that would flip. */
    await requirePermission({ orgId, userId, entityId, permission: "ledger.read" });

    const period = q.get("period") ?? String(new Date().getUTCFullYear());
    const from = q.get("from") ?? `${period}-01-01`;
    const to = q.get("to") ?? `${period}-12-31`;

    return json(ledgerJson({
      ...(await relatedPartyNote({ orgId, entityId, period, from, to })),
      relationships: RELATIONSHIPS,
      categories: COMP_CATEGORIES,
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
      action?: "declare" | "end" | "compensation" | "attest" | "assess";
      entityId?: string;
      party?: {
        partyKey: string; name?: string; relationship: Relationship;
        declaredBy: string; declaredOn?: string; startedOn: string; endedOn?: string | null; notes?: string;
      };
      assessment?: {
        partyKey: string; name?: string; assessedBy: string; assessedOn?: string; notes?: string;
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
    /* Declaring a related party, assessing one as unrelated, ending a
     * relationship, recording key management compensation and attesting the
     * note all write the IAS 24 disclosure that goes out with the statutory
     * accounts. No journal is posted, so no key fits exactly; `ledger.post` is
     * the closest the catalogue has — the power to write something the
     * accounts will assert. A `disclosure.manage` is the key I would have
     * wanted.
     *
     * `compensation` was considered for a payroll key and left with the rest.
     * The figure is a published aggregate compiled by whoever prepares the
     * note, and requiring `payroll.run` would move the accounts' own
     * disclosure into the hands of the payroll operator instead of the
     * accountant who writes it. */
    await requirePermission({ orgId, userId, entityId: b.entityId, permission: "ledger.post" });
    const scope = { orgId, entityId: b.entityId };

    switch (b.action) {
      case "declare":
        if (!b.party) return json({ error: "There is nothing to declare." }, 400);
        return json(ledgerJson({ party: await declareRelatedParty({ ...scope, party: b.party }) }));

      // Assessed and not related. It writes no disclosure and asserts no
      // relationship — it only records that somebody looked, so the note can
      // tell an answered question from an unasked one.
      case "assess":
        if (!b.assessment?.partyKey) return json({ error: "Which party?" }, 400);
        return json(ledgerJson({ assessment: await assessNotRelated({ ...scope, party: b.assessment }) }));

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
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
