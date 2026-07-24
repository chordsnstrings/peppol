import { prisma } from "@/lib/server/prisma";
import { getSession } from "@/lib/server/session";
import { json } from "@/lib/server/http";

export const runtime = "nodejs";

export async function GET() {
  const session = await getSession();
  if (!session) return json({ error: "Unauthorized" }, 401);

  const [user, org, memberships] = await Promise.all([
    prisma.user.findUnique({ where: { id: session.userId } }),
    prisma.organization.findUnique({ where: { id: session.orgId } }),
    prisma.membership.findMany({
      where: { userId: session.userId },
      include: { org: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  if (!user || !org) return json({ error: "Unauthorized" }, 401);

  return json({
    user: { id: user.id, email: user.email, name: user.name },
    org: { id: org.id, name: org.name, slug: org.slug, defaultLocale: org.defaultLocale },
    memberships: memberships.map((m) => ({
      orgId: m.orgId,
      role: m.role,
      orgName: m.org.name,
    })),
  });
}
