import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";

/**
 * Two more operations that were built, guarded, routed — and reachable from no
 * screen. The sibling file screens-unwired-actions.test.ts found the first
 * three; these are the fourth and the fifth, and they were invisible for the
 * same reason the first three were: every module test proves the verb works and
 * every route test proves the endpoint accepts it, and nothing asks whether a
 * person using the product can get to it.
 *
 *   A fixed asset could not be disposed of. `disposeAsset` posts the proceeds,
 *   writes back the depreciation, takes the cost off and books the gain or loss
 *   — and the assets screen had a register, an Add button and a depreciation
 *   run, and no way to take anything off. A van that was sold went on
 *   depreciating every month afterwards, its cost stayed on the balance sheet,
 *   and the profit or loss on selling it never reached the income statement.
 *
 *   An expense claim sent back to draft could not be fixed. `claimDetail`
 *   returned the claim and its lines and nothing opened it, so the rejection
 *   dialog's promise — "the claim can be sent back to draft afterwards, fixed
 *   and submitted again" — was true of the server and false of the product: the
 *   only thing a draft claim offered was the Submit button that sent the same
 *   claim back unchanged.
 *
 * The extraction below reads the actions off the ROUTE rather than off a list
 * kept beside it, so a verb added to a handler and forgotten in the browser
 * fails this without anybody remembering to add it here.
 */

const read = (path: string) => {
  expect(existsSync(path), `${path} is missing`).toBe(true);
  return readFileSync(path, "utf8");
};

/**
 * The actions a POST handler accepts, taken from its own body.
 *
 * The action names are matched case-insensitively on purpose. A `case
 * "addLine":` is invisible to a lower-case-only pattern, and `addLine` and
 * `removeLine` are exactly the two verbs that make a rejected claim
 * correctable — so a check written to catch an unreachable verb would have
 * skipped the two unreachable verbs that mattered most here.
 */
function actionsOf(routePath: string): string[] {
  const source = read(routePath);
  const post = source.slice(source.indexOf("export async function POST"));
  expect(post.length).toBeGreaterThan(0);
  const found = new Set<string>();
  for (const m of post.matchAll(/case "([A-Za-z_]+)":/g)) found.add(m[1]);
  for (const m of post.matchAll(/b\.action === "([A-Za-z_]+)"/g)) found.add(m[1]);
  return [...found].sort();
}

/**
 * The screen and everything it renders.
 *
 * A screen that hands the work to a component has still wired the verb, so the
 * ledger components it imports are read with it — otherwise the only way to
 * pass would be to push a route's whole surface into one file.
 */
function screenAndParts(screenPath: string): string {
  const screen = read(screenPath);
  const parts = [...screen.matchAll(/from "@\/components\/ledger\/([a-z0-9-]+)"/g)].map((m) => {
    const base = `src/components/ledger/${m[1]}`;
    return read(existsSync(`${base}.tsx`) ? `${base}.tsx` : `${base}.ts`);
  });
  return [screen, ...parts].join("\n");
}

const ASSETS_ROUTE = "src/app/api/ledger/assets/route.ts";
const ASSETS_SCREEN = "src/app/(app)/accounting/assets/page.tsx";
const DISPOSAL = "src/components/ledger/asset-dispose.tsx";

const EXPENSES_ROUTE = "src/app/api/ledger/expenses/route.ts";
const EXPENSES_SCREEN = "src/app/(app)/accounting/expenses/page.tsx";
const CLAIM_DETAIL = "src/components/ledger/claim-detail.tsx";

describe("every routed write on these two screens is reachable from the browser", () => {
  it("the assets screen registers, depreciates AND disposes", () => {
    const actions = actionsOf(ASSETS_ROUTE);
    expect(actions).toContain("dispose");
    const source = screenAndParts(ASSETS_SCREEN);
    const missing = actions.filter((a) => !source.includes(`action: "${a}"`));
    expect(missing, `${ASSETS_SCREEN} sends nothing for ${missing.join(", ")}`).toEqual([]);
  });

  it("the expenses screen drafts, corrects, submits and settles a claim", () => {
    const actions = actionsOf(EXPENSES_ROUTE);
    // The two that make a rejected claim correctable rather than merely
    // resubmittable. Named explicitly so that dropping either from the route
    // and from the screen together cannot quietly satisfy this test.
    expect(actions).toContain("addLine");
    expect(actions).toContain("removeLine");
    expect(actions).toContain("update");
    const source = screenAndParts(EXPENSES_SCREEN);
    const missing = actions.filter((a) => !source.includes(`action: "${a}"`));
    expect(missing, `${EXPENSES_SCREEN} sends nothing for ${missing.join(", ")}`).toEqual([]);
  });

  it("reads a claim back by its id, which is the only way to show one", () => {
    // `claimDetail` is addressed by claimId and by nothing else — the entity
    // comes off the claim — so this is the request that has to exist for a
    // detail view to exist at all.
    const source = screenAndParts(EXPENSES_SCREEN);
    expect(source).toContain("/api/ledger/expenses?claimId=");
  });
});

