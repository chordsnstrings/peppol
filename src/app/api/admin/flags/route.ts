import { requirePlatformAdmin, requireAdminWrite, auditData, requestIp } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { prisma } from "@/lib/server/prisma";
import { listFlags, KNOWN_FLAGS } from "@/lib/server/flags";

export const runtime = "nodejs";

export async function GET() {
  try {
    await requirePlatformAdmin();
    return json({ flags: await listFlags(), known: KNOWN_FLAGS });
  } catch (e) {
    return handleError(e);
  }
}

/** Toggle a feature flag / kill switch. Write role. Audited (fail-closed). */
export async function POST(req: Request) {
  try {
    const admin = await requireAdminWrite(req);
    const body = (await req.json().catch(() => ({}))) as { key?: string; on?: boolean };
    const key = body.key?.trim();
    if (!key) return json({ error: "key required" }, 400);
    const value = body.on === true ? "true" : "false";
    const ip = await requestIp();
    await prisma.$transaction([
      prisma.featureFlag.upsert({ where: { key }, create: { key, value, updatedBy: admin.email }, update: { value, updatedBy: admin.email } }),
      prisma.adminAuditLog.create({ data: auditData(admin, { action: "flag.set", targetId: key, metadata: { key, value } }, ip) }),
    ]);
    return json({ ok: true, key, value });
  } catch (e) {
    return handleError(e);
  }
}
