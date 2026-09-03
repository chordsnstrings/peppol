import { prisma } from "@/lib/server/prisma";
import { post, LedgerError, type PostLine } from "./post";

/**
 * Opening balances — bringing an existing business onto the ledger.
 *
 * This is the step every accounting product needs and most treat as an
 * afterthought, which is why migrations go wrong. A business adopting this
 * system already has a trial balance; until it can be carried in, nothing else
 * here is usable by anyone who has been trading.
 *
 * Two decisions shape the whole module:
 *
 *  - **Opening balances are a journal entry, not a special kind of data.**
 *    They post through `post()` like everything else, which means the same
 *    invariants apply, they appear in the general ledger, and they can be
 *    reversed if the migration was wrong. A separate "opening balance" table
 *    would be a second record that could disagree with the ledger.
 *
 *  - **An out-of-balance import is refused, never plugged.** Every product that
 *    silently posts the difference to a suspense account produces a set of
 *    books that balances and is wrong, and the error is then extremely hard to
 *    find because nothing looks broken. If the trial balance being imported
 *    does not balance, the source is wrong and the person needs to know before
 *    anything is posted.
 */

export interface OpeningLine {
  accountCode: string;
  /** Supply one of these, in minor units. */
  debitMinor?: number | bigint | string;
  creditMinor?: number | bigint | string;
  /** Create the account if the chart does not have it. */
  createIfMissing?: { name: string; nameAr?: string; type: string; subtype?: string };
  /**
   * The account name as it appeared in the paste. Carried so the preview can
   * show which account a row meant when the code is not in the chart; it is
   * never used to create one, because creating an account also needs a type
   * and a paste box has no way to ask for it.
   */
  pastedName?: string;
}

export interface OpeningPreview {
  asOf: string;
  currency: string;
  lines: {
    accountCode: string;
    accountName: string | null;
    debitMinor: string;
    creditMinor: string;
    exists: boolean;
    postable: boolean;
    problem: string | null;
  }[];
  totalDebitMinor: string;
  totalCreditMinor: string;
  differenceMinor: string;
  balanced: boolean;
  /** Everything that would stop this being posted, in sentences. */
  blockers: string[];
  alreadyImported: boolean;
  reference: string | null;
}

const minor = (v: number | bigint | string | undefined): bigint => {
  if (v === undefined || v === null || v === "") return 0n;
  if (typeof v === "string" && !/^-?\d+$/.test(v.trim())) {
    throw new LedgerError(`"${v}" is not a whole number of minor units.`);
  }
  return BigInt(typeof v === "string" ? v.trim() : v);
};

const fmt = (v: bigint) => {
  const neg = v < 0n;
  const a = (neg ? -v : v).toString().padStart(3, "0");
  return `${neg ? "-" : ""}${a.slice(0, -2)}.${a.slice(-2)}`;
};

/**
 * Check an import before it touches anything.
 *
 * The preview exists because an opening balance import is the one operation a
 * migration cannot easily undo in a customer's mind — the entry can be
 * reversed, but confidence cannot. So everything that could go wrong is
 * reported at once, rather than one error per attempt.
 */
