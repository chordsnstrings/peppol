import { randomUUID } from "node:crypto";
import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/server/prisma";
import { putRecord } from "@/lib/server/store";
import { json, handleError } from "@/lib/server/http";
import { enterGrace, cancelSubscription } from "@/lib/server/subscription";
import { GRACE_DAYS } from "@/lib/domain/billing";

export const runtime = "nodejs";

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET ?? "";
  if (!secret) return false; // fail-closed: no scheduler without a configured secret
  const provided = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function notify(orgId: string, title: string, body: string, tone: "warning" | "error" | "neutral") {
  await putRecord(orgId, "notifications", {
    id: randomUUID(), orgId, type: "subscription.dunning", title, body, href: "/settings/billing", tone,
    createdAt: new Date().toISOString(),
  });
}

/**
 * Subscription lifecycle worker (Bearer CRON_SECRET). Advances trials/periods,
 * runs dunning notices, and cuts off after grace. Idempotent — safe to run often.
 * Entitlement itself is timestamp-derived, so this only updates labels + dunning;
 * a late run never wrongly keeps a lapsed org transmitting.
 */
export async function POST(req: Request) {
  try {
    if (!authorized(req)) return json({ error: "Unauthorized" }, 401);
    const now = new Date();
    const graceCutoff = new Date(now.getTime() - GRACE_DAYS * 24 * 60 * 60 * 1000);
    let trialsEnded = 0, grace = 0, cutoff = 0;

    // 1. Active subscriptions whose period has fully lapsed → grace + dunning.
    const lapsed = await prisma.orgBilling.findMany({
      where: { subStatus: "active", currentPeriodEnd: { lt: now } },
      select: { orgId: true },
    });
    for (const r of lapsed) {
      await enterGrace(r.orgId);
      await notify(r.orgId, "Payment needed", "Your ARKS subscription lapsed. Renew within 7 days to keep transmitting to the FTA.", "warning");
      grace++;
    }

    // 2. Grace exhausted → cut off.
    const expired = await prisma.orgBilling.findMany({
      where: { subStatus: "grace", currentPeriodEnd: { lt: graceCutoff } },
      select: { orgId: true },
    });
    for (const r of expired) {
      await cancelSubscription(r.orgId);
      await notify(r.orgId, "FTA transmission paused", "Your subscription ended and transmission is now paused. Subscribe to resume.", "error");
      cutoff++;
    }

    // 3. Trials that have ended → mark none + nudge (no grace after a trial).
    const trials = await prisma.orgBilling.findMany({
      where: { subStatus: "trialing", trialEndsAt: { lt: now } },
      select: { orgId: true },
    });
    for (const r of trials) {
      await prisma.orgBilling.update({ where: { orgId: r.orgId }, data: { subStatus: "none" } });
      await notify(r.orgId, "Trial ended", "Your free trial ended. Subscribe to keep transmitting invoices to the FTA.", "warning");
      trialsEnded++;
    }

    // Housekeeping: purge the webhook-dedup ledger older than 30 days.
    const dedupCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    await prisma.processedWebhook.deleteMany({ where: { createdAt: { lt: dedupCutoff } } }).catch(() => {});

    return json({ ok: true, grace, cutoff, trialsEnded });
  } catch (e) {
    return handleError(e);
  }
}
