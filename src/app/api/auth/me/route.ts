import { prisma } from "@/lib/server/prisma";
import { getEffectiveSession } from "@/lib/server/effective-session";
import { json } from "@/lib/server/http";

export const runtime = "nodejs";

export async function GET() {
  const eff = await getEffectiveSession();
  if (!eff) return json({ error: "Unauthorized" }, 401);

  const [user, org, memberships] = await Promise.all([
    prisma.user.findUnique({ where: { id: eff.userId } }),
    // Effective org: the impersonated tenant when viewing-as, else the user's own.
    prisma.organization.findUnique({ where: { id: eff.orgId } }),
    prisma.membership.findMany({ where: { userId: eff.userId }, include: { org: true }, orderBy: { createdAt: "asc" } }),
  ]);
  if (!user || !org) return json({ error: "Unauthorized" }, 401);

  return json({
    user: { id: user.id, email: user.email, name: user.name },
    org: { id: org.id, name: org.name, slug: org.slug, defaultLocale: org.defaultLocale },
    memberships: memberships.map((m) => ({ orgId: m.orgId, role: m.role, orgName: m.org.name })),
    impersonating: eff.impersonating ? { orgId: org.id, orgName: org.name } : null,
  });
}