export async function previewOpeningBalances(opts: {
  orgId: string;
  entityId: string;
  /** The balances are as at the close of this date. */
  asOf: string;
  lines: OpeningLine[];
}): Promise<OpeningPreview> {
  const book = await prisma.book.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: "PRIMARY" },
  });
  if (!book) throw new LedgerError("Open the books for this entity before importing balances into them.");

  const externalKey = `opening:${opts.entityId}:${opts.asOf}`;
  const existing = await prisma.journalEntry.findFirst({
    where: { orgId: opts.orgId, externalKey },
    select: { series: true, number: true },
  });

  const codes = opts.lines.map((l) => l.accountCode.trim());
  const accounts = await prisma.account.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, code: { in: codes } },
  });
  const byCode = new Map(accounts.map((a) => [a.code, a]));

  const blockers: string[] = [];
  let totalDebit = 0n;
  let totalCredit = 0n;
  const seen = new Set<string>();

  const lines = opts.lines.map((l) => {
    const code = l.accountCode.trim();
    const debit = minor(l.debitMinor);
    const credit = minor(l.creditMinor);
    const account = byCode.get(code);
    let problem: string | null = null;

    if (seen.has(code)) {
      problem = `${code} appears more than once. Combine the rows before importing — two opening balances for one account is not a balance.`;
    }
    seen.add(code);

    if (debit < 0n || credit < 0n) {
      problem ??= `${code} has a negative amount. Put it on the other side rather than negating it.`;
    }
    if (debit !== 0n && credit !== 0n) {
      problem ??= `${code} has both a debit and a credit. One account holds one balance.`;
    }
    if (!account && !l.createIfMissing) {
      problem ??= `${code} is not in this entity's chart of accounts. Add it first, or supply a name and type to create it.`;
    }
    if (account && !account.isPostable) {
      problem ??= `${code} ${account.name} is a heading. Headings roll up their children and cannot hold a balance of their own.`;
    }
    if (account && account.status !== "active") {
      problem ??= `${code} ${account.name} is archived.`;
    }

    totalDebit += debit;
    totalCredit += credit;
    if (problem) blockers.push(problem);

    return {
      accountCode: code,
      accountName: account?.name ?? l.createIfMissing?.name ?? l.pastedName ?? null,
      debitMinor: debit.toString(),
      creditMinor: credit.toString(),
      exists: Boolean(account),
      // An account that does not exist is not postable. Reporting true because
      // it might be created later makes the preview say the paste will work
      // when it will not.
      postable: account ? account.isPostable && account.status === "active" : Boolean(l.createIfMissing),
      problem,
    };
  });

  const difference = totalDebit - totalCredit;
  if (difference !== 0n) {
    const side = difference > 0n ? "Credits" : "Debits";
    blockers.push(
      `The trial balance does not balance: ${side.toLowerCase()} are short by ${fmt(difference > 0n ? difference : -difference)}. ` +
        `Nothing has been posted. The difference is in the source, not here — a system that posts the gap to a suspense ` +
        `account gives you books that balance and are wrong, and the error becomes very hard to find because nothing looks broken.`,
    );
  }

  if (lines.length === 0) blockers.push("There are no balances to import.");

  // The date has to fall in a period, and that period has to be open.
  const date = new Date(opts.asOf);
  if (Number.isNaN(date.getTime())) {
    blockers.push(`"${opts.asOf}" is not a date.`);
  } else {
    const period = await prisma.accountingPeriod.findFirst({
      where: { orgId: opts.orgId, entityId: opts.entityId, startsOn: { lte: date }, endsOn: { gte: date } },
      orderBy: [{ isAdjustment: "asc" }, { seq: "asc" }],
    });
    if (!period) {
      blockers.push(
        `No accounting period covers ${opts.asOf}. Opening balances are usually dated the day before the first ` +
          `period starts, so open the fiscal year that contains that date first.`,
      );
    } else if (period.status !== "open") {
      blockers.push(`${period.label} is ${period.status.replace(/_/g, " ")}, so nothing can be posted into it.`);
    }
  }

  return {
    asOf: opts.asOf,
    currency: book.functionalCurrency,
    lines,
    totalDebitMinor: totalDebit.toString(),
    totalCreditMinor: totalCredit.toString(),
    differenceMinor: difference.toString(),
    balanced: difference === 0n,
    blockers: existing ? [] : blockers,
    alreadyImported: Boolean(existing),
    reference: existing ? `${existing.series}-${existing.number}` : null,
  };
}

export interface OpeningResult {
  reference: string | null;
  entryId: string | null;
  accountsCreated: number;
  linesPosted: number;
  alreadyImported: boolean;
}

/**
 * Post the opening balances.
 *
 * Control accounts are the wrinkle: 1100 and 2000 refuse a manual journal
 * because they belong to their subledgers. An opening balance legitimately has
 * to reach them — the business really does have receivables on day one — so
 * this posts with `source: "opening"` rather than "manual", which is the same
 * mechanism the invoice and bill subledgers use. The alternative would be to
 * refuse a migration its own receivables.
 */
