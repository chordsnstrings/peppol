import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  outstandingReturns,
  recordFiling,
  recordRegistration,
  taxPeriodsBetween,
} from "@/lib/server/ledger/tax-periods";

/**
 * Operations that are built, guarded, routed — and reachable from no screen.
 *
 * This is a defect the whole rest of the suite is blind to by construction.
 * Every module test proves the verb works; every route test proves the endpoint
 * accepts it; nothing anywhere asks whether a person using the product can get
 * to it. Three of them had been shipped that way: a VAT registration and a
 * filed return could not be recorded, though the VAT screen told the user to do
 * both and the Filed chip could never turn green; a customer record was
 * write-once, so a mistyped TRN — the number printed on every tax invoice they
 * will ever be sent — was permanent; and a recurring template could not be
 * edited, paused or ended, so a rent accrual went on posting after the lease
 * had ended.
 *
 * So the wiring is asserted from the ROUTE rather than from a list kept beside
 * it: every action a POST handler accepts has to be sent by the screen that
 * owns it, or be named here with the reason it is not. A verb added to a route
 * and forgotten in the browser fails this.
 */

const read = (path: string) => {
  expect(existsSync(path), `${path} is missing`).toBe(true);
  return readFileSync(path, "utf8");
};

/**
 * The actions a POST handler accepts, taken from its own body.
 *
 * Both shapes the routes are written in are matched — the `switch` over
 * `b.action` and the `if (b.action === …)` chain — because which one a route
 * uses is a style choice and this is not a check about style.
 */
function actionsOf(routePath: string): string[] {
  const source = read(routePath);
  const post = source.slice(source.indexOf("export async function POST"));
  expect(post.length).toBeGreaterThan(0);
  const found = new Set<string>();
  for (const m of post.matchAll(/case "([a-z_]+)":/g)) found.add(m[1]);
  for (const m of post.matchAll(/b\.action === "([a-z_]+)"/g)) found.add(m[1]);
  return [...found].sort();
}

/**
 * The screen and everything it renders.
 *
 * A screen that hands the work to a component has still wired the verb, so the
 * ledger components it imports are read with it. Anything else would push a
 * route's whole surface into one file to satisfy a test.
 */
function screenAndParts(screenPath: string): string {
  const screen = read(screenPath);
  const parts = [...screen.matchAll(/from "@\/components\/ledger\/([a-z0-9-]+)"/g)].map((m) => {
    // A component may be a .tsx or a plain .ts — the hooks are the latter.
    const base = `src/components/ledger/${m[1]}`;
    return read(existsSync(`${base}.tsx`) ? `${base}.tsx` : `${base}.ts`);
  });
  return [screen, ...parts].join("\n");
}

/** A verb a screen deliberately does not send, and why it need not. */
const EXCUSED: Record<string, Record<string, string>> = {
  "src/app/api/ledger/recurring/route.ts": {
    due:
      "`due` asks what a month would post and stores nothing. The screen runs the month and reads the same list " +
      "back from the run, with the outcome of each attached, so a separate dry run would be a second answer to " +
      "the same question.",
  },
};

const SCREENS: { route: string; screen: string; what: string }[] = [
  {
    route: "src/app/api/ledger/tax-periods/route.ts",
    screen: "src/app/(app)/accounting/vat/page.tsx",
    what: "the VAT screen records the registration and the filing",
  },
  {
    route: "src/app/api/ledger/counterparties/route.ts",
    screen: "src/app/(app)/accounting/customers/page.tsx",
    what: "the customers screen keeps the customer record",
  },
  {
    route: "src/app/api/ledger/recurring/route.ts",
    screen: "src/app/(app)/accounting/recurring/page.tsx",
    what: "the recurring screen governs its templates",
  },
];

describe("every routed write is reachable from the screen that owns it", () => {
  for (const { route, screen, what } of SCREENS) {
    it(what, () => {
      const actions = actionsOf(route);
      // The extraction itself has to be working, or an empty set would pass.
      expect(actions.length).toBeGreaterThan(1);
      const source = screenAndParts(screen);
      const excused = EXCUSED[route] ?? {};
      const missing = actions.filter((a) => !excused[a] && !source.includes(`action: "${a}"`));
      expect(missing, `${screen} sends nothing for ${missing.join(", ")}`).toEqual([]);
    });
  }

  it("names a reason for every verb a screen is excused from sending", () => {
    for (const [route, excuses] of Object.entries(EXCUSED)) {
      const actions = actionsOf(route);
      for (const [verb, reason] of Object.entries(excuses)) {
        // An excuse for a verb the route no longer has is an excuse nobody
        // will ever re-read — and it would hide the next verb of that name.
        expect(actions, `${route} no longer has a "${verb}" action`).toContain(verb);
        expect(reason.length).toBeGreaterThan(40);
      }
    }
  });
});