describe("what the assets screen has to say before it disposes of anything", () => {
  const disposal = read(DISPOSAL);

  it("works out the gain or loss from the same two figures the server uses", () => {
    // proceeds − (cost − accumulated). `disposeAsset` computes exactly this,
    // and a preview that computed anything else would be a figure the person
    // decided on and the ledger then contradicted.
    expect(disposal).toContain("const netBookValue = cost - accumulated;");
    expect(disposal).toContain("proceeds - netBookValue");
    expect(disposal).toContain('data-testid="disposal-result"');
  });

  it("names the gain and loss accounts the posting actually uses", () => {
    // 4900 and 6900 are fixed inside `disposeAsset`; a screen that offered a
    // choice, or named different ones, would be describing another posting.
    expect(disposal).toContain('const GAIN_ACCOUNT = "4900"');
    expect(disposal).toContain('const LOSS_ACCOUNT = "6900"');
  });

  it("says that the months since the last depreciation run fall into that gain or loss", () => {
    // The honest part. `disposeAsset` writes back the accumulated depreciation
    // the register holds and charges nothing further — ledger-assets.test.ts
    // pins that behaviour, disposing in April of an asset depreciated only to
    // March at a net book value with April still in it — so an asset that is
    // behind comes off too high and the difference lands in the wrong line of
    // the income statement. The screen has to say so where the figure is.
    expect(disposal).toContain("depreciatedTo");
    // Whitespace-tolerant: the sentence wraps in the source, and where the
    // line break falls is not what this is asserting.
    expect(disposal).toMatch(/gain or loss on disposal\s+rather than into depreciation/);
    expect(disposal).toContain('data-testid="disposal-depreciation-gap"');
  });

  it("sends the proceeds as minor units in a string, never as a JavaScript number", () => {
    // 2^53 minor units is about 90 trillion fils, and `parseAmount` returns a
    // BigInt precisely so that a write path never has to narrow one.
    expect(disposal).toContain("proceedsMinor: (proceeds as bigint).toString()");
    expect(disposal).not.toMatch(/Number\([^)]*\)\s*\*\s*100/);
    expect(disposal).not.toMatch(/proceedsMinor:\s*Number\(/);
  });

  it("offers the disposal only on an asset that has not already been disposed of", () => {
    const screen = read(ASSETS_SCREEN);
    expect(screen).toContain('a.status === "active"');
    expect(screen).toContain('data-testid="dispose-asset"');
  });
});

describe("what the claim detail has to say to somebody whose claim came back", () => {
  const detail = read(CLAIM_DETAIL);

  it("shows the reason the approver gave", () => {
    expect(detail).toContain("claim.rejectedReason");
    expect(detail).toContain('data-testid="claim-rejection"');
  });

  it("warns that sending the claim back to draft clears that reason", () => {
    // `reopenClaim` and `submitClaim` both null out `rejectedReason`, so the
    // instruction is gone the moment the claim moves. Telling somebody
    // afterwards is telling them nothing.
    expect(detail).toMatch(/cleared when it goes back to draft/);
    expect(detail).toContain("Back to draft");
  });

  it("says who may not approve it, which is what the claim's own raiser decides", () => {
    expect(detail).toContain("employeeCode");
    expect(detail).toMatch(/approved by somebody other than/);
  });

  it("reads the approval round from the server rather than guessing at one", () => {
    // A rejected round stands until it is withdrawn, and resubmitting the
    // claim does not touch it — so a claimant who fixes the receipt and is
    // still stuck is stuck on that. It is read per subject, so a claim with no
    // round says nothing at all instead of sending everybody to an empty
    // screen.
    expect(detail).toContain("subjectType=EXPENSE_CLAIM");
    expect(detail).toContain("/accounting/approvals");
    expect(detail).toMatch(/withdraw/i);
    expect(detail).toContain('data-testid="claim-approval-round"');
  });

  it("offers the line edits only while the claim is a draft", () => {
    // The server refuses them anywhere else — an approver has to see the same
    // claim the claimant submitted — so offering them would be offering a
    // refusal.
    expect(detail).toContain('const editable = claim.status === "draft";');
    expect(detail).toContain("editable ? removeLine : undefined");
  });
});

describe("the receipt editor is one implementation, not two", () => {
  it("keeps the VAT rules in the shared line form rather than on the screen", () => {
    // Drafting a new claim and correcting a rejected one are the same act with
    // the same rules. Two copies would drift, and the copy that drifted would
    // be the one that only runs after a rejection — the path nobody demos.
    const screen = read(EXPENSES_SCREEN);
    const form = read("src/components/ledger/claim-line-form.tsx");
    expect(form).toContain("fifteen-digit TRN");
    expect(screen).not.toContain("fifteen-digit TRN");
    expect(screen).toContain("ClaimLineFields");
    expect(read(CLAIM_DETAIL)).toContain("ClaimLineFields");
  });
});