export async function importOpeningBalances(opts: {
  orgId: string;
  entityId: string;
  asOf: string;
  lines: OpeningLine[];
  actorId?: string;
}): Promise<OpeningResult> {
  const preview = await previewOpeningBalances(opts);

  if (preview.alreadyImported) {
    return {
      reference: preview.reference, entryId: null, accountsCreated: 0,
      linesPosted: 0, alreadyImported: true,
    };
  }
  if (preview.blockers.length) throw new LedgerError(preview.blockers[0]);

  // Create any accounts the import asked for. Done before posting so a failure
  // here leaves no half-posted entry behind.
  let created = 0;
  for (const l of opts.lines) {
    if (!l.createIfMissing) continue;
    const exists = await prisma.account.findFirst({
      where: { orgId: opts.orgId, entityId: opts.entityId, code: l.accountCode.trim() },
    });
    if (exists) continue;
    if (!["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"].includes(l.createIfMissing.type)) {
      throw new LedgerError(
        `${l.accountCode} was given the type "${l.createIfMissing.type}". ` +
          `An account is one of ASSET, LIABILITY, EQUITY, INCOME or EXPENSE.`,
      );
    }
    await prisma.account.create({
      data: {
        orgId: opts.orgId, entityId: opts.entityId,
        code: l.accountCode.trim(), name: l.createIfMissing.name,
        nameAr: l.createIfMissing.nameAr ?? null,
        type: l.createIfMissing.type, subtype: l.createIfMissing.subtype ?? null,
      },
    });
    created++;
  }

  const postLines: PostLine[] = opts.lines
    .map((l) => {
      const debit = minor(l.debitMinor);
      const credit = minor(l.creditMinor);
      // A zero balance carries no information, and post() refuses one anyway.
      if (debit === 0n && credit === 0n) return null;
      return {
        account: l.accountCode.trim(),
        ...(debit !== 0n ? { debit } : { credit }),
        memo: "Opening balance",
      } as PostLine;
    })
    .filter((l): l is PostLine => l !== null);

  if (postLines.length < 2) {
    throw new LedgerError("An opening balance import needs at least two accounts with a balance.");
  }

  const entry = await post({
    orgId: opts.orgId,
    entityId: opts.entityId,
    entryDate: opts.asOf,
    memo: `Opening balances as at ${opts.asOf}`,
    // Not "manual": control accounts refuse manual journals, and a migrating
    // business really does have receivables and payables on day one.
    source: "opening",
    sourceType: "OPENING_BALANCE",
    sourceId: opts.asOf,
    externalKey: `opening:${opts.entityId}:${opts.asOf}`,
    actorType: "HUMAN",
    actorId: opts.actorId,
    series: "OB",
    lines: postLines,
  });

  return {
    reference: `${entry.series}-${entry.number}`,
    entryId: entry.id,
    accountsCreated: created,
    linesPosted: postLines.length,
    alreadyImported: false,
  };
}

/**
 * Parse a pasted trial balance.
 *
 * Every accountant's export looks slightly different, so columns are found by
 * name rather than by position. What cannot be read is reported by row number
 * instead of being dropped — a migration that silently skips three rows is a
 * migration that produces a wrong opening position and no warning.
 */