describe("what the screens have to say about the three operations", () => {
  const VAT = "src/app/(app)/accounting/vat/page.tsx";
  const CUSTOMERS = "src/app/(app)/accounting/customers/page.tsx";
  const RECURRING = "src/app/(app)/accounting/recurring/page.tsx";

  it("says whether the VAT periods on screen are recorded or assumed", () => {
    const source = screenAndParts(VAT);
    // Both words, because the whole point is that the two look identical
    // otherwise: a registrant on the Feb/May/Aug/Nov stagger reading a screen
    // that shows calendar quarters has no way to tell.
    expect(source).toMatch(/"assumed"/);
    expect(source).toMatch(/"recorded"/);
    expect(source).toContain("period-source");
  });

  it("takes the periods a filing may be recorded for from the server's outstanding list", () => {
    const source = screenAndParts(VAT);
    // Not a list built in the browser: `recordFiling` accepts exactly the
    // labels `outstandingReturns` produces, and refuses everything else.
    expect(source).toContain("outstanding.periods");
    expect(source).toContain("periodLabel");
  });

  it("lets an archived customer be seen and restored", () => {
    const source = screenAndParts(CUSTOMERS);
    expect(source).toContain("includeArchived=1");
    expect(source).toContain('action: "restore"');
  });

  it("parses a credit limit with the ledger's own parser rather than a float", () => {
    const source = read(CUSTOMERS);
    // `Number(x) * 100` on a write path is both a float touching minor units
    // and wrong by a factor of ten for a three-decimal currency.
    expect(source).not.toMatch(/Number\([^)]*\)\s*\*\s*100/);
    expect(source).toContain("parseAmount");
  });

  it("gives the recurring table an actions column", () => {
    const source = read(RECURRING);
    expect(source).toMatch(/<th[^>]*>\s*<span className="sr-only">Actions<\/span>/);
  });
});

/* ============================ and the same wiring, against the real server */

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-screens";
const ENT = "t-ent-screens";

async function wipe() {
  await db.$executeRawUnsafe(
    `DELETE FROM "TaxFiling" WHERE "registrationId" IN (SELECT id FROM "TaxRegistration" WHERE "orgId" = '${ORG}')`,
  );
  await db.$executeRawUnsafe(`DELETE FROM "TaxRegistration" WHERE "orgId" = '${ORG}'`);
}

d("the filing picker offers what the filing verb accepts", () => {
  beforeAll(async () => {
    await wipe();
    // The stagger the calendar never guesses right.
    await recordRegistration({
      orgId: ORG,
      entityId: ENT,
      trn: "100123456700003",
      frequency: "QUARTERLY",
      firstPeriodEndMonth: 2,
      registeredOn: "2024-01-01",
    });
  });
  afterAll(async () => {
    await wipe();
    await db.$disconnect();
  });

  const ASOF = "2026-09-05";

  it("recognises every label on the outstanding list", async () => {
    const outstanding = await outstandingReturns({ orgId: ORG, entityId: ENT, asOf: ASOF });
    expect(outstanding.registered).toBe(true);
    expect(outstanding.periods.length).toBeGreaterThan(0);

    // Each of them, in turn, is a period the filing verb will take. This is
    // the contract the screen depends on: the picker is built from the first
    // list and validated by the second, and if they ever parted the control
    // would refuse everything it offered.
    for (const period of outstanding.periods) {
      const filing = await recordFiling({
        orgId: ORG,
        entityId: ENT,
        periodLabel: period.label,
        filedOn: period.dueOn <= ASOF ? period.dueOn : ASOF,
        // Who said it went. The database refuses a filing date with no filer
        // against it — a filing nobody signed is the inference the whole table
        // exists to replace — and the route takes it from the session.
        filedBy: "u-screens",
        reference: `VAT-${period.label}`,
        netVatMinor: "125000",
        asOf: ASOF,
      });
      expect(filing.periodLabel).toBe(period.label);
      expect(filing.netVatMinor).toBe("125000");
    }

    // And once they are all recorded there is nothing outstanding, which is
    // what turns the chip on the screen from a warning into a date.
    const after = await outstandingReturns({ orgId: ORG, entityId: ENT, asOf: ASOF });
    expect(after.periods).toEqual([]);
  });

  it("never offers the period that is still running", async () => {
    const outstanding = await outstandingReturns({ orgId: ORG, entityId: ENT, asOf: ASOF });
    const current = taxPeriodsBetween({ frequency: "QUARTERLY", firstPeriodEndMonth: 2 }, ASOF, ASOF)[0];
    expect(current.to > ASOF).toBe(true);
    expect(outstanding.periods.map((p) => p.label)).not.toContain(current.label);

    // Because there is no return to file for it, and a picker that offered it
    // would be offering a refusal.
    await expect(
      recordFiling({ orgId: ORG, entityId: ENT, periodLabel: current.label, asOf: ASOF }),
    ).rejects.toThrow(/has not ended/);
  });
});
