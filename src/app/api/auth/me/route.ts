import { prisma } from "@/lib/server/prisma";
import { getEffectiveSession } from "@/lib/server/effective-session";
import { json } from "@/lib/server/http";

export const runtime = "nodejs";

// This endpoint returns the caller's identity (email, org, memberships) and is
// polled by the public, CDN-cacheable marketing nav. It MUST never be cached by
// a shared cache, or one user's response could be replayed to another.
const NO_CACHE = { "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie" };

export async function GET() {
  const eff = await getEffectiveSession();
  if (!eff) return json({ error: "Unauthorized" }, { status: 401, headers: NO_CACHE });

  const [user, org, memberships] = await Promise.all([
    prisma.user.findUnique({ where: { id: eff.userId } }),
    // Effective org: the impersonated tenant when viewing-as, else the user's own.
    prisma.organization.findUnique({ where: { id: eff.orgId } }),
    prisma.membership.findMany({ where: { userId: eff.userId }, include: { org: true }, orderBy: { createdAt: "asc" } }),
  ]);
  if (!user || !org) return json({ error: "Unauthorized" }, { status: 401, headers: NO_CACHE });

  return json(
    {
      user: { id: user.id, email: user.email, name: user.name },
      org: { id: org.id, name: org.name, slug: org.slug, defaultLocale: org.defaultLocale },
      memberships: memberships.map((m) => ({ orgId: m.orgId, role: m.role, orgName: m.org.name })),
      impersonating: eff.impersonating ? { orgId: org.id, orgName: org.name } : null,
    },
    { headers: NO_CACHE },
  );
}