export function parseTrialBalance(text: string): {
  lines: OpeningLine[];
  problems: string[];
} {
  const rows = text.trim().split(/\r?\n/).filter((r) => r.trim());
  if (rows.length < 2) {
    return { lines: [], problems: ["Paste the header row and at least one account."] };
  }

  // A quoted field can contain the delimiter — "AED 1,234,567.89" is one cell,
  // not three. Splitting naively turns a million into a hundred, silently.
  const split = (r: string): string[] => {
    if (r.includes("\t")) return r.split("\t").map((c) => c.trim().replace(/^"|"$/g, ""));
    const out: string[] = [];
    let cell = "";
    let quoted = false;
    for (let i = 0; i < r.length; i++) {
      const ch = r[i];
      if (ch === '"') {
        // A doubled quote inside a quoted field is a literal quote.
        if (quoted && r[i + 1] === '"') { cell += '"'; i++; }
        else quoted = !quoted;
      } else if (ch === "," && !quoted) {
        out.push(cell.trim());
        cell = "";
      } else {
        cell += ch;
      }
    }
    out.push(cell.trim());
    return out;
  };
  const header = split(rows[0]).map((h) => h.toLowerCase());
  const find = (...names: string[]) => header.findIndex((h) => names.some((n) => h.includes(n)));

  const iCode = find("code", "account no", "account number", "acct");
  const iName = find("name", "description", "account");
  const iDebit = find("debit", "dr");
  const iCredit = find("credit", "cr");
  const iBalance = find("balance", "amount");

  const problems: string[] = [];
  if (iCode < 0) problems.push('No account code column — the header needs one containing "code" or "account".');
  if (iDebit < 0 && iCredit < 0 && iBalance < 0) {
    problems.push('No amounts — the header needs a "debit" and "credit" pair, or a single "balance" column.');
  }
  if (problems.length) return { lines: [], problems };

  const money = (s: string | undefined): bigint | null => {
    const raw = (s ?? "").trim();
    if (!raw) return 0n;
    // Refuse anything containing a letter before stripping. Stripping first
    // turns "not a number" into an empty string, which then reads as zero —
    // and a migration that silently treats an unreadable cell as nil produces
    // a wrong opening position with no warning at all. Currency codes are the
    // one exception, since exports routinely prefix them.
    if (/[a-z]/i.test(raw.replace(/^[a-z]{3}\s*/i, ""))) return null;
    const t = raw.replace(/[^\d.,()-]/g, "");
    if (!t || t === "-") return 0n;
    // Parentheses are the accounting negative, as everywhere else here.
    const neg = /^\(.*\)$/.test(t);
    const body = t.replace(/[()]/g, "").replace(/,/g, "");
    if (!/^-?\d+(\.\d{1,2})?$/.test(body)) return null;
    const [whole, frac = ""] = body.replace(/^-/, "").split(".");
    const v = BigInt(whole) * 100n + BigInt(frac.padEnd(2, "0"));
    return neg || body.startsWith("-") ? -v : v;
  };

  const lines: OpeningLine[] = [];
  rows.slice(1).forEach((r, i) => {
    const c = split(r);
    const code = (c[iCode] ?? "").trim();
    if (!code) return; // a blank row, or a subtotal band — not an error

    let debit = 0n;
    let credit = 0n;
    if (iDebit >= 0 || iCredit >= 0) {
      const d = money(c[iDebit]);
      const cr = money(c[iCredit]);
      if (d === null || cr === null) {
        problems.push(`Row ${i + 2} (${code}): the amount could not be read.`);
        return;
      }
      debit = d;
      credit = cr;
    } else {
      const b = money(c[iBalance]);
      if (b === null) {
        problems.push(`Row ${i + 2} (${code}): the balance could not be read.`);
        return;
      }
      // A single signed column: positive is a debit, by the same convention the
      // ledger itself uses.
      if (b >= 0n) debit = b;
      else credit = -b;
    }

    if (debit === 0n && credit === 0n) return; // nothing to carry over
    // The pasted name column is deliberately not turned into a createIfMissing
    // here. Creating an account needs a type as well as a name, and a paste
    // box has no way to ask for one — guessing it from the code would invent
    // the single fact that decides which statement the balance appears in. So
    // an unknown code is reported as unknown, and the name is carried only so
    // the preview can show which account the paste meant.
    lines.push({
      accountCode: code,
      debitMinor: debit.toString(),
      creditMinor: credit.toString(),
      ...(iName >= 0 && c[iName] ? { pastedName: c[iName].trim() } : {}),
    });
  });

  return { lines, problems };
}
