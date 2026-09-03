import { prisma } from "@/lib/server/prisma";
import { fmtMinor } from "@/lib/ledger/format";
import { post, LedgerError, type PostLine } from "./post";
import { ledgerBalances } from "./balances";

/**
 * Post-dated cheques — the register, and the three journals a cheque actually
 * makes.
 *
 * A great deal of UAE business is settled by a cheque written today and dated
 * for ninety days' time. Most accounting software models only the day the money
 * moves, which leaves the ninety days in between unrecorded: the customer's
 * invoice sits in the ageing as though nothing had been given, and the supplier
 * cheque already signed and handed over is nowhere at all until it hits the
 * bank. Both are wrong, and they are wrong in opposite directions.
 *
 * The idea this file is built on is that a cheque in the drawer is **not cash,
 * and not quite an ordinary receivable either** — it is a receivable whose form
 * has changed. So the money has three states, and each is a different journal:
 *
 *   Taken     Dr  1050  Cheques in hand      the paper, with a date on it
 *               Cr  1100  Trade receivables     the customer no longer owes it
 *                                               in the ordinary way
 *
 *   Cleared   Dr  1010  Bank                 the bank paid it
 *               Cr  1050  Cheques in hand
 *
 *   Bounced   Dr  1100  Trade receivables    the paper was worthless; the
 *               Cr  1050  Cheques in hand      customer owes it again
 *
 * An issued cheque is the mirror image, through payables:
 *
 *   Given     Dr  2000  Trade payables       taken off the supplier's account
 *               Cr  2050  Cheques issued        and committed to a dated cheque
 *
 *   Cleared   Dr  2050  Cheques issued
 *               Cr  1010  Bank
 *
 *   Bounced   Dr  2050  Cheques issued       our own cheque was dishonoured;
 *               Cr  2000  Trade payables       we owe the supplier again
 *
 * Getting the middle state right is the whole point. A system that posts
 * nothing until the cheque clears tells a business it has no money coming; one
 * that treats the cheque as cash tells it the money is already there. This one
 * says what is true: the debt has changed form, it is dated, and here is the
 * day it can be presented.
 *
 * ── Which journal discharges the invoice ───────────────────────────────────
 *
 * The first one, and that is not arbitrary. Taking a cheque is what takes the
 * debt out of trade receivables, so the invoice clears from the ageing at that
 * moment, keyed by `settlesId` exactly as an ordinary receipt would clear it —
 * and the exposure moves to this register, where it is aged by the day the
 * cheque may be presented rather than by the day the invoice was raised, which
 * is the only honest way to age it. The clearing entry carries the same key, so
 * the whole chain — invoice, cheque, bank — nets against one document; and so
 * does the bounce, which is what puts the customer back on the same open item,
 * with the same date and in the same ageing band, instead of opening a new one.
 *
 * ── Why a bounce is not just a status ──────────────────────────────────────
 *
 * Under the Commercial Transactions Law as amended by Federal Decree-Law
 * 14/2020, a partly or wholly unpaid cheque is itself an executive instrument:
 * the holder goes straight to execution without first proving the debt. That
 * remedy rests on the paper and on the bank's stated reason for refusing it, so
 * the register keeps the reason and the date of every bounce — refusing a
 * bounce that does not carry a reason — and keeps them afterwards, through a
 * re-presentation, because that history is the case.
 *
 * ── Clearing before the date on the cheque ─────────────────────────────────
 *
 * A cheque is payable on sight whatever date is written on it (Commercial
 * Transactions Law, art. 617), so a bank that presents one early is not making
 * a mistake for software to refuse. Clearing before `dueOn` is therefore
 * allowed; clearing before the cheque was written is not, because the money
 * cannot move before the paper exists.
 */

/* ------------------------------------------------------------------ accounts */

/**
 * Where a cheque sits while it is neither a trade balance nor money.
 *
 * The chart in `setup.ts` has no "cheques in hand" account and no "cheques
 * issued" account, so neither of these is the account a UAE bookkeeper would
 * have chosen; they are the closest the chart holds, and the reasons are worth
 * stating rather than hiding.
 *
 * 1050 "Undeposited funds" is exactly the idea — value received and not yet in
 * the bank — and it reads correctly on the face of the balance sheet. Its one
 * defect is real and worth knowing: `cashflow.ts`, `forecast.ts` and
 * `equity.ts` all count 1050 among the cash codes, so a ninety-day cheque
 * parked here is reported as cash and cash equivalents when it plainly is not
 * one (IAS 7.7 wants an insignificant risk of change in value, and a
 * post-dated cheque is nothing but that risk). The chart wants a 1060 "Cheques
 * in hand" sitting outside those cash codes; adding it is a change to the
 * chart and to three modules this one does not own, so it is named here rather
 * than made silently. Until then the register below is what tells the truth
 * about how much of "cash" is paper with a future date on it.
 *
 * 2050 "Accrued expenses" is the weaker fit of the two — it is a generic
 * current liability rather than a cheques-payable account — but it is the only
 * liability in the chart that means "we owe this, and it is no longer sitting
 * on the supplier's open account". Nothing else in the product posts to it, so
 * the reconciliation below stays clean in practice; the cash-flow statement
 * classifies 2050 and 2000 identically (both operating working capital), so
 * moving a payable into it distorts nothing there.
 */
const CHEQUES_IN_HAND = "1050";
const CHEQUES_ISSUED = "2050";
const AR_CONTROL = "1100";
const AP_CONTROL = "2000";
const BANK = "1010";

/* ------------------------------------------------------------------- helpers */

export type ChequeDirection = "RECEIVED" | "ISSUED";
export type ChequeStatus = "held" | "deposited" | "cleared" | "bounced" | "returned" | "cancelled";

function minor(v: number | bigint | string | undefined | null, what: string): bigint {
  if (v === undefined || v === null || v === "") return 0n;
  if (typeof v === "number" && !Number.isInteger(v)) {
    throw new LedgerError(`${what} must be in whole minor units, got ${v}. Amounts are fils, never a decimal.`);
  }
  if (typeof v === "string" && !/^-?\d+$/.test(v.trim())) {
    throw new LedgerError(`${what} must be in whole minor units, got "${v}".`);
  }
  return BigInt(typeof v === "string" ? v.trim() : v);
}

/**
 * A cheque carries dates, not instants: the day written on the paper. Anchoring
 * them at UTC midnight is what stops a register run from Dubai at nine in the
 * evening putting a cheque a day out from the same register run at nine in the
 * morning.
 */
