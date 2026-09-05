import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/server/prisma";
import { json, handleError } from "@/lib/server/http";

export const runtime = "nodejs";

/**
 * The periodic work every tenant needs, run without a browser.
 *
 * Recurring invoices, subscription issuance and the dunning sweep were all
 * gated on a browser session — `/api/reminders/run`'s own docstring said
 * "Trigger from the UI now; a worker would call this on a schedule in
 * production". CRON_SECRET was read by exactly one route, which advances the
 * platform's own billing state and knows nothing about any tenant's ledger.
 *
 * Nothing was misstated by that. `issueDue` raises one invoice per missed
 * period with the correct dates, so a late run reconstructs exactly what a
 * nightly scheduler would have produced, and both the attention list and the
 * notification centre report a subscription that is behind. It was a monthly
 * click rather than a wrong return. This makes it not a click.
 *
 * Three properties it has to have, and the reasons they are not optional.
 *
 * **Fail closed.** No secret configured means no scheduler, not an open route:
 * this walks every tenant's ledger and raises documents in it.
 *
 * **One tenant's failure must not stop the rest.** A single entity with a
 * closed period or a missing account would otherwise silently halt the sweep
 * partway down an alphabetical list, and the tenants after it would go a month
 * without their invoices while the ones before them were fine. Each is caught
 * and reported.
 *
 * **Say what happened per tenant.** A worker that returns "ok" tells whoever
 * reads the log nothing about the entity that raised nothing because its
 * period is closed.
 *
 * It is deliberately idempotent rather than transactional. Every operation
 * underneath is keyed — subscriptions on (template, scheduled date),
 * recurring on the next-run date it advances — so running twice raises once
 * and a run that dies halfway can simply be run again.
 */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET ?? "";
  if (!secret) return false;
  const provided = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

interface EntityOutcome {
  orgId: string;
  entityId: string;
  invoicesRaised?: number;
  error?: string;
}

export async function POST(req: Request) {
  try {
    if (!authorized(req)) return json({ error: "Unauthorized" }, 401);

    const asOf = new URL(req.url).searchParams.get("asOf") ?? undefined;

    // Every entity that has a ledger. An org with no book has nothing periodic
    // to do, and reaching into one would only produce noise.
    const books = await prisma.book.findMany({
      select: { orgId: true, entityId: true },
      distinct: ["orgId", "entityId"],
      orderBy: [{ orgId: "asc" }, { entityId: "asc" }],
    });

    const { issueAllDue } = await import("@/lib/server/ledger/subscriptions");

    const outcomes: EntityOutcome[] = [];
    let raised = 0;
    let failed = 0;

    for (const b of books) {
      try {
        const r = await issueAllDue({ orgId: b.orgId, entityId: b.entityId, asOf });
        const n = Number(r.invoicesRaised ?? 0);
        raised += n;
        // Only the ones that did something, or the run's output grows with the
        // number of tenants rather than with what happened.
        if (n > 0) outcomes.push({ orgId: b.orgId, entityId: b.entityId, invoicesRaised: n });
      } catch (e) {
        failed++;
        outcomes.push({
          orgId: b.orgId,
          entityId: b.entityId,
          error: e instanceof Error ? e.message : "The run failed and gave no reason.",
        });
      }
    }

    return json({
      entities: books.length,
      invoicesRaised: raised,
      failedEntities: failed,
      outcomes,
      note:
        failed === 0
          ? `Subscriptions issued for ${books.length} ${books.length === 1 ? "entity" : "entities"}.`
          : `${failed} of ${books.length} entities could not be run. The rest were, and the reasons are listed — ` +
            `a closed period or a missing account stops one tenant, never the sweep.`,
    });
  } catch (e) {
    return handleError(e);
  }
}
