import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { parseAmount } from "@/lib/ledger/format";

/**
 * Four more operations that were built, guarded and routed — and reachable
 * from no screen.
 *
 * `screens-unwired-actions.test.ts` states the idea and holds the first three;
 * `screens-unreachable-operations.test.ts` holds the fourth and fifth. This
 * holds the next four, and they failed in three different ways, which is why
 * the checks below are not all the same shape:
 *
 *   a quotation or sales order could not be edited. `updateOrder` had always
 *   accepted the change and drawn the line in the right place — freely while
 *   the customer has only an offer, never below what has been invoiced once
 *   they have agreed — and the screen offered cancel-and-rekey instead, which
 *   burns a number out of a gapless sequence to fix a typo and leaves the
 *   customer quoting a document the business has abandoned;
 *
 *   the cheque screen had no currency field, so `recordCheque`'s
 *   foreign-currency path could not be reached at all and every cheque was
 *   read at two decimal places — wrong by a factor of ten for a Kuwaiti,
 *   Bahraini or Omani cheque;
 *
 *   a project's budget could not be revised, so the quoted figure every
 *   percentage on the job-costing screen is measured against was write-once;
 *
 *   and the IFRS 15 contract-balance disclosure had no screen at all.
 *
 * The generalised check is the first one, and it is the one that would have
 * caught two of the four on its own: every action a POST handler accepts has
 * to be sent by the screen that owns it. The rest are about what the screens
 * then say, because a control that is present and wrong is worse than one that
 * is missing.
 */

const read = (path: string) => {
  expect(existsSync(path), `${path} is missing`).toBe(true);
  return readFileSync(path, "utf8");
};

/**
 * The actions a POST handler accepts, taken from its own body — the same
 * extraction `screens-unwired-actions.test.ts` uses, written out again rather
 * than exported from there. A test file that imports another test file's
 * helpers runs that file's suite as a side effect, and two suites sharing a
 * database fixture through an import is a debugging session nobody needs.
 */
function actionsOf(routePath: string): string[] {
  const source = read(routePath);
  const post = source.slice(source.indexOf("export async function POST"));
  expect(post.length).toBeGreaterThan(0);
  const found = new Set<string>();
  for (const m of post.matchAll(/case "([a-zA-Z_]+)":/g)) found.add(m[1]);
  for (const m of post.matchAll(/b\.action === "([a-zA-Z_]+)"/g)) found.add(m[1]);
  return [...found].sort();
}

/** The screen and every ledger component it hands work to. */
function screenAndParts(screenPath: string): string {
  const screen = read(screenPath);
  const parts = [...screen.matchAll(/from "@\/components\/ledger\/([a-z0-9-]+)"/g)].map((m) => {
    const base = `src/components/ledger/${m[1]}`;
    return read(existsSync(`${base}.tsx`) ? `${base}.tsx` : `${base}.ts`);
  });
  return [screen, ...parts].join("\n");
}

const ORDERS_ROUTE = "src/app/api/ledger/sales-orders/route.ts";
const ORDERS = "src/app/(app)/accounting/sales-orders/page.tsx";
const CHEQUES_ROUTE = "src/app/api/ledger/cheques/route.ts";
const CHEQUES = "src/app/(app)/accounting/cheques/page.tsx";
const PROJECTS_ROUTE = "src/app/api/ledger/projects/route.ts";
const PROJECTS = "src/app/(app)/accounting/projects/page.tsx";
const REVENUE = "src/app/(app)/accounting/revenue/page.tsx";
const ORDER_EDITOR = "src/components/ledger/order-edit.tsx";
const SALES_ORDERS_MODULE = "src/lib/server/ledger/sales-orders.ts";

describe("every routed write on these four screens is reachable from the screen", () => {
  const SCREENS: { route: string; screen: string; what: string }[] = [
    { route: ORDERS_ROUTE, screen: ORDERS, what: "the sales-order screen changes a document as well as moving it along" },
    { route: CHEQUES_ROUTE, screen: CHEQUES, what: "the cheque screen sends every step the register accepts" },
    { route: PROJECTS_ROUTE, screen: PROJECTS, what: "the projects screen creates, updates and closes a job" },
  ];

  for (const { route, screen, what } of SCREENS) {
    it(what, () => {
      const actions = actionsOf(route);
      // The extraction itself has to be working, or an empty set would pass.
      expect(actions.length).toBeGreaterThan(1);
      const source = screenAndParts(screen);
      const missing = actions.filter((a) => !source.includes(`action: "${a}"`));
      expect(missing, `${screen} sends nothing for ${missing.join(", ")}`).toEqual([]);
    });
  }
});