function asDay(v: Date | string, what: string): Date {
  const d = typeof v === "string" ? new Date(`${v.slice(0, 10)}T00:00:00.000Z`) : v;
  if (Number.isNaN(d.getTime())) throw new LedgerError(`${what} is not a date I can read ("${String(v)}").`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

const day = (d: Date) => d.toISOString().slice(0, 10);
const daysBetween = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / 86_400_000);

/** In hand or with the bank — either way, the paper is still ours and unsettled. */
const isOutstanding = (status: string) => status === "held" || status === "deposited";

interface ChequeLike {
  id: string;
  orgId: string;
  entityId: string;
  direction: string;
  number: string;
  bankName: string | null;
  bankAccount: string;
  counterparty: string;
  counterpartyId: string | null;
  writtenOn: Date;
  dueOn: Date;
  amountMinor: bigint;
  currency: string;
  status: string;
  settlesId: string | null;
  heldEntryId: string | null;
  clearedEntryId: string | null;
  bouncedEntryId: string | null;
  statusOn: Date | null;
  bounceReason: string | null;
  note: string | null;
}

/** Which account holds the paper while it is neither trade balance nor money. */
const holdingAccount = (direction: string) => (direction === "RECEIVED" ? CHEQUES_IN_HAND : CHEQUES_ISSUED);

/** The trade account the debt came out of and goes back to when it fails. */
const tradeAccount = (direction: string) => (direction === "RECEIVED" ? AR_CONTROL : AP_CONTROL);

/* -------------------------------------------------------- the state machine */

/**
 * One legal transition at a time, and a refusal that names where the cheque
 * actually is. "Invalid state" tells a bookkeeper nothing; "it cleared on the
 * 4th, so it cannot be deposited" tells them to go and look at the 4th.
 *
 * `cleared`, `returned` and `cancelled` are terminal. A cleared cheque that
 * should not have cleared is corrected the way every other posted entry is —
 * by reversing the journal — not by walking the status backwards, because the
 * money really did move and the ledger has to keep saying so.
 */
const ALLOWED: Record<ChequeStatus, ChequeStatus[]> = {
  held: ["deposited", "cleared", "bounced", "returned", "cancelled"],
  deposited: ["cleared", "bounced"],
  // Re-presentation: the same paper, in again. See `representCheque`.
  bounced: ["held", "returned", "cancelled"],
  cleared: [],
  returned: [],
  cancelled: [],
};

/** Where the cheque is, said as a state. */
const SAYS: Record<ChequeStatus, string> = {
  held: "in hand",
  deposited: "with the bank",
  cleared: "cleared",
  bounced: "bounced",
  returned: "returned to the counterparty",
  cancelled: "cancelled",
};

/** What the caller was trying to do to it, said as an act. */
const VERB: Record<ChequeStatus, string> = {
  held: "re-presented",
  deposited: "banked",
  cleared: "cleared",
  bounced: "bounced",
  returned: "handed back",
  cancelled: "cancelled",
};

function assertTransition(c: ChequeLike, to: ChequeStatus): void {
  const from = c.status as ChequeStatus;
  if (ALLOWED[from]?.includes(to)) return;
  const options = ALLOWED[from] ?? [];
  throw new LedgerError(
    `Cheque ${c.number} is ${SAYS[from]}${c.statusOn ? ` as at ${day(c.statusOn)}` : ""}, ` +
      `so it cannot be ${VERB[to]}. ` +
      (options.length
        ? `From ${SAYS[from]} it can only be ${options.map((o) => VERB[o]).join(", ")}.`
        : `Nothing further is possible from ${SAYS[from]} — reverse the journal if it was recorded in error.`),
  );
}

/* --------------------------------------------------------------- the log */

/**
 * Every event, in the register, in the order it happened.
 *
 * The schema keeps one entry id per *kind* of state change, which is right for
 * the current state and cannot hold a history: a cheque that bounced twice has
 * two bounce entries and one column. So the register keeps a dated line per
 * event in `note`, and the ledger keeps the journals keyed by the cheque id —
 * between them nothing is lost, and neither is authoritative for what the other
 * knows. The ledger is the record of money; the log is the record of paper,
 * including the moves that were never money at all.
 */
function logged(note: string | null, on: Date, kind: string, detail?: string): string {
  // Whitespace in the detail is collapsed, so a bounce reason or a note typed
  // by a user cannot contain a newline — which is what stops free text from
  // being read back as an event that never happened.
  const line = `${day(on)} ${kind}${detail ? ` — ${detail.replace(/\s+/g, " ").trim()}` : ""}`;
  return note ? `${note}\n${line}` : line;
}

const EVENT_LINE = /^(\d{4}-\d{2}-\d{2}) ([a-z-]+)(?: — (.*))?$/;

export interface ChequeEvent {
  on: string;
  kind: string;
  detail: string | null;
  /** The journal this event raised, where it raised one. */
  entryId: string | null;
  reference: string | null;
}

/* ------------------------------------------------------------------- rows */

export interface ChequeRow {
  id: string;
  direction: ChequeDirection;
  number: string;
  bankName: string | null;
  bankAccount: string;
  counterparty: string;
  counterpartyId: string | null;
  writtenOn: string;
  dueOn: string;
  amountMinor: bigint;
  currency: string;
  status: ChequeStatus;
  settlesId: string | null;
  statusOn: string | null;
  bounceReason: string | null;
  /** Days from the report date to the day it may be presented; negative is past. */
  daysToDue: number;
  /** The diary band, measured on `dueOn` — see `chequeRegister`. */
  bucket: DueBucket;
  /** Still ours and unsettled: in the drawer or with the bank. */
  outstanding: boolean;
  /** How many times this piece of paper has been dishonoured. */
  bounceCount: number;
  heldEntryId: string | null;
  clearedEntryId: string | null;
  bouncedEntryId: string | null;
  accountCode: string;
}

export type DueBucket = "overdue" | "d0_30" | "d31_60" | "d61_90" | "over90";

function bucketOf(daysToDue: number): DueBucket {
  if (daysToDue < 0) return "overdue";
  if (daysToDue <= 30) return "d0_30";
  if (daysToDue <= 60) return "d31_60";
  if (daysToDue <= 90) return "d61_90";
  return "over90";
}

function rowOf(c: ChequeLike, asOf: Date): ChequeRow {
  const daysToDue = daysBetween(asOf, c.dueOn);
  return {
    id: c.id,
    direction: c.direction as ChequeDirection,
    number: c.number,
    bankName: c.bankName,
    bankAccount: c.bankAccount,
    counterparty: c.counterparty,
    counterpartyId: c.counterpartyId,
    writtenOn: day(c.writtenOn),
    dueOn: day(c.dueOn),
    amountMinor: c.amountMinor,
    currency: c.currency,
    status: c.status as ChequeStatus,
    settlesId: c.settlesId,
    statusOn: c.statusOn ? day(c.statusOn) : null,
    bounceReason: c.bounceReason,
    daysToDue,
    bucket: bucketOf(daysToDue),
    outstanding: isOutstanding(c.status),
    bounceCount: bounceCountOf(c.note),
    heldEntryId: c.heldEntryId,
    clearedEntryId: c.clearedEntryId,
    bouncedEntryId: c.bouncedEntryId,
    accountCode: holdingAccount(c.direction),
  };
}

function bounceCountOf(note: string | null): number {
  if (!note) return 0;
  return note.split("\n").filter((l) => EVENT_LINE.exec(l)?.[2] === "bounced").length;
}

/* ------------------------------------------------------------------ loading */

/**
 * Every read and every write goes through here.
 *
 * A cheque id on its own is not authority to touch a cheque: the lookup is by
 * id *and* org *and* entity, so an id guessed or leaked from another tenant
 * finds nothing at all. The same is true of the register and the diary below —
 * neither takes an id it has not scoped itself.
 */
async function loadCheque(orgId: string, entityId: string, chequeId: string) {
  const cheque = await prisma.cheque.findFirst({ where: { id: chequeId, orgId, entityId } });
  if (!cheque) throw new LedgerError("That cheque does not exist.");
  return cheque;
}

type Actor = { actorId?: string; actorType?: "HUMAN" | "RULE" | "MODEL" | "AGENT" | "INTEGRATION" };

/**
 * A cheque in a currency other than the book's is posted the way every other
 * foreign-currency document is: the amount stays in the cheque's currency and
 * carries a rate. There is no rate column on the cheque, because a rate belongs
 * to the day money moves and a cheque moves on several different days.
 */
function fxOf(c: ChequeLike, fxRate: number | undefined, what: string) {
  if (c.currency === "AED") return {};
  if (!(fxRate && fxRate > 0)) {
    throw new LedgerError(
      `Cheque ${c.number} is in ${c.currency} but ${what} carries no exchange rate to AED. Set the rate first.`,
    );
  }
  return { currency: c.currency, fxRate };
}

/* ---------------------------------------------------------------- recording */

export interface RecordChequeResult {
  chequeId: string;
  number: string;
  direction: ChequeDirection;
  entryId: string;
  reference: string;
  /** True when this cheque was already in the register; nothing was posted. */
  alreadyRecorded: boolean;
  cheque: ChequeRow;
}

/**
 * Take a cheque in, or give one out, and post the first journal.
 *
 * Idempotency is on the cheque itself rather than on a key the caller invents:
 * a bank, a number and a direction identify one piece of paper, which is what
 * the unique index in the schema says. So a retry with the same number returns
 * the cheque already recorded, and a *different* cheque presented under a
 * number already used is refused with both amounts named — that is a
 * transposed digit, and finding it now is much cheaper than finding it when
 * one of the two bounces.
 *
 * The entry carries `dueOn` as its due date, so the day the paper can be
 * presented is on the journal and not only in this register, and it carries
 * `settlesId`, so the invoice it pays clears out of the ageing exactly as an
 * ordinary receipt would clear it.
 */
export async function recordCheque(opts: {
  orgId: string;
  entityId: string;
  direction: ChequeDirection;
  number: string;
  counterparty: string;
  counterpartyId?: string | null;
  writtenOn: Date | string;
  dueOn: Date | string;
  amountMinor: number | bigint | string;
  /** The invoice or bill this cheque settles, where it settles one. */
  settlesId?: string | null;
  bankName?: string | null;
  /** The account the money will land in or leave from when it clears. */
  bankAccount?: string;
  currency?: string;
  note?: string | null;
  fxRate?: number;
} & Actor): Promise<RecordChequeResult> {
  const direction = opts.direction;
  if (direction !== "RECEIVED" && direction !== "ISSUED") {
    throw new LedgerError(`A cheque is either RECEIVED from a customer or ISSUED to a supplier, not "${direction}".`);
  }

  const number = (opts.number ?? "").trim();
  const counterparty = (opts.counterparty ?? "").trim();
  if (!number) {
    throw new LedgerError("A cheque needs its number — it is what the bank, the register and any recovery action all quote.");
  }
  if (!counterparty) {
    throw new LedgerError(
      `Cheque ${number} needs a counterparty. A cheque with nobody's name against it cannot be chased and cannot be met.`,
    );
  }

  const amountMinor = minor(opts.amountMinor, `The amount on cheque ${number}`);
  if (amountMinor <= 0n) {
    throw new LedgerError(`Cheque ${number} has to be for a positive amount. A cheque for nothing is not a cheque.`);
  }

  const writtenOn = asDay(opts.writtenOn, `The date written on cheque ${number}`);
  const dueOn = asDay(opts.dueOn, `The due date of cheque ${number}`);
  if (dueOn < writtenOn) {
    throw new LedgerError(
      `Cheque ${number} is dated ${day(dueOn)} but written on ${day(writtenOn)}. ` +
        `A post-dated cheque falls due after it is written; the other way round is a typo, and it would present at once.`,
    );
  }

  const existing = await prisma.cheque.findFirst({
    where: { orgId: opts.orgId, entityId: opts.entityId, direction, number },
  });
  if (existing && existing.amountMinor !== amountMinor) {
    throw new LedgerError(
      `Cheque ${number} is already in the register for ` +
        `${fmtMinor(existing.amountMinor, existing.currency)} from ${existing.counterparty}, ` +
        `and this one is for ${fmtMinor(amountMinor, opts.currency ?? "AED")}. ` +
        `Two different cheques cannot share a number — check the paper for a transposed digit.`,
    );
  }
  if (existing?.heldEntryId) {
    const held = await prisma.journalEntry.findFirst({
      where: { id: existing.heldEntryId, orgId: opts.orgId },
      select: { id: true, series: true, number: true },
    });
    return {
      chequeId: existing.id,
      number: existing.number,
      direction: existing.direction as ChequeDirection,
      entryId: held?.id ?? existing.heldEntryId,
      reference: held ? `${held.series}-${held.number}` : "",
      alreadyRecorded: true,
      cheque: rowOf(existing, asDay(new Date(), "today")),
    };
  }

  // A cheque row with no journal against it is a half-finished record, not a
  // second cheque: complete it rather than colliding on the number.
  const cheque =
    existing ??
    (await prisma.cheque.create({
      data: {
        orgId: opts.orgId,
        entityId: opts.entityId,
        direction,
        number,
        bankName: (opts.bankName ?? "").trim() || null,
        bankAccount: (opts.bankAccount ?? "").trim() || BANK,
        counterparty,
        counterpartyId: opts.counterpartyId ?? null,
        writtenOn,
        dueOn,
        amountMinor,
        currency: opts.currency ?? "AED",
        status: "held",
        settlesId: opts.settlesId ?? null,
        statusOn: writtenOn,
        note: logged(null, writtenOn, direction === "RECEIVED" ? "received" : "issued", opts.note ?? undefined),
      },
    }));

  const entry = await postForCheque(cheque, {
    externalKey: `cheque-hold:${cheque.id}:1`,
    sourceType: direction === "RECEIVED" ? "CHEQUE_RECEIVED" : "CHEQUE_ISSUED",
    entryDate: cheque.writtenOn,
    dueDate: cheque.dueOn,
    memo:
      direction === "RECEIVED"
        ? `Cheque ${cheque.number} from ${cheque.counterparty}, due ${day(cheque.dueOn)}`
        : `Cheque ${cheque.number} to ${cheque.counterparty}, due ${day(cheque.dueOn)}`,
    lines: takeLines(cheque, opts.fxRate),
    actorId: opts.actorId,
    actorType: opts.actorType,
  });

  const saved = await prisma.cheque.update({
    where: { id: cheque.id },
    data: { heldEntryId: entry.id },
  });

  return {
    chequeId: saved.id,
    number: saved.number,
    direction: saved.direction as ChequeDirection,
    entryId: entry.id,
    reference: `${entry.series}-${entry.number}`,
    alreadyRecorded: false,
    cheque: rowOf(saved, asDay(new Date(), "today")),
  };
}

/* ------------------------------------------------------------- the journals */

/**
 * The debt changes form: out of the trade account, into the paper.
 *
 * Both lines carry the open item, and deliberately: `post()` documents the
 * line-level `settlesId` as the one that can express a single entry
 * discharging several documents, and the ageing in `ar.ts` and `ap.ts` reads
 * `line.settlesId ?? entry.settlesId ?? entry.sourceId`. Carrying it on the
 * trade line is what makes the invoice clear out of the ageing here, and
 * carrying it back on the bounce is what puts the customer back exactly where
 * they were — same document, same date, same band.
 */
function takeLines(c: ChequeLike, fxRate: number | undefined): PostLine[] {
  const fx = fxOf(c, fxRate, "the cheque");
  const settles = c.settlesId ?? undefined;
  const held = { account: holdingAccount(c.direction), ...fx, settlesId: settles };
  const trade = { account: tradeAccount(c.direction), ...fx, settlesId: settles };
  return c.direction === "RECEIVED"
    ? [
        { ...held, debit: c.amountMinor, memo: `Cheque ${c.number} — ${c.counterparty}` },
        { ...trade, credit: c.amountMinor, memo: `Settled by cheque ${c.number}, due ${day(c.dueOn)}` },
      ]
    : [
        { ...trade, debit: c.amountMinor, memo: `Settled by cheque ${c.number}, due ${day(c.dueOn)}` },
        { ...held, credit: c.amountMinor, memo: `Cheque ${c.number} — ${c.counterparty}` },
      ];
}

/** The same entry the other way up: the paper failed, the debt goes back. */
function unwindLines(c: ChequeLike, fxRate: number | undefined, why: string): PostLine[] {
  const fx = fxOf(c, fxRate, "the cheque");
  const settles = c.settlesId ?? undefined;
  const held = { account: holdingAccount(c.direction), ...fx, settlesId: settles };
  const trade = { account: tradeAccount(c.direction), ...fx, settlesId: settles };
  return c.direction === "RECEIVED"
    ? [
        { ...trade, debit: c.amountMinor, memo: why },
        { ...held, credit: c.amountMinor, memo: `Cheque ${c.number} — ${c.counterparty}` },
      ]
    : [
        { ...held, debit: c.amountMinor, memo: `Cheque ${c.number} — ${c.counterparty}` },
        { ...trade, credit: c.amountMinor, memo: why },
      ];
}

/** The bank paid it: paper becomes money. */
function clearLines(c: ChequeLike, fxRate: number | undefined): PostLine[] {
  const fx = fxOf(c, fxRate, "the clearing");
  const held = { account: holdingAccount(c.direction), ...fx, settlesId: c.settlesId ?? undefined };
  const bank = { account: c.bankAccount || BANK, ...fx };
  return c.direction === "RECEIVED"
    ? [
        { ...bank, debit: c.amountMinor, memo: `Cheque ${c.number} cleared — ${c.counterparty}` },
        { ...held, credit: c.amountMinor, memo: `Cheque ${c.number} presented` },
      ]
    : [
        { ...held, debit: c.amountMinor, memo: `Cheque ${c.number} presented` },
        { ...bank, credit: c.amountMinor, memo: `Cheque ${c.number} cleared — ${c.counterparty}` },
      ];
}

/**
 * Post one state change, once.
 *
 * The key names the cheque and which presentation of it this is, so a retry
 * after a torn write finds the entry the first attempt made instead of posting
 * the money a second time — and a genuine second presentation, after a bounce,
 * gets its own key rather than being mistaken for that retry.
 */
async function postForCheque(
  c: ChequeLike,
  o: {
    externalKey: string;
    sourceType: string;
    entryDate: Date;
    dueDate?: Date | null;
    memo: string;
    lines: PostLine[];
  } & Actor,
) {
  const already = await prisma.journalEntry.findFirst({
    where: { orgId: c.orgId, externalKey: o.externalKey },
    select: { id: true, series: true, number: true },
  });
  if (already) return { ...already, alreadyPosted: true };

  const entry = await post({
    orgId: c.orgId,
    entityId: c.entityId,
    entryDate: o.entryDate,
    dueDate: o.dueDate ?? null,
    memo: o.memo,
    source: "cheque",
    sourceType: o.sourceType,
    sourceId: c.id,
    settlesId: c.settlesId ?? undefined,
    externalKey: o.externalKey,
    actorType: o.actorType ?? "HUMAN",
    actorId: o.actorId,
    series: "CQ",
    lines: o.lines,
  });
  return { id: entry.id, series: entry.series, number: entry.number, alreadyPosted: false };
}

/* ----------------------------------------------------------- the transitions */

export interface ChequeMoveResult {
  chequeId: string;
  number: string;
  direction: ChequeDirection;
  status: ChequeStatus;
  /** The journal this state change raised, where it raised one. */
  entryId: string | null;
  reference: string | null;
  alreadyPosted: boolean;
  cheque: ChequeRow;
}

/**
 * Hand the cheque to the bank.
 *
 * This is the one state change that raises no journal, and it should not: the
 * paper moved from a drawer to a counter and nothing about what the business
 * owns changed. It is still worth recording, because "in the drawer" and "with
 * the bank" are the difference between a cheque that can still be recalled and
 * one that cannot, and because a cheque that has been with the bank for a week
 * without clearing is a question somebody should be asking.
 */
export async function depositCheque(opts: {
  orgId: string;
  entityId: string;
  chequeId: string;
  on?: Date | string;
  reference?: string | null;
}): Promise<ChequeMoveResult> {
  const c = await loadCheque(opts.orgId, opts.entityId, opts.chequeId);
  assertTransition(c, "deposited");
  const on = asDay(opts.on ?? new Date(), "The date of the deposit");
  if (on < c.writtenOn) {
    throw new LedgerError(
      `Cheque ${c.number} was written on ${day(c.writtenOn)}, so it cannot have been banked on ${day(on)}.`,
    );
  }

  const saved = await prisma.cheque.update({
    where: { id: c.id },
    data: {
      status: "deposited",
      statusOn: on,
      note: logged(c.note, on, "deposited", opts.reference ?? undefined),
    },
  });
  return {
    chequeId: saved.id, number: saved.number, direction: saved.direction as ChequeDirection,
    status: "deposited", entryId: null, reference: null, alreadyPosted: false,
    cheque: rowOf(saved, asDay(new Date(), "today")),
  };
}

/**
 * The bank paid it.
 *
 *   received   Dr bank / Cr cheques in hand
 *   issued     Dr cheques issued / Cr bank
 *
 * The open item was discharged when the cheque was taken — that is what taking
 * a cheque does — so this entry has no trade line to write, and the ageing that
 * cleared then stays clear. `settlesId` rides along on the holding line so the
 * whole chain, invoice to cheque to bank, nets against one document.
 */
export async function clearCheque(opts: {
  orgId: string;
  entityId: string;
  chequeId: string;
  on: Date | string;
  fxRate?: number;
} & Actor): Promise<ChequeMoveResult> {
  const c = await loadCheque(opts.orgId, opts.entityId, opts.chequeId);
  assertTransition(c, "cleared");
  const on = asDay(opts.on, `The date cheque ${c.number} cleared`);
  if (on < c.writtenOn) {
    throw new LedgerError(
      `Cheque ${c.number} was written on ${day(c.writtenOn)} and cannot have cleared on ${day(on)} — ` +
        `money does not move before the paper exists.`,
    );
  }

  const presentation = bounceCountOf(c.note) + 1;
  const entry = await postForCheque(c, {
    externalKey: `cheque-clear:${c.id}:${presentation}`,
    sourceType: "CHEQUE_CLEARED",
    entryDate: on,
    memo: `Cheque ${c.number} cleared — ${c.counterparty}`,
    lines: clearLines(c, opts.fxRate),
    actorId: opts.actorId,
    actorType: opts.actorType,
  });

  const saved = await prisma.cheque.update({
    where: { id: c.id },
    data: {
      status: "cleared",
      statusOn: on,
      clearedEntryId: entry.id,
      note: logged(c.note, on, "cleared", `${entry.series}-${entry.number}`),
    },
  });
  return {
    chequeId: saved.id, number: saved.number, direction: saved.direction as ChequeDirection,
    status: "cleared", entryId: entry.id, reference: `${entry.series}-${entry.number}`,
    alreadyPosted: entry.alreadyPosted, cheque: rowOf(saved, asDay(new Date(), "today")),
  };
}

/**
 * The paper was worthless.
 *
 *   received   Dr trade receivables / Cr cheques in hand
 *   issued     Dr cheques issued / Cr trade payables
 *
 * The debt goes back where it came from, against the same open item, so the
 * customer is exactly where they were — same invoice, same date, same ageing
 * band — plus a bounced cheque on their record.
 *
 * The reason is required and is not a formality. A bounce is what an execution
 * application is built on, and "returned unpaid" with nothing after it is a
 * dead end for whoever has to decide between re-presenting the cheque and
 * going to court. The database says the same thing in a CHECK constraint; this
 * refusal exists so the message names the cheque instead of the constraint.
 */
export async function bounceCheque(opts: {
  orgId: string;
  entityId: string;
  chequeId: string;
  on: Date | string;
  reason: string;
  fxRate?: number;
} & Actor): Promise<ChequeMoveResult> {
  const c = await loadCheque(opts.orgId, opts.entityId, opts.chequeId);
  assertTransition(c, "bounced");

  const reason = (opts.reason ?? "").trim();
  if (!reason) {
    throw new LedgerError(
      `Cheque ${c.number} cannot be marked bounced without the reason the bank gave — insufficient funds, ` +
        `signature mismatch, account closed, a stop order. A bounced cheque is an executive instrument in the UAE ` +
        `and the reason is what any recovery action rests on.`,
    );
  }

  const on = asDay(opts.on, `The date cheque ${c.number} bounced`);
  if (on < c.writtenOn) {
    throw new LedgerError(
      `Cheque ${c.number} was written on ${day(c.writtenOn)} and cannot have bounced on ${day(on)}.`,
    );
  }

  const presentation = bounceCountOf(c.note) + 1;
  const entry = await postForCheque(c, {
    externalKey: `cheque-bounce:${c.id}:${presentation}`,
    sourceType: "CHEQUE_BOUNCED",
    entryDate: on,
    memo: `Cheque ${c.number} bounced — ${c.counterparty}: ${reason}`,
    lines: unwindLines(c, opts.fxRate, `Cheque ${c.number} dishonoured: ${reason}`),
    actorId: opts.actorId,
    actorType: opts.actorType,
  });

  const saved = await prisma.cheque.update({
    where: { id: c.id },
    data: {
      status: "bounced",
      statusOn: on,
      bounceReason: reason,
      bouncedEntryId: entry.id,
      note: logged(c.note, on, "bounced", reason),
    },
  });
  return {
    chequeId: saved.id, number: saved.number, direction: saved.direction as ChequeDirection,
    status: "bounced", entryId: entry.id, reference: `${entry.series}-${entry.number}`,
    alreadyPosted: entry.alreadyPosted, cheque: rowOf(saved, asDay(new Date(), "today")),
  };
}

/**
 * Put a bounced cheque in again.
 *
 * A bounced cheque is very often presented a second time, by agreement, once
 * the drawer says the funds are there. Modelled as a transition on the same
 * record, not as a new cheque record pointing back at the old one.
 *
 * The alternative was wrong for a plain reason: the schema's unique index on
 * (org, entity, direction, number) is not an obstacle to route around, it is
 * the statement that a cheque number identifies one piece of paper. A second
 * record would have to carry a number nobody wrote on the cheque — 1234/2, or
 * 1234-R — and then the register would hold two cheques where the drawer's
 * chequebook has one stub, the bank has one instrument, and any execution
 * application quotes one number. Nothing is lost by keeping one record: the
 * bounce reason and its date stay on it, every presentation has its own
 * journal in the ledger keyed by the cheque id, and `chequeDetail` reads the
 * whole history back.
 *
 * The journal is the original one again — the paper goes back out of
 * receivables and into cheques in hand — under a key naming the presentation,
 * so it is a new posting rather than an idempotent repeat of the first.
 */
export async function representCheque(opts: {
  orgId: string;
  entityId: string;
  chequeId: string;
  on: Date | string;
  fxRate?: number;
  note?: string | null;
} & Actor): Promise<ChequeMoveResult> {
  const c = await loadCheque(opts.orgId, opts.entityId, opts.chequeId);
  assertTransition(c, "held");
  const on = asDay(opts.on, `The date cheque ${c.number} was re-presented`);
  const presentation = bounceCountOf(c.note) + 1;

  const entry = await postForCheque(c, {
    externalKey: `cheque-hold:${c.id}:${presentation}`,
    sourceType: "CHEQUE_REPRESENTED",
    entryDate: on,
    dueDate: on > c.dueOn ? null : c.dueOn,
    memo: `Cheque ${c.number} re-presented (presentation ${presentation}) — ${c.counterparty}`,
    lines: takeLines(c, opts.fxRate),
    actorId: opts.actorId,
    actorType: opts.actorType,
  });

  const saved = await prisma.cheque.update({
    where: { id: c.id },
    data: {
      status: "held",
      statusOn: on,
      heldEntryId: entry.id,
      // The bounce reason stays: it is the history of this piece of paper, and
      // a cheque being presented for the third time is a fact about the
      // customer that nobody should have to dig for.
      note: logged(c.note, on, "re-presented", opts.note ?? `presentation ${presentation}`),
    },
  });
  return {
    chequeId: saved.id, number: saved.number, direction: saved.direction as ChequeDirection,
    status: "held", entryId: entry.id, reference: `${entry.series}-${entry.number}`,
    alreadyPosted: entry.alreadyPosted, cheque: rowOf(saved, asDay(new Date(), "today")),
  };
}

/**
 * The paper goes back to whoever wrote it, or is voided.
 *
 * `returned` is the cheque handed back intact — the customer paid by transfer
 * instead, or replaced it with a later one. `cancelled` is the cheque voided:
 * spoiled, stopped, never to be presented. They are different facts about the
 * paper and the register keeps them apart, but they do the same thing to the
 * books, which is to undo the journal that took the cheque in.
 *
 * Except when the cheque has already bounced. A bounce has *already* put the
 * debt back on the trade account, so a returned or cancelled bounced cheque
 * posts nothing at all — posting the unwind again would credit cheques in hand
 * twice and leave the customer owing double. This is the one place in the file
 * where the journal depends on where the cheque has been rather than on where
 * it is going.
 */
export interface CloseOutInput extends Actor {
  orgId: string;
  entityId: string;
  chequeId: string;
  on?: Date | string;
  reason?: string | null;
  fxRate?: number;
}

async function closeOut(to: "returned" | "cancelled", opts: CloseOutInput): Promise<ChequeMoveResult> {
  const c = await loadCheque(opts.orgId, opts.entityId, opts.chequeId);
  assertTransition(c, to);
  const on = asDay(opts.on ?? new Date(), `The date cheque ${c.number} was ${to}`);
  const reason = (opts.reason ?? "").trim() || null;

  const why =
    to === "returned"
      ? `Cheque ${c.number} returned to ${c.counterparty}${reason ? `: ${reason}` : ""}`
      : `Cheque ${c.number} cancelled${reason ? `: ${reason}` : ""}`;

  const entry = isOutstanding(c.status)
    ? await postForCheque(c, {
        externalKey: `cheque-${to}:${c.id}`,
        sourceType: to === "returned" ? "CHEQUE_RETURNED" : "CHEQUE_CANCELLED",
        entryDate: on,
        memo: why,
        lines: unwindLines(c, opts.fxRate, why),
        actorId: opts.actorId,
        actorType: opts.actorType,
      })
    : null;

  const saved = await prisma.cheque.update({
    where: { id: c.id },
    data: {
      status: to,
      statusOn: on,
      note: logged(c.note, on, to, reason ?? (entry ? undefined : "already off the books — it had bounced")),
    },
  });
  return {
    chequeId: saved.id, number: saved.number, direction: saved.direction as ChequeDirection,
    status: to, entryId: entry?.id ?? null,
    reference: entry ? `${entry.series}-${entry.number}` : null,
    alreadyPosted: entry?.alreadyPosted ?? false,
    cheque: rowOf(saved, asDay(new Date(), "today")),
  };
}

/** The cheque goes back to whoever wrote it, intact and unpresented. */
export const returnCheque = (opts: CloseOutInput): Promise<ChequeMoveResult> => closeOut("returned", opts);

/** The cheque is void — spoiled, stopped, never to be presented. */
export const cancelCheque = (opts: CloseOutInput): Promise<ChequeMoveResult> => closeOut("cancelled", opts);

/* ------------------------------------------------------------- the register */

export interface DirectionRegister {
  direction: ChequeDirection;
  accountCode: string;
  held: ChequeRow[];
  deposited: ChequeRow[];
  cleared: ChequeRow[];
  bounced: ChequeRow[];
  closed: ChequeRow[];
  heldMinor: bigint;
  depositedMinor: bigint;
  /** Held plus deposited: what the holding account should carry. */
  outstandingMinor: bigint;
  clearedMinor: bigint;
  bouncedMinor: bigint;
  /** The outstanding paper, aged by the day it may be presented. */
  buckets: Record<DueBucket, bigint>;
  /** What the ledger's holding account carries at `asOf`, as a positive figure. */
  ledgerMinor: bigint;
  /** ledger − register. Anything but nil needs a person. */
  differenceMinor: bigint;
  reconciled: boolean;
  count: number;
}

/**
 * The register: what is in the drawer, what is with the bank, what has cleared,
 * and whether the whole lot ties to the ledger.
 *
 * **Aged by `dueOn`, never by `writtenOn`.** That is the entire difference
 * between a cheque register and an ordinary ageing: a cheque written in January
 * and dated for June is not five months old and overdue, it is four months
 * away, and a report that files it by the date written says precisely the wrong
 * thing about it. The bands are days from the report date to the day it may be
 * presented, forwards; the one backwards band is `overdue`, which is a cheque
 * whose date has passed and which has still not cleared — the one that needs
 * chasing today. (A cheque more than six months past its date is stale and a
 * UAE bank will refuse it, so a figure sitting in `overdue` is not merely late,
 * it has a shelf life.)
 *
 * The reconciliation is the control, and it is deliberately taken from two
 * independent places: the register total comes from the cheque rows, the ledger
 * balance from the journal lines. A difference means the subledger and the
 * books have drifted — a cheque cleared in the ledger and never marked, or a
 * journal posted to the holding account by hand — and it is reported rather
 * than reconciled away.
 *
 * One honest limitation, on a past `asOf`: the register keeps one status and
 * the date it changed, so a cheque whose latest change is *after* `asOf` is
 * known to have been outstanding then but not whether it was in the drawer or
 * with the bank. The split is therefore approximate for a back-dated run; the
 * outstanding total is not, because both states sit in the same account, and
 * that total is what the reconciliation is against.
 */
export async function chequeRegister(opts: {
  orgId: string;
  entityId: string;
  asOf?: Date | string;
}): Promise<{
  asOf: string;
  received: DirectionRegister;
  issued: DirectionRegister;
  reconciled: boolean;
  outstandingMinor: bigint;
}> {
  const asOf = asDay(opts.asOf ?? new Date(), "The register date");

  const cheques = await prisma.cheque.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, writtenOn: { lte: asOf } },
    orderBy: [{ dueOn: "asc" }, { number: "asc" }],
  });

  const ledger = await holdingBalances(opts.orgId, opts.entityId, asOf);

  const build = (direction: ChequeDirection): DirectionRegister => {
    const mine = cheques.filter((c) => c.direction === direction);
    const held: ChequeRow[] = [], deposited: ChequeRow[] = [], cleared: ChequeRow[] = [];
    const bounced: ChequeRow[] = [], closed: ChequeRow[] = [];
    const buckets: Record<DueBucket, bigint> = { overdue: 0n, d0_30: 0n, d31_60: 0n, d61_90: 0n, over90: 0n };

    for (const c of mine) {
      const row = rowOf(c, asOf);
      // What it was at `asOf`: a change dated after the report had not happened
      // yet, and the state before any change is the drawer.
      const asAt: ChequeStatus =
        c.statusOn && c.statusOn > asOf ? "held" : (c.status as ChequeStatus);
      const at = { ...row, status: asAt, outstanding: isOutstanding(asAt) };
      if (isOutstanding(asAt)) {
        (asAt === "held" ? held : deposited).push(at);
        buckets[at.bucket] += c.amountMinor;
      } else if (asAt === "cleared") cleared.push(at);
      else if (asAt === "bounced") bounced.push(at);
      else closed.push(at);
    }

    const sum = (rows: ChequeRow[]) => rows.reduce((a, r) => a + r.amountMinor, 0n);
    const heldMinor = sum(held);
    const depositedMinor = sum(deposited);
    const outstandingMinor = heldMinor + depositedMinor;
    const accountCode = holdingAccount(direction);
    const ledgerMinor = ledger.get(accountCode) ?? 0n;
    const differenceMinor = ledgerMinor - outstandingMinor;

    return {
      direction, accountCode,
      held, deposited, cleared, bounced, closed,
      heldMinor, depositedMinor, outstandingMinor,
      clearedMinor: sum(cleared), bouncedMinor: sum(bounced),
      buckets, ledgerMinor, differenceMinor,
      reconciled: differenceMinor === 0n,
      count: mine.length,
    };
  };

  const received = build("RECEIVED");
  const issued = build("ISSUED");
  return {
    asOf: day(asOf),
    received,
    issued,
    reconciled: received.reconciled && issued.reconciled,
    outstandingMinor: received.outstandingMinor + issued.outstandingMinor,
  };
}

