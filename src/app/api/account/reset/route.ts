import { prisma } from "@/lib/server/prisma";
import { requireSession } from "@/lib/server/session";
import { json, handleError } from "@/lib/server/http";

export const runtime = "nodejs";

/** Delete all of the current tenant's domain data + this user's meta. Keeps the account. */
export async function POST() {
  try {
    const { orgId, userId } = await requireSession();
    await prisma.$transaction([
      prisma.record.deleteMany({ where: { orgId } }),
      prisma.integrationToken.deleteMany({ where: { orgId } }),
      prisma.transmission.deleteMany({ where: { orgId } }),
      prisma.payment.deleteMany({ where: { orgId } }),
      prisma.userMeta.deleteMany({ where: { userId } }),
    ]);
    return json({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}
