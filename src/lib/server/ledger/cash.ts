import { prisma } from "@/lib/server/prisma";

/**
 * What counts as cash and cash equivalents.
 *
 * This used to be a four-code array — 1000, 1010, 1020, 1050 — declared
 * separately in cashflow.ts, equity.ts and forecast.ts and imported by two
 * more. Money genuinely lands outside those four: the petty cash screen takes
 * a free-text account, and the cheque and receipt paths accept any code. When
 * such an account moves, the cash flow statement declares itself unreconciled
 * and tells the user to edit a list no screen exposes. When it merely holds a
 * balance and does not move, nothing warns at all and the opening and closing
 * cash on a primary IAS 7 statement are understated by the whole balance, in
 * silence.
 *
 * So the answer is derived from the chart. An account is cash when its subtype
 * says so, and the four seeded codes remain as the floor for books opened
 * before subtypes were set on them — never as the definition.
 *
 * IAS 7.6 wants cash equivalents to be short-term, highly liquid, readily
 * convertible to a known amount and subject to an insignificant risk of a
 * change in value. Three accounts in this chart deliberately fail that and are
 * excluded whatever their subtype: post-dated cheques in hand (1060), margin
 * deposits the bank holds against a facility (1255), and work in progress.
 * Each of those was carved out of a cash account precisely because it is not
 * cash, and a subtype set by hand must not be able to put it back.
 */

/** The floor. Present in every seeded chart; never the whole answer. */
export const SEEDED_CASH_CODES = ["1000", "1010", "1020", "1050"] as const;

/** Subtypes that make an account cash. */
const CASH_SUBTYPES = new Set(["CASH", "BANK", "CASH_EQUIVALENT"]);

/**
 * Never cash, whatever anybody sets on them. Each was split out of a cash
 * account for a stated reason, and the reason does not stop being true because
 * somebody edits a subtype.
 */
export const NEVER_CASH = new Set(["1060", "1255", "1330"]);

/**
 * The cash account codes for an entity, sorted.
 *
 * Callers that hold their own account list should pass it rather than making
 * this query again — see `cashCodesFrom`.
 */
export async function cashCodes(opts: { orgId: string; entityId: string }): Promise<string[]> {
  const accounts = await prisma.account.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId },
    select: { code: true, subtype: true },
  });
  return cashCodesFrom(accounts);
}

/** The same answer from accounts the caller already has. */
export function cashCodesFrom(
  accounts: { code: string; subtype: string | null }[],
): string[] {
  const out = new Set<string>();
  for (const a of accounts) {
    if (NEVER_CASH.has(a.code)) continue;
    if (a.subtype && CASH_SUBTYPES.has(a.subtype)) out.add(a.code);
  }
  // The floor, for a chart whose subtypes were never set. An account that does
  // not exist in this entity cannot contribute a balance, so adding it costs
  // nothing and leaving it out could understate the statement.
  for (const c of SEEDED_CASH_CODES) if (!NEVER_CASH.has(c)) out.add(c);
  return [...out].sort();
}