/**
 * What the two holding accounts carry at a date, from the journal lines.
 *
 * Both halves of a reversed pair are read, or a reversal would move the ledger
 * side and not the register side and the reconciliation would blame the
 * register. Cheques issued sits on the credit side, so its balance is negated
 * to read as the positive obligation the register counts.
 */
async function holdingBalances(orgId: string, entityId: string, asOf: Date): Promise<Map<string, bigint>> {
  const accounts = await prisma.account.findMany({
    where: { orgId, entityId, code: { in: [CHEQUES_IN_HAND, CHEQUES_ISSUED] } },
    select: { id: true, code: true },
  });
  const out = new Map<string, bigint>([[CHEQUES_IN_HAND, 0n], [CHEQUES_ISSUED, 0n]]);
  if (!accounts.length) return out;

  const byId = new Map(accounts.map((a) => [a.id, a.code]));
  const lines = await prisma.journalLine.findMany({
    where: {
      orgId,
      accountId: { in: accounts.map((a) => a.id) },
      entry: { status: { in: ["posted", "reversed"] }, entryDate: { lte: asOf } },
    },
    select: { accountId: true, functionalAmountMinor: true },
  });
  for (const l of lines) {
    const code = byId.get(l.accountId);
    if (!code) continue;
    const signed = code === CHEQUES_ISSUED ? -l.functionalAmountMinor : l.functionalAmountMinor;
    out.set(code, (out.get(code) ?? 0n) + signed);
  }
  return out;
}

