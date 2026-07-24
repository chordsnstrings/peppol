import { z } from "zod";
import { prisma } from "@/lib/server/prisma";
import { hashPassword } from "@/lib/server/crypto";
import { createSession } from "@/lib/server/session";
import { json, handleError } from "@/lib/server/http";

export const runtime = "nodejs";

const schema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email(),
  password: z.string().min(8).max(200),
  orgName: z.string().min(1).max(160),
  locale: z.enum(["en", "ar"]).default("en"),
});

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "org";
}

export async function POST(req: Request) {
  try {
    const body = schema.parse(await req.json());
    const email = body.email.toLowerCase().trim();

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) return json({ error: "An account with this email already exists." }, 409);

    const result = await prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: { name: body.orgName, slug: slugify(body.orgName), defaultLocale: body.locale },
      });
      const user = await tx.user.create({
        data: { name: body.name, email, passwordHash: hashPassword(body.password) },
      });
      await tx.membership.create({ data: { userId: user.id, orgId: org.id, role: "OWNER" } });
      return { org, user };
    });

    await createSession({ userId: result.user.id, orgId: result.org.id });
    return json({
      user: { id: result.user.id, email, name: result.user.name },
      org: {
        id: result.org.id,
        name: result.org.name,
        slug: result.org.slug,
        defaultLocale: result.org.defaultLocale,
      },
    });
  } catch (e) {
    return handleError(e);
  }
}
