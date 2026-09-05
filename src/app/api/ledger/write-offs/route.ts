import { requireSession } from "@/lib/server/session";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
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
    const { orgId, userId } = await requireSession();
    const q = new URL(req.url).searchParams;
    const entityId = q.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);
    /* What could be written off, what has been, and the allowance carried
     * against it — all of it is the ledger, read. */
    await requirePermission({ orgId, userId, entityId, permission: "ledger.read" });
    return json(ledgerJson(await writeOffsView({ orgId, entityId, asOf: q.get("asOf") ?? undefined })));
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
    const guard = (permission: string) => requirePermission({ orgId, userId, entityId: scope.entityId, permission });

    switch (b.action) {
      /*
       * Writing a receivable off takes `ar.manage`, and the other candidate was
       * `ledger.post`.
       *
       * `ledger.post` is wrong twice over. It is wrong in fact — 1100 is a
       * control account and post() refuses one on a manual journal, so nobody
       * can write a debt off with that key however much of it they hold; this
       * subledger exists precisely because the manual route is closed. And it
       * is wrong in principle: derecognising a customer's debt is a decision
       * about that customer's account, taken by whoever runs the sales ledger
       * and chases them, not a bookkeeping entry. It is the same key that
       * raised the invoice, which is the right symmetry — the person who can
       * put a debt on the account is the person who can take it off.
       */
      case "writeOff":
        await guard("ar.manage");
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

      /*
       * The tax is a separate act, and it takes a separate key.
       *
       * This is not part of writing the debt off — the module is emphatic that
       * it is a second decision with its own date, taken only once the customer
       * has been notified and six months have passed. What it does is reclaim
       * output tax already paid to the FTA under Article 64(1), which lands on
       * the next return. That is the return-preparer's decision, so it takes
       * the key that covers the return. `ar.manage` was the other candidate and
       * it is the weaker one: it would let anybody who may write a debt off
       * also decide what the business claims back from the authority.
       */
      case "adjustVat":
        await guard("tax.file");
        if (!b.writeOffId && !b.documentId) return json({ error: "Which write-off?" }, 400);
        return json(ledgerJson(await adjustWriteOffVat({
          ...scope,
          writeOffId: b.writeOffId,
          documentId: b.writeOffId ? undefined : b.documentId,
          notifiedOn: b.notifiedOn || undefined,
          adjustedOn: b.adjustedOn || undefined,
        })));

      /* Reversing puts the debt back on the customer's account — the same
       * power as taking it off, so the same key. */
      case "reverse":
        await guard("ar.manage");
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
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    // A minor-unit string that is not a whole number reaches BigInt() as a
    // SyntaxError, which would otherwise be reported as an internal fault.
    if (e instanceof SyntaxError) return json({ error: "Amounts must be whole minor units." }, 400);
    return handleError(e);
  }
}
