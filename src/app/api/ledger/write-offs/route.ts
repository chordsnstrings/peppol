import { requireSession } from "@/lib/server/session";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import { ledgerJson } from "@/lib/server/ledger/serialize";
import {
  writeOffsView, writeOffReceivable, adjustWriteOffVat, reverseWriteOff, type WriteOffAgainst,
} from "@/lib/server/ledger/write-offs";

export const runtime = "nodejs";

/** What may be written off, what has been, and how much allowance is carried. */
export async function GET(req: Request) {
  try {
    const { orgId } = await requireSession();
    const q = new URL(req.url).searchParams;
    const entityId = q.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);
    return json(ledgerJson(await writeOffsView({ orgId, entityId, asOf: q.get("asOf") ?? undefined })));
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
      action?: "writeOff" | "adjustVat" | "reverse";
      entityId?: string;
      documentId?: string;
      writeOffId?: string;
      amountMinor?: string;
      vatMinor?: string;
      writtenOffOn?: string;
      notifiedOn?: string;
      adjustedOn?: string;
      reversedOn?: string;
      against?: WriteOffAgainst;
      reason?: string;
    };
    if (!b.entityId) return json({ error: "entityId required" }, 400);
    const scope = { orgId, entityId: b.entityId, actorId: userId };

    switch (b.action) {
      case "writeOff":
        if (!b.documentId) return json({ error: "Which debt is being written off?" }, 400);
        if (!b.writtenOffOn) return json({ error: "A write-off needs the date it is written off on." }, 400);
        return json(ledgerJson(await writeOffReceivable({
          ...scope,
          documentId: b.documentId,
          // Minor units cross the wire as decimal strings, never as numbers.
          amountMinor: b.amountMinor === undefined || b.amountMinor === "" ? undefined : BigInt(b.amountMinor),
          vatMinor: b.vatMinor === undefined || b.vatMinor === "" ? undefined : BigInt(b.vatMinor),
          writtenOffOn: b.writtenOffOn,
          reason: b.reason ?? "",
          against: b.against,
          notifiedOn: b.notifiedOn || null,
        })));

      case "adjustVat":
        if (!b.writeOffId && !b.documentId) return json({ error: "Which write-off?" }, 400);
        return json(ledgerJson(await adjustWriteOffVat({
          ...scope,
          writeOffId: b.writeOffId,
          documentId: b.writeOffId ? undefined : b.documentId,
          notifiedOn: b.notifiedOn || undefined,
          adjustedOn: b.adjustedOn || undefined,
        })));

      case "reverse":
        if (!b.writeOffId && !b.documentId) return json({ error: "Which write-off?" }, 400);
        return json(ledgerJson(await reverseWriteOff({
          ...scope,
          writeOffId: b.writeOffId,
          documentId: b.writeOffId ? undefined : b.documentId,
          reversedOn: b.reversedOn || undefined,
          reason: b.reason,
        })));

      default:
        return json({ error: "Unknown action." }, 400);
    }
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    // A minor-unit string that is not a whole number reaches BigInt() as a
    // SyntaxError, which would otherwise be reported as an internal fault.
    if (e instanceof SyntaxError) return json({ error: "Amounts must be whole minor units." }, 400);
    return handleError(e);
  }
}
