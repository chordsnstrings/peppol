import { prisma } from "@/lib/server/prisma";
import { requireSession } from "@/lib/server/session";
import { json, handleError } from "@/lib/server/http";

export const runtime = "nodejs";

/** GET /api/meta?key=foo → { value } ; GET /api/meta → { items: {key,value}[] } */
export async function GET(req: Request) {
  try {
    const { userId } = await requireSession();
    const key = new URL(req.url).searchParams.get("key");
    if (key) {
      const row = await prisma.userMeta.findUnique({ where: { userId_key: { userId, key } } });
      return json({ value: row ? JSON.parse(row.data) : undefined });
    }
    const rows = await prisma.userMeta.findMany({ where: { userId } });
    return json({ items: rows.map((r) => ({ key: r.key, value: JSON.parse(r.data) })) });
  } catch (e) {
    return handleError(e);
  }
}

/** PUT /api/meta { key, value } */
export async function PUT(req: Request) {
  try {
    const { userId } = await requireSession();
    const { key, value } = (await req.json()) as { key: string; value: unknown };
    if (!key) return json({ error: "key required" }, 400);
    const data = JSON.stringify(value);
    await prisma.userMeta.upsert({
      where: { userId_key: { userId, key } },
      create: { userId, key, data },
      update: { data },
    });
    return json({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}
