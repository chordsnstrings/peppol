import { requireSession } from "@/lib/server/session";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { LedgerError } from "@/lib/server/ledger/post";
import { prisma } from "@/lib/server/prisma";

export const runtime = "nodejs";

/** The chart of accounts for an entity. */
export async function GET(req: Request) {
  try {
    const { orgId } = await requireSession();
    const url = new URL(req.url);
    const entityId = url.searchParams.get("entityId");
    if (!entityId) return json({ error: "entityId required" }, 400);
    const q = url.searchParams.get("q")?.trim();

    const accounts = await prisma.account.findMany({
      where: {
        orgId, entityId,
        ...(url.searchParams.get("postable") === "1" ? { isPostable: true, status: "active" } : {}),
        ...(q ? { OR: [{ code: { startsWith: q } }, { name: { contains: q, mode: "insensitive" } }, { nameAr: { contains: q } }] } : {}),
      },
      orderBy: { code: "asc" },
      select: {
        id: true, code: true, name: true, nameAr: true, type: true, subtype: true,
        parentId: true, isPostable: true, isControl: true, currency: true, status: true,
      },
    });
    return json({ accounts });
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}

/** Add an account to the chart. */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req);
    const { orgId } = await requireSession();
    const b = (await req.json().catch(() => ({}))) as Record<string, string | boolean | undefined>;
    if (!b.entityId || !b.code || !b.name || !b.type) {
      return json({ error: "An account needs an entity, a code, a name and a type." }, 400);
    }
    if (!["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"].includes(String(b.type))) {
      return json({ error: "Account type must be ASSET, LIABILITY, EQUITY, INCOME or EXPENSE." }, 400);
    }
    const clash = await prisma.account.findFirst({
      where: { orgId, entityId: String(b.entityId), code: String(b.code) },
    });
    if (clash) return json({ error: `Account ${b.code} already exists.` }, 409);

    const account = await prisma.account.create({
      data: {
        orgId, entityId: String(b.entityId), code: String(b.code), name: String(b.name),
        nameAr: b.nameAr ? String(b.nameAr) : null, type: String(b.type),
        subtype: b.subtype ? String(b.subtype) : null,
        parentId: b.parentId ? String(b.parentId) : null,
        isPostable: b.isPostable !== false,
        currency: b.currency ? String(b.currency) : null,
      },
    });
    return json({ account });
  } catch (e) {
    if (e instanceof LedgerError) return json({ error: e.message }, 422);
    return handleError(e);
  }
}