/* ----------------------------------------------------------------- the diary */

export interface DueSoonRow extends ChequeRow {
  /** Every issued cheque due on or before this one, this bank account, summed. */
  cumulativeMinor: bigint;
  /** The balance of the account it will be drawn on, today. */
  bankMinor: bigint;
  /** False when the cheques due by this date come to more than the bank holds. */
  covered: boolean;
  shortfallMinor: bigint;
}

/**
 * What falls due in the next `days`, both ways round, and whether the issued
 * ones can actually be met.
 *
 * An issued cheque falling due with no money behind it is the thing this
 * feature exists to prevent, and it is not a hypothetical: in the UAE the
 * consequence lands on the person who signed it. So each issued cheque is
 * measured against the balance of the account it is drawn on, cumulatively and
 * in due order — the third cheque of the week is met out of what the first two
 * left, not out of the opening balance.
 *
 * The cover test deliberately ignores the cheques *received* that fall due in
 * the same window, even though they are shown beside them. A business that
 * meets its own cheques out of cheques it has been handed is one dishonour away
 * from dishonouring its own, and a report that nets the two would hide exactly
 * that. The incoming total is reported separately so the reader can do that
 * arithmetic knowingly rather than have it done for them.
 *
 * Cheques already past due and still not cleared are included rather than
 * filtered out: they are more urgent than anything in the window, not less.
 */
