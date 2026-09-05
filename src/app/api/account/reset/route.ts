import { prisma } from "@/lib/server/prisma";
import { requireSession } from "@/lib/server/session";
import { assertSameOrigin } from "@/lib/server/platform-admin";
import { json, handleError } from "@/lib/server/http";
import { RECORD_RETENTION, retentionCutoff } from "@/lib/gateway/retention";

export const runtime = "nodejs";

/**
 * Delete all of the current tenant's domain data + this user's meta. Keeps the account.
 *
 * With one exception, and it is the point of this route. The Transmission rows
 * are the only place the exchanged PINT AE UBL and the Tax Data Document exist
 * — the invoice record is a rebuildable projection, those two documents are
 * not — and Article 56 of Federal Decree-Law 47/2022 requires them for seven
 * years (see lib/gateway/retention.ts). "Reset this workspace" is a control a
 * user reaches for to clear test data; it must not silently destroy the
 * statutory archive on the way through, because nothing in the product can
 * reconstruct it and nothing warned them.
 *
 * So a plain reset keeps every transmission still inside the retention window
 * and deletes the ones that have outlived it. A caller who genuinely means to
 * destroy records inside the window says so in the body:
 *
 *     { "acknowledgeRecordDestruction": true }
 *
 * which is a thing you have to write on purpose — the settings screen sends no
 * body at all unless the user ticks the box that spells out the consequence.
 */
export async function POST(req: Request) {
  try {
    await assertSameOrigin(req); // high blast radius — belt-and-braces beyond SameSite
    const { orgId, userId } = await requireSession();

    // A reset normally arrives as a bare POST, so an absent or unparseable body
    // is the ordinary case and means exactly what it looks like: no acknowledgement.
    const body = (await req.json().catch(() => null)) as { acknowledgeRecordDestruction?: unknown } | null;
    const acknowledged = body?.acknowledgeRecordDestruction === true;

    const cutoff = retentionCutoff();
    const retained = acknowledged
      ? 0
      : await prisma.transmission.count({ where: { orgId, createdAt: { gte: cutoff } } });

    await prisma.$transaction([
      prisma.record.deleteMany({ where: { orgId } }),
      prisma.integrationToken.deleteMany({ where: { orgId } }),
      prisma.transmission.deleteMany({
        where: acknowledged ? { orgId } : { orgId, createdAt: { lt: cutoff } },
      }),
      prisma.payment.deleteMany({ where: { orgId } }),
      prisma.usageEvent.deleteMany({ where: { orgId } }),
      prisma.orgBilling.deleteMany({ where: { orgId } }),
      prisma.oAuthRefreshToken.deleteMany({ where: { orgId } }),
      prisma.oAuthAuthCode.deleteMany({ where: { orgId } }),
      prisma.userMeta.deleteMany({ where: { userId } }),
    ]);

    return json({
      ok: true,
      transmissionsRetained: retained,
      retention: {
        years: RECORD_RETENTION.years,
        basis: RECORD_RETENTION.basis,
        note: RECORD_RETENTION.note,
        // Said only when there is something to say it about, so a caller who
        // already acknowledged is not invited to acknowledge again.
        howToDestroy: retained > 0 ? 'Repeat this request with { "acknowledgeRecordDestruction": true }.' : null,
      },
    });
  } catch (e) {
    return handleError(e);
  }
}
