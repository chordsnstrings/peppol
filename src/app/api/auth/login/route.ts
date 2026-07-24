import { z } from "zod";
import { prisma } from "@/lib/server/prisma";
import { verifyPassword } from "@/lib/server/crypto";
import { createSession } from "@/lib/server/session";
import { json, handleError } from "@/lib/server/http";

export const runtime = "nodejs";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function POST(req: Request) {
  try {
    const body = schema.parse(await req.json());
    const email = body.email.toLowerCase().trim();

    const user = await prisma.user.findUnique({
      where: { email },
      include: { memberships: { orderBy: { createdAt: "asc" }, include: { org: true } } },
    });
    if (!user || !verifyPassword(body.password, user.passwordHash)) {
      return json({ error: "Incorrect email or password." }, 401);
    }
    const membership = user.memberships[0];
    if (!membership) return json({ error: "No organization for this account." }, 403);

    await createSession({ userId: user.id, orgId: membership.orgId });
    return json({
      user: { id: user.id, email: user.email, name: user.name },
      org: {
        id: membership.org.id,
        name: membership.org.name,
        slug: membership.org.slug,
        defaultLocale: membership.org.defaultLocale,
      },
    });
  } catch (e) {
    return handleError(e);
  }
}
