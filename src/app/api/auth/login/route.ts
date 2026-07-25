import { z } from "zod";
import { prisma } from "@/lib/server/prisma";
import { verifyPassword } from "@/lib/server/crypto";
import { createSession } from "@/lib/server/session";
import { json, handleError } from "@/lib/server/http";
import { clientIp, enforce } from "@/lib/server/rate-limit";

export const runtime = "nodejs";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function POST(req: Request) {
  try {
    // Brute-force protection: cap attempts per IP and per email.
    const ip = clientIp(req);
    const ipBlock = enforce(`login:ip:${ip}`, 20, 5 * 60_000); // 20 / 5 min / IP
    if (ipBlock) return ipBlock;

    const body = schema.parse(await req.json());
    const email = body.email.toLowerCase().trim();

    const emailBlock = enforce(`login:email:${email}`, 8, 5 * 60_000); // 8 / 5 min / account
    if (emailBlock) return emailBlock;

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