export async function dueSoon(opts: {
  orgId: string;
  entityId: string;
  days?: number;
  asOf?: Date | string;
}): Promise<{
  asOf: string;
  days: number;
  until: string;
  received: ChequeRow[];
  issued: DueSoonRow[];
  receivedMinor: bigint;
  issuedMinor: bigint;
  bankMinor: bigint;
  shortfallMinor: bigint;
  uncoveredCount: number;
  /** The first day the account is committed beyond its balance, if any. */
  firstShortDay: string | null;
}> {
  const days = Math.max(0, Math.trunc(opts.days ?? 30));
  const asOf = asDay(opts.asOf ?? new Date(), "The diary date");
  const until = new Date(asOf.getTime() + days * 86_400_000);

  const cheques = await prisma.cheque.findMany({
    where: {
      orgId: opts.orgId,
      entityId: opts.entityId,
      status: { in: ["held", "deposited"] },
      dueOn: { lte: until },
    },
    orderBy: [{ dueOn: "asc" }, { number: "asc" }],
  });

  const received = cheques.filter((c) => c.direction === "RECEIVED").map((c) => rowOf(c, asOf));
  const issuedRaw = cheques.filter((c) => c.direction === "ISSUED");

  const codes = [...new Set([BANK, ...issuedRaw.map((c) => c.bankAccount || BANK)])];
  const balances = await ledgerBalances({ orgId: opts.orgId, entityId: opts.entityId, codes });

  const running = new Map<string, bigint>();
  let shortfallMinor = 0n;
  let firstShortDay: string | null = null;
  const issued: DueSoonRow[] = issuedRaw.map((c) => {
    const account = c.bankAccount || BANK;
    const cumulative = (running.get(account) ?? 0n) + c.amountMinor;
    running.set(account, cumulative);
    const bank = balances.get(account) ?? 0n;
    const short = cumulative > bank ? cumulative - bank : 0n;
    if (short > shortfallMinor) shortfallMinor = short;
    if (short > 0n && firstShortDay === null) firstShortDay = day(c.dueOn);
    return {
      ...rowOf(c, asOf),
      cumulativeMinor: cumulative,
      bankMinor: bank,
      covered: short === 0n,
      shortfallMinor: short,
    };
  });

  return {
    asOf: day(asOf),
    days,
    until: day(until),
    received,
    issued,
    receivedMinor: received.reduce((a, r) => a + r.amountMinor, 0n),
    issuedMinor: issued.reduce((a, r) => a + r.amountMinor, 0n),
    bankMinor: codes.reduce((a, code) => a + (balances.get(code) ?? 0n), 0n),
    shortfallMinor,
    uncoveredCount: issued.filter((r) => !r.covered).length,
    firstShortDay,
  };
}

