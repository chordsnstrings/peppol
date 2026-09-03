import { prisma } from "@/lib/server/prisma";

/**
 * What the ledger holds on a set of accounts, in functional minor units.
 *
 * The status filter is the whole point of this helper existing. Reversing an
 * entry leaves the original marked `reversed` and adds a new `posted` entry
 * with every side flipped; the pair nets to nothing, which is exactly what a
 * reversal should do to a balance. Reading only `posted` lines counts the
 * reversal but not the original, so every reversal moves the balance by the
 * full amount in the wrong direction — and the screens that use these figures
 * are reconciliations, which means the error surfaces as the register and the
 * ledger disagreeing and the customer being told to report a defect.
 *
 * Draft and void entries are correctly excluded: neither has ever been money.
 */
export async function ledgerBalances(opts: {
  orgId: string;
  entityId: string;
  codes: string[];
}): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  if (!opts.codes.length) return out;

  const accounts = await prisma.account.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: { in: opts.codes } },
    select: { id: true, code: true },
  });
  if (!accounts.length) return out;

  const byId = new Map(accounts.map((a) => [a.id, a.code]));
  const lines = await prisma.journalLine.findMany({
    where: {
      orgId: opts.orgId,
      accountId: { in: accounts.map((a) => a.id) },
      entry: { status: { in: ["posted", "reversed"] } },
    },
    select: { accountId: true, functionalAmountMinor: true },
  });

  for (const code of opts.codes) out.set(code, 0n);
  for (const l of lines) {
    const code = byId.get(l.accountId);
    if (code) out.set(code, (out.get(code) ?? 0n) + l.functionalAmountMinor);
  }
  return out;
}
