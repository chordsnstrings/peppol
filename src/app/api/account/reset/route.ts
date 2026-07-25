import { prisma } from "@/lib/server/prisma";
import { requireSession } from "@/lib/server/session";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";

export const runtime = "nodejs";

/** Delete all of the current tenant's domain data + this user's meta. Keeps the account. */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req); // high blast radius — belt-and-braces beyond SameSite
    const { orgId, userId } = await requireSession();
    await prisma.$transaction([
      prisma.record.deleteMany({ where: { orgId } }),
      prisma.integrationToken.deleteMany({ where: { orgId } }),
      prisma.transmission.deleteMany({ where: { orgId } }),
      prisma.payment.deleteMany({ where: { orgId } }),
      prisma.usageEvent.deleteMany({ where: { orgId } }),
      prisma.orgBilling.deleteMany({ where: { orgId } }),
      prisma.oAuthRefreshToken.deleteMany({ where: { orgId } }),
      prisma.oAuthAuthCode.deleteMany({ where: { orgId } }),
      prisma.userMeta.deleteMany({ where: { userId } }),
    ]);
    return json({ ok: true });
  } catch (e) {
    return handleError(e);
  }
}