/* ---------------------------------------------------------------- one cheque */

/**
 * One cheque, and everything that has happened to it.
 *
 * The events come from the register's log, which holds them all — including
 * the deposit, which never reached the ledger — and each posting event is
 * matched to its journal by kind and order, since the two lists are appended in
 * the same order. A cheque that has been round twice therefore reads as two
 * presentations rather than as one row with the second one's dates.
 */
export async function chequeDetail(opts: {
  orgId: string;
  entityId: string;
  chequeId: string;
  asOf?: Date | string;
}): Promise<{ cheque: ChequeRow; history: ChequeEvent[] }> {
  const c = await loadCheque(opts.orgId, opts.entityId, opts.chequeId);
  const asOf = asDay(opts.asOf ?? new Date(), "The register date");

  const entries = await prisma.journalEntry.findMany({
    where: { orgId: opts.orgId, entityId: opts.entityId, source: "cheque", sourceId: c.id },
    select: { id: true, series: true, number: true, sourceType: true, entryDate: true },
    orderBy: [{ entryDate: "asc" }, { createdAt: "asc" }],
  });

  const OF_KIND: Record<string, string> = {
    received: "CHEQUE_RECEIVED",
    issued: "CHEQUE_ISSUED",
    cleared: "CHEQUE_CLEARED",
    bounced: "CHEQUE_BOUNCED",
    "re-presented": "CHEQUE_REPRESENTED",
    returned: "CHEQUE_RETURNED",
    cancelled: "CHEQUE_CANCELLED",
  };
  const queue = new Map<string, { id: string; series: string; number: string }[]>();
  for (const e of entries) {
    const list = queue.get(e.sourceType ?? "") ?? [];
    list.push(e);
    queue.set(e.sourceType ?? "", list);
  }

  const history: ChequeEvent[] = [];
  for (const line of (c.note ?? "").split("\n")) {
    const m = EVENT_LINE.exec(line.trim());
    if (!m) continue;
    const [, on, kind, detail] = m;
    const next = queue.get(OF_KIND[kind] ?? "")?.shift() ?? null;
    history.push({
      on, kind, detail: detail ?? null,
      entryId: next?.id ?? null,
      reference: next ? `${next.series}-${next.number}` : null,
    });
  }

  return { cheque: rowOf(c, asOf), history };
}

export {
  CHEQUES_IN_HAND as CHEQUES_IN_HAND_ACCOUNT,
  CHEQUES_ISSUED as CHEQUES_ISSUED_ACCOUNT,
};