describe("the sales-order editor draws the line where the subledger draws it", () => {
  /**
   * The two lists are read out of the two files and compared, rather than one
   * being written down twice. A screen that offers an edit the subledger will
   * refuse teaches a rule that is not the rule; a screen that refuses one the
   * subledger allows sends somebody back to cancel-and-rekey for nothing.
   */
  it("offers the edit in exactly the states updateOrder accepts", () => {
    const module = read(SALES_ORDERS_MODULE);
    const guard = /if \(!\[([^\]]*)\]\.includes\(status\)\) \{\s*refuse\(order, "changed"\)/.exec(module);
    expect(guard, "updateOrder no longer guards on a list of statuses — reread it").not.toBeNull();
    const server = [...guard![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(server.length).toBeGreaterThan(0);

    const editor = read(ORDER_EDITOR);
    const declared = /export const EDITABLE = \[([^\]]*)\]/.exec(editor);
    expect(declared, "order-edit.tsx no longer declares EDITABLE").not.toBeNull();
    const screen = [...declared![1].matchAll(/"([a-z_]+)"/g)].map((m) => m[1]).sort();

    expect(screen).toEqual(server);
  });

  it("refuses to cut a line below what has already been invoiced", () => {
    const editor = read(ORDER_EDITOR);
    // The comparison itself, in BigInt. `invoicedMilli` is a quantity in
    // thousandths and a float would lose the edge exactly where it matters.
    expect(editor).toContain("qty < invoiced");
    expect(editor).toMatch(/cannot be taken off the order/);
  });

  it("keeps one parser for what a typed quantity means", () => {
    // Both files reading `toMilli` from the same module is the point: the
    // editor and the list disagreeing about "1.5" would disagree between what
    // a person typed and what the document then says.
    expect(read(ORDERS)).toContain('from "@/components/ledger/order-edit"');
    expect(read(ORDERS)).not.toMatch(/function toMilli\(/);
    expect(read(ORDER_EDITOR)).toMatch(/export function toMilli\(/);
  });
});

describe("the cheque screen can reach the foreign-currency path", () => {
  it("asks which currency the cheque is in, and sends it", () => {
    const source = read(CHEQUES);
    expect(source).toContain("cheque-currency");
    expect(source).toMatch(/currency,/);
  });

  it("parses the amount at that currency's exponent rather than at two places", () => {
    const source = read(CHEQUES);
    // The defect exactly: `parseAmount(f.amount)` defaults to two decimals.
    expect(source).not.toMatch(/parseAmount\(f\.amount\)/);
    expect(source).toContain("parseAmount(f.amount, currency)");
  });

  it("asks for the rate on every step that posts, and on none that does not", () => {
    const source = read(CHEQUES);
    expect(source).toContain("cheque-fx-rate");
    expect(source).toContain("move-fx-rate");
    // Banking a cheque raises no journal, and neither does handing back or
    // cancelling one that has already bounced — the bounce put the debt back.
    expect(source).toMatch(/if \(to === "deposited"\) return false;/);
    expect(source).toMatch(/cheque\.status === "bounced" && \(to === "returned" \|\| to === "cancelled"\)/);
  });

  it("does not call a translation a finding, and says which basis it translated on", () => {
    // `chequeRegister` used to add face amounts across currencies and set the
    // result against a functional-currency balance, so the difference was a
    // translation and the chip beside it called it a finding — telling somebody
    // their books were broken when they were not. It now translates each
    // foreign cheque at the rate its own opening journal carried, and states
    // that basis rather than leaving the reader to assume one.
    const source = read(CHEQUES);
    expect(source).toContain("register.comparable");
    expect(source).toMatch(/basis/);
    // The one case that still cannot be subtracted: a foreign cheque whose
    // opening journal carries no rate. The chip must claim neither way.
    expect(source).toContain("not comparable");
    expect(source).toMatch(/!comparable \? "sw-chip-warn"/);
  });

  it("reads 250 differently in a dirham and in a dinar", () => {
    // What the missing field cost: three-decimal currencies were being read
    // as two, so a KWD 250 cheque was recorded as a quarter of its value.
    expect(parseAmount("250", "AED")).toBe(25_000n);
    expect(parseAmount("250", "KWD")).toBe(250_000n);
    expect(parseAmount("250.000", "KWD")).toBe(250_000n);
    expect(parseAmount("250", "JPY")).toBe(250n);
  });
});

describe("a project budget can be revised, and the figure it replaces is shown", () => {
  it("sends the revision through the update the route already accepts", () => {
    const source = screenAndParts(PROJECTS);
    expect(source).toContain('action: "update"');
    expect(source).toContain("budgetMinor");
  });

  it("prints the original beside the revision before it is saved", () => {
    const panel = read("src/components/ledger/project-budget.tsx");
    expect(panel).toContain("budget-before");
    expect(panel).toContain("budget-after");
    expect(panel).toContain("budget-movement");
    // And what it does to the percentage every report reads off the budget.
    expect(panel).toContain("consumed-after");
  });

  it("says that the figure it replaces is not kept anywhere", () => {
    // A project row carries one budget and there is no history behind it.
    // Implying otherwise would be a reassurance the schema cannot honour.
    const panel = read("src/components/ledger/project-budget.tsx");
    expect(panel).toContain("budget-history-note");
    expect(panel).toMatch(/no revision history/);
  });

  it("parses the budget with the ledger's own parser rather than a float", () => {
    const panel = read("src/components/ledger/project-budget.tsx");
    expect(panel).not.toMatch(/Number\([^)]*\)\s*\*\s*100/);
    expect(panel).toContain("parseAmount");
  });
});

describe("the revenue screen carries the IFRS 15 contract-balance disclosure", () => {
  it("states both contract balances from the accounts themselves", () => {
    const source = read(REVENUE);
    expect(source).toContain("note-contract-asset");
    expect(source).toContain("note-contract-liability");
    expect(source).toContain("Contract balances — IFRS 15.116");
    // Read from 1310 and 2310 rather than from the register, so the note
    // agrees with the balance sheet and not merely with the page it is on.
    expect(source).toContain("rec.ledgerAssetMinor");
    expect(source).toContain("rec.ledgerLiabilityMinor");
  });

  it("names every figure the disclosure asks for that these books cannot give", () => {
    const source = read(REVENUE);
    expect(source).toContain("note-gaps");
    // The two `contractBalancesNote` itself lists as not derivable, and the
    // reason: recognition corrects to a target rather than posting increments.
    expect(source).toContain("15.116(b)");
    expect(source).toContain("15.116(c)");
    expect(source).toMatch(/rather than\s+posting an increment/);
    // And the two it is silent about: receivables, and 15.120 — which must not
    // be answered with the "still to earn" total, because that one counts the
    // cancelled and completed contracts the disclosure leaves out.
    expect(source).toContain("IFRS 15.120");
    expect(source).toContain("15.120(b)");
    expect(source).toMatch(/Receivables from contracts with customers/);
    // 15.120 must not be answered with the "still to earn" total, which counts
    // the cancelled and the completed — neither of which has anything left to
    // deliver, and so neither of which belongs in a remaining-price figure.
    expect(source).toMatch(/still to earn/);
    expect(source).toMatch(/cancelled and the completed/);
  });

  it("prints both ends of the period, because it now has both", () => {
    // The panel first shipped with today's position only, and said so rather
    // than inventing an opening figure. `contractBalancesNote` is now served
    // over a from/to pair, so IFRS 15.116(a) gets the answer it asks for: the
    // contract asset and contract liability at the opening AND the close.
    const source = read(REVENUE);
    expect(source).toContain("note-opening-asset");
    expect(source).toContain("note-opening-liability");
    expect(source).toContain("openingAssetMinor");
    expect(source).toContain("openingLiabilityMinor");
    // Both ends and the movement between them, which is what makes the pair a
    // disclosure rather than two balances printed next to each other.
    expect(source).toContain("note-asset-movement");
    expect(source).toContain("assetMovementMinor");
    expect(source).toContain("liabilityMovementMinor");
  });
});
