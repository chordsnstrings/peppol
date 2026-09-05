import { randomUUID } from "node:crypto";
import { requireSession } from "@/lib/server/session";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { prisma } from "@/lib/server/prisma";
import { post, LedgerError, type PostLine } from "@/lib/server/ledger/post";
import { assertApproved } from "@/lib/server/ledger/approvals";
import { requirePermission, PermissionError } from "@/lib/server/ledger/permissions";
import { ledgerJson } from "@/lib/server/ledger/serialize";

export const runtime = "nodejs";

/**
 * How big this journal is, in the book's functional currency.
 *
 * A journal balances, so its debits and its credits are the same number and
 * either of them says how big it is; the debit side is the conventional way to
 * quote it. Lines in another currency are converted at the rate the line
 * carries, because "journals over a hundred thousand need a director" is a
 * sentence about dirhams — adding 100,000 USD to 100,000 AED as though they
 * were the same quantity would let a rule be cleared, or missed, by an accident
 * of which currency somebody keyed. This is the one posting path where that
 * conversion can be done honestly: a bill or a claim has one currency of its
 * own and one recorded approval amount to agree with, while a journal has no
 * document behind it and no face value other than what it posts.
 *
 * The arithmetic is the same scaled-integer multiplication post() uses, for the
 * same reason: a rate is a decimal, and multiplying money by a float loses fils.
 *
 * Every rule here mirrors post()'s own handling of a line, and that is not
 * tidiness — it is the whole security of the thing. A rate is applied ONLY
 * where post() would apply one, which is where the line names a currency other
 * than the book's; a line that names no currency but carries an fxRate of
 * 0.001 posts at its full face value there, and treating the rate as real here
 * would let somebody shrink a journal past a threshold with a field the ledger
 * ignores. Likewise a line whose amount is not a whole number of minor units
 * is skipped rather than guessed at, using the same test post() applies a
 * moment later — so anything skipped here is something post() is about to
 * refuse outright, and no entry reaches the ledger having been mis-sized.
 */
function journalSizeMinor(lines: PostLine[], functionalCurrency: string): bigint {
  const SCALE = 1_000_000_000n;
  let total = 0n;
  for (const l of lines ?? []) {
    const raw = l?.debit;
    if (raw === undefined || raw === null) continue;
    if (typeof raw === "number" && !Number.isInteger(raw)) continue;
    if (typeof raw === "string" && !/^-?\d+$/.test(raw.trim())) continue;
    const amount = BigInt(typeof raw === "string" ? raw.trim() : raw);
    const rate = (l.currency ?? functionalCurrency) === functionalCurrency ? 1 : l.fxRate ?? 0;
    // A foreign line with no usable rate: post() refuses the entry by name a
    // moment later, so counting it at nothing here changes no outcome.
    if (!Number.isFinite(rate) || !(rate > 0)) continue;
    total += rate === 1 ? amount : (amount * BigInt(Math.round(rate * 1e9)) + SCALE / 2n) / SCALE;
  }
  return total;
}

/** Journal register. */
export async function GET(req: Request) {
  try {
    const { orgId, userId } = await requireSession();
    const url = new URL(req.url);
    const entityId = url.searchParams.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);
    /* The journals are the books. This was readable by anybody with a session. */
    await requirePermission({ orgId, userId, entityId, permission: "ledger.read" });
    const take = Math.min(Number(url.searchParams.get("limit") ?? 50), 200);

    const entries = await prisma.journalEntry.findMany({
      where: { orgId, entityId, ...(url.searchParams.get("status") ? { status: String(url.searchParams.get("status")) } : {}) },
      orderBy: [{ entryDate: "desc" }, { number: "desc" }],
      take,
      include: {
        period: { select: { label: true, status: true } },
        lines: { include: { account: { select: { code: true, name: true } } }, orderBy: { lineNo: "asc" } },
      },
    });
    return json(ledgerJson({ entries }));
  } catch (e) {
    return handleError(e);
  }
}

/** Post a manual journal. */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId, userId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as {
      entityId?: string; entryDate?: string; memo?: string; lines?: PostLine[];
      /**
       * The subject the approvals for this journal were collected against.
       * See the guard below for why the client has to name it.
       */
      approvalId?: string;
    };
    if (!b.entityId || !b.entryDate || !Array.isArray(b.lines)) {
      return json({ error: "A journal needs an entity, a date and at least two lines." }, 400);
    }
    await requirePermission({ orgId, userId, entityId: b.entityId, permission: "ledger.post" });

    // The entity's approval rules for journals, enforced before anything is
    // written. Permission and approval are different questions and both have to
    // be answered: `ledger.post` says this person is allowed to post journals at
    // all, and the rules say this particular journal is big enough to need
    // somebody else's signature as well.
    //
    // A manual journal is the one posting path with no document behind it. A
    // bill has an id before it posts and a claim has a row in a table, but this
    // entry does not exist until post() creates it, so there is nothing an
    // approver could have signed. The client therefore names the subject the
    // decisions were recorded against — `approvalId` — and it is the same id
    // that went on the approvals screen.
    //
    // The guard runs whether or not one was given, and that is the part that
    // matters. Where the entity has no journal rule this amount clears,
    // assertApproved returns quietly and the request is unaffected; where it has
    // one, a request that simply left the field out is refused exactly like a
    // request quoting an unapproved reference. Calling the guard only when the
    // field is present would mean the whole control could be walked past by
    // deleting one line of JSON, which is not a control at all.
    //
    // The stand-in id when none is given is random, so it can carry no decision
    // and never will: the guard's answer then depends only on whether a rule
    // applies. A fixed placeholder would be a back door — one decision recorded
    // against that literal string would approve every journal in the org.
    const approvalId = (b.approvalId ?? "").trim();
    // The same book post() will use — PRIMARY, since this route never names
    // another — read only for its functional currency, which is what says
    // whether a line's fxRate means anything. Where there is no book at all
    // post() refuses the entry outright, so the fallback here decides nothing.
    const book = await prisma.book.findFirst({
      where: { orgId, entityId: b.entityId, code: "PRIMARY" },
      select: { functionalCurrency: true },
    });
    try {
      await assertApproved({
        orgId,
        entityId: b.entityId,
        subjectType: "JOURNAL",
        subjectId: approvalId || `unapproved:${randomUUID()}`,
        amountMinor: journalSizeMinor(b.lines, book?.functionalCurrency ?? "AED"),
        reference: approvalId || undefined,
        // The size is already in the book's own currency, so the refusal quotes
        // the amount and the threshold in the same unit — which is exactly what
        // a bill or a claim, held at its foreign face value, cannot do.
        currency: book?.functionalCurrency,
      });
    } catch (e) {
      // The blockers explain what the journal still needs; they cannot explain
      // that this request never said which approvals to look for, because the
      // approvals module was not told one was missing. Somebody who has already
      // collected the signatures and simply posted without quoting them would
      // otherwise be told to go and get approvals they are holding.
      if (e instanceof LedgerError && !approvalId) {
        throw new LedgerError(
          `${e.message} A journal is approved before it is posted: record the decisions on the approvals screen ` +
            `against a reference of your choosing, then post the journal quoting that same reference.`,
        );
      }
      throw e;
    }

    const entry = await post({
      orgId, entityId: b.entityId, entryDate: b.entryDate, memo: b.memo,
      source: "manual", actorType: "HUMAN", actorId: userId, lines: b.lines,
    });
    return json(ledgerJson({ entry }));
  } catch (e) {
    if (e instanceof PermissionError) return json({ error: e.message }, 403);
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
