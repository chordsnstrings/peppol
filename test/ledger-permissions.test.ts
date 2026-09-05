import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  PERMISSIONS, CONFLICTS, BUILT_IN_ROLES, seedBuiltInRoles,
  createRole, updateRole, assignRole, revokeRole,
  check, requirePermission, permissionsOf, rolesOverview, PermissionError,
} from "@/lib/server/ledger/permissions";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-perm";
const ENT_A = "t-ent-perm-a";
const ENT_B = "t-ent-perm-b";

const FARAH = "u-farah";
const OMAR = "u-omar";
const NOUR = "u-nour";

async function wipe() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "RoleAssignment" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "AccountingRole" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "Membership" WHERE "orgId" = '${ORG}'`),
    db.$executeRawUnsafe(`DELETE FROM "User" WHERE id IN ('${FARAH}','${OMAR}','${NOUR}')`),
    db.$executeRawUnsafe(`DELETE FROM "Organization" WHERE id = '${ORG}'`),
  ]);
}

describe("the permission catalogue", () => {
  it("has no duplicate keys, because a duplicate is a permission checked twice and granted once", () => {
    const keys = PERMISSIONS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("says what every permission actually lets somebody do", () => {
    for (const p of PERMISSIONS) {
      expect(p.effect.length).toBeGreaterThan(20);
      expect(p.effect.trim().endsWith(".")).toBe(true);
    }
  });

  it("only ships roles built from permissions that exist", () => {
    const keys = new Set(PERMISSIONS.map((p) => p.key));
    for (const r of BUILT_IN_ROLES) {
      expect(r.permissions.length).toBeGreaterThan(0);
      for (const p of r.permissions) expect(keys.has(p), `${r.code} grants ${p}`).toBe(true);
    }
  });

  it("names both sides of every conflict from the catalogue", () => {
    const keys = new Set(PERMISSIONS.map((p) => p.key));
    for (const c of CONFLICTS) {
      expect(keys.has(c.a), c.a).toBe(true);
      expect(keys.has(c.b), c.b).toBe(true);
      expect(c.why.length).toBeGreaterThan(40);
    }
  });

  it("ships an owner role that can do everything, including handing it on", () => {
    const owner = BUILT_IN_ROLES.find((r) => r.code === "OWNER")!;
    expect(owner.permissions).toEqual(PERMISSIONS.map((p) => p.key));
    expect(owner.permissions).toContain("roles.manage");
  });

  it("keeps salaries out of the general read", () => {
    const viewer = BUILT_IN_ROLES.find((r) => r.code === "VIEWER")!;
    expect(viewer.permissions).toContain("ledger.read");
    expect(viewer.permissions).not.toContain("payroll.read");
  });

  it("ships no role that defeats a control the software itself relies on", () => {
    for (const r of BUILT_IN_ROLES) {
      if (r.code === "OWNER") continue; // The owner is the exception, by definition.
      const held = new Set(r.permissions);
      for (const c of CONFLICTS.filter((x) => x.weight === "control")) {
        expect(held.has(c.a) && held.has(c.b), `${r.code} holds both ${c.a} and ${c.b}`).toBe(false);
      }
    }
  });

  it("weighs a conflict a small business will knowingly accept differently", () => {
    // The accountant who both posts and closes is how most books in the
    // country are kept. Listing that beside "one person can pay themselves"
    // would teach people to dismiss the list.
    const accountant = BUILT_IN_ROLES.find((r) => r.code === "ACCOUNTANT")!;
    const held = new Set(accountant.permissions);
    const noted = CONFLICTS.filter((c) => c.weight === "note" && held.has(c.a) && held.has(c.b));
    expect(noted).toHaveLength(1);
    expect(noted[0].why).toMatch(/worth knowing rather than worth refusing/);
  });
});

d("who may do what", () => {
  beforeAll(async () => {
    await wipe();
    await db.organization.create({ data: { id: ORG, name: "Permission Test LLC", slug: ORG } });
    for (const [id, name, email] of [
      [FARAH, "Farah", "farah@test.ae"],
      [OMAR, "Omar", "omar@test.ae"],
      [NOUR, "Nour", "nour@test.ae"],
    ] as const) {
      await db.user.create({ data: { id, name, email, passwordHash: "x" } });
      await db.membership.create({ data: { userId: id, orgId: ORG, role: "MEMBER" } });
    }
    await seedBuiltInRoles({ orgId: ORG });
  });
  afterAll(async () => { await wipe(); await db.$disconnect(); });

  it("lets everybody do everything until somebody has said otherwise", async () => {
    // The state every existing workspace is in. An upgrade that locks people
    // out of their own books at the month end is worse than no permissions.
    const d1 = await check({ orgId: ORG, userId: FARAH, permission: "payment_run.release" });
    expect(d1.allowed).toBe(true);
    expect(d1.unconfigured).toBe(true);
    expect(d1.reason).toMatch(/no roles have been set up/i);
  });

  it("seeds the shipped roles without duplicating them on a second run", async () => {
    const before = await db.accountingRole.count({ where: { orgId: ORG } });
    await seedBuiltInRoles({ orgId: ORG });
    expect(await db.accountingRole.count({ where: { orgId: ORG } })).toBe(before);
    expect(before).toBe(BUILT_IN_ROLES.length);
  });

  it("starts enforcing the moment the first grant is made", async () => {
    await assignRole({ orgId: ORG, userId: FARAH, roleCode: "BOOKKEEPER" });

    const post = await check({ orgId: ORG, userId: FARAH, permission: "ledger.post" });
    expect(post.allowed).toBe(true);
    expect(post.unconfigured).toBe(false);

    const release = await check({ orgId: ORG, userId: FARAH, permission: "payment_run.release" });
    expect(release.allowed).toBe(false);
    expect(release.reason).toMatch(/not part of the role you hold \(BOOKKEEPER\)/);
  });

  it("leaves a member with no role able to do nothing, and says so", async () => {
    const d2 = await check({ orgId: ORG, userId: NOUR, permission: "ledger.read" });
    expect(d2.allowed).toBe(false);
    expect(d2.reason).toMatch(/no role on this entity yet/i);
  });

  it("adds roles together rather than making them compete", async () => {
    await assignRole({ orgId: ORG, userId: FARAH, roleCode: "APPROVER" });
    const { held } = await permissionsOf({ orgId: ORG, userId: FARAH });
    // From BOOKKEEPER.
    expect(held.has("ledger.post")).toBe(true);
    // From APPROVER.
    expect(held.has("payment_run.approve")).toBe(true);
  });

  it("reports a separation of duties somebody now holds, rather than refusing it", async () => {
    const o = await rolesOverview({ orgId: ORG });
    const farah = o.people.find((p) => p.userId === FARAH)!;
    const clash = farah.conflicts.find((c) => c.a === "payment_run.propose" && c.b === "payment_run.approve");
    expect(clash).toBeDefined();
    expect(clash!.why).toMatch(/one person who can do both/i);

    // Reported, not blocked: a one-person business genuinely needs both, and
    // software that refuses to let a sole trader pay a supplier gets worked
    // around. The control that must not be negotiable is in the database.
    const still = await check({ orgId: ORG, userId: FARAH, permission: "payment_run.approve" });
    expect(still.allowed).toBe(true);
  });

  it("scopes a grant to one entity when it is given for one entity", async () => {
    await assignRole({ orgId: ORG, userId: OMAR, roleCode: "ACCOUNTANT", entityId: ENT_A });

    const onA = await check({ orgId: ORG, userId: OMAR, entityId: ENT_A, permission: "period.close" });
    expect(onA.allowed).toBe(true);

    const onB = await check({ orgId: ORG, userId: OMAR, entityId: ENT_B, permission: "period.close" });
    expect(onB.allowed).toBe(false);
  });

  it("treats a grant with no entity as a grant on all of them", async () => {
    const onB = await check({ orgId: ORG, userId: FARAH, entityId: ENT_B, permission: "ledger.post" });
    expect(onB.allowed).toBe(true);
  });

  it("refuses to grant a permission the product does not have", async () => {
    await expect(createRole({
      orgId: ORG, code: "MADE_UP", name: "Made up", permissions: ["ledger.read", "ledger.destroy"],
    })).rejects.toThrow(/ledger\.destroy is not a permission this product has/);
  });

  it("refuses a role that grants nothing", async () => {
    await expect(createRole({ orgId: ORG, code: "EMPTY", name: "Empty", permissions: [] }))
      .rejects.toThrow(/assigned by mistake and then wondered about/i);
  });

  it("refuses a role code somebody will mistype", async () => {
    await expect(createRole({ orgId: ORG, code: "Sales Manager", name: "Sales", permissions: ["ledger.read"] }))
      .rejects.toThrow(/capitals, digits and underscores/i);
  });

  it("refuses to redefine a role the product ships", async () => {
    await expect(updateRole({ orgId: ORG, code: "APPROVER", permissions: ["ledger.read"] }))
      .rejects.toThrow(/would mean something different in every workspace/i);
  });

  it("makes a role of its own, and edits it", async () => {
    const made = await createRole({
      orgId: ORG, code: "CREDIT_CONTROL", name: "Credit control",
      description: "Chases customers and nothing else.",
      permissions: ["ledger.read", "ar.credit_hold", "ar.manage"],
    });
    expect(made.builtIn).toBe(false);

    const edited = await updateRole({ orgId: ORG, code: "CREDIT_CONTROL", permissions: ["ledger.read", "ar.credit_hold"] });
    expect(edited.permissions).toEqual(["ledger.read", "ar.credit_hold"]);
  });

  it("refuses a duplicate role code, naming what is already there", async () => {
    await expect(createRole({ orgId: ORG, code: "CREDIT_CONTROL", name: "Another", permissions: ["ledger.read"] }))
      .rejects.toThrow(/already exists — it is "Credit control"/);
  });

  it("refuses to grant a role to somebody who is not a member", async () => {
    await expect(assignRole({ orgId: ORG, userId: "u-stranger", roleCode: "VIEWER" }))
      .rejects.toThrow(/not a member of this workspace/i);
  });

  it("throws for a route that has decided the answer matters", async () => {
    await expect(requirePermission({ orgId: ORG, userId: NOUR, permission: "ledger.post" }))
      .rejects.toThrow(PermissionError);
  });

  it("refuses a permission name that is not in the catalogue, rather than answering no", async () => {
    // Answering "no" to a typo would lock a screen for everybody with no clue why.
    await expect(check({ orgId: ORG, userId: FARAH, permission: "ledger.destroy" }))
      .rejects.toThrow(/is not a permission this product has/);
  });

  /* ------------------------------------------------- the last way out */

  it("will not let a workspace lock itself out of its own permissions", async () => {
    await assignRole({ orgId: ORG, userId: NOUR, roleCode: "OWNER" });
    await expect(revokeRole({ orgId: ORG, userId: NOUR, roleCode: "OWNER" }))
      .rejects.toThrow(/last grant of "Manage roles"/i);

    // With a second owner it comes away, because there is still a way back in.
    await assignRole({ orgId: ORG, userId: OMAR, roleCode: "OWNER" });
    const gone = await revokeRole({ orgId: ORG, userId: NOUR, roleCode: "OWNER" });
    expect(gone.revoked).toBe("OWNER");
  });

  it("says when a role was not granted in the first place", async () => {
    await expect(revokeRole({ orgId: ORG, userId: NOUR, roleCode: "VIEWER" }))
      .rejects.toThrow(/was not granted to that person/i);
  });

  it("gives the screen the roles, the people and who is holding nothing", async () => {
    const o = await rolesOverview({ orgId: ORG });
    expect(o.unconfigured).toBe(false);
    expect(o.roles.map((r) => r.code)).toContain("CREDIT_CONTROL");
    expect(o.roles.find((r) => r.code === "OWNER")!.builtIn).toBe(true);
    expect(o.catalogue.length).toBe(PERMISSIONS.length);
    // Nour lost the owner role above and holds nothing else.
    expect(o.unassigned).toContain("nour@test.ae");
  });

  it("does not see another organisation's roles", async () => {
    const other = await rolesOverview({ orgId: "some-other-org" });
    expect(other.roles).toHaveLength(0);
    expect(other.people).toHaveLength(0);
    expect(other.unconfigured).toBe(true);
  });
});

/* ------------------------------------------ what the report routes ask for */

/**
 * The keys the reporting and setup routes guard themselves with.
 *
 * Nothing in this repo can call a route from a test — no test imports from
 * `src/app/api`, and there is no HTTP harness to build one on — so what is
 * proved here is the guard, against the same keys the route files pass to it.
 * The table is written out route by route on purpose: a reader who wants to
 * know what a viewer can reach should be able to read it here rather than
 * grep nineteen files, and a key changed in a route without changing this
 * table is the one thing this arrangement cannot catch.
 */
const ROUTE_KEYS: { route: string; permission: string; why: string }[] = [
  { route: "GET /api/ledger/accounts", permission: "ledger.read", why: "the chart" },
  { route: "GET /api/ledger/accounts/[code]", permission: "ledger.read", why: "one account's general ledger" },
  { route: "GET /api/ledger/analytics", permission: "ledger.read", why: "tests over the journals" },
  { route: "GET /api/ledger/attention", permission: "ledger.read", why: "the attention list" },
  { route: "GET /api/ledger/comparatives", permission: "ledger.read", why: "two periods of statements" },
  { route: "GET /api/ledger/cashflow", permission: "ledger.read", why: "the indirect statement" },
  { route: "GET /api/ledger/cash-flow-direct", permission: "ledger.read", why: "the direct statement" },
  { route: "GET /api/ledger/consolidation", permission: "ledger.read", why: "group accounts" },
  { route: "GET /api/ledger/equity", permission: "ledger.read", why: "changes in equity" },
  { route: "GET /api/ledger/exports", permission: "ledger.read", why: "the widest read there is" },
  { route: "GET /api/ledger/faf", permission: "ledger.read", why: "the FTA audit file" },
  { route: "GET /api/ledger/forecast", permission: "ledger.read", why: "the cash projection" },
  { route: "GET /api/ledger/budget", permission: "ledger.read", why: "plan beside actual" },
  { route: "GET /api/ledger/segments", permission: "ledger.read", why: "the IFRS 8 note" },
  { route: "GET /api/ledger/dimensions", permission: "ledger.read", why: "cost-centre reporting" },
  { route: "GET /api/ledger/layouts", permission: "ledger.read", why: "saved layouts and their reports" },
  { route: "GET /api/ledger/notifications", permission: "ledger.read", why: "the queue" },
  { route: "POST /api/ledger/notifications", permission: "ledger.read", why: "acknowledging a row" },
  { route: "POST /api/ledger/layouts (preview)", permission: "ledger.read", why: "a render, not a save" },
  { route: "POST /api/ledger/accounts", permission: "chart.edit", why: "adding an account" },
  { route: "POST /api/ledger/dimensions", permission: "chart.edit", why: "what a journal line must carry" },
  { route: "POST /api/ledger/setup", permission: "setup.manage", why: "opening the books" },
  { route: "POST /api/ledger/opening", permission: "setup.manage", why: "opening balances" },
  { route: "POST /api/ledger/exports", permission: "setup.manage", why: "migrating a ledger in" },
  { route: "POST /api/ledger/budget", permission: "setup.manage", why: "setting a scenario" },
  { route: "POST /api/ledger/layouts (save)", permission: "setup.manage", why: "how statements are shown" },
  { route: "POST /api/ledger/consolidation", permission: "setup.manage", why: "who is in the group" },
];

const READ_ROUTES = ROUTE_KEYS.filter((r) => r.permission === "ledger.read");
const WRITE_ROUTES = ROUTE_KEYS.filter((r) => r.permission !== "ledger.read");

const ORG2 = "t-org-perm-routes";
const AISHA = "u-aisha";   // Viewer.
const RASHID = "u-rashid"; // Accountant.
const SAM = "u-sam";       // A member with no role at all.

async function wipe2() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "RoleAssignment" WHERE "orgId" = '${ORG2}'`),
    db.$executeRawUnsafe(`DELETE FROM "AccountingRole" WHERE "orgId" = '${ORG2}'`),
    db.$executeRawUnsafe(`DELETE FROM "Membership" WHERE "orgId" = '${ORG2}'`),
    db.$executeRawUnsafe(`DELETE FROM "User" WHERE id IN ('${AISHA}','${RASHID}','${SAM}')`),
    db.$executeRawUnsafe(`DELETE FROM "Organization" WHERE id = '${ORG2}'`),
  ]);
}

d("the keys the ledger routes guard themselves with", () => {
  beforeAll(async () => {
    await wipe2();
    await db.organization.create({ data: { id: ORG2, name: "Route Guard LLC", slug: ORG2 } });
    for (const [id, name, email] of [
      [AISHA, "Aisha", "aisha@test.ae"],
      [RASHID, "Rashid", "rashid@test.ae"],
      [SAM, "Sam", "sam@test.ae"],
    ] as const) {
      await db.user.create({ data: { id, name, email, passwordHash: "x" } });
      await db.membership.create({ data: { userId: id, orgId: ORG2, role: "MEMBER" } });
    }
    await seedBuiltInRoles({ orgId: ORG2 });
    await assignRole({ orgId: ORG2, userId: AISHA, roleCode: "VIEWER" });
    await assignRole({ orgId: ORG2, userId: RASHID, roleCode: "ACCOUNTANT" });
    // Sam is deliberately left with nothing.
  });
  afterAll(async () => { await wipe2(); });

  it("names a key the product actually has for every route", () => {
    // A guard written with a key that is not in the catalogue throws for
    // everybody, including the owner, and the screen it protects goes dark
    // with no clue why. That is worse than the route being unguarded.
    const keys = new Set(PERMISSIONS.map((p) => p.key));
    for (const r of ROUTE_KEYS) expect(keys.has(r.permission), `${r.route} asks for ${r.permission}`).toBe(true);
  });

  it("refuses a member with no role every one of the reading routes", async () => {
    for (const r of READ_ROUTES) {
      const decision = await check({ orgId: ORG2, userId: SAM, permission: r.permission });
      expect(decision.allowed, r.route).toBe(false);
      await expect(requirePermission({ orgId: ORG2, userId: SAM, permission: r.permission }))
        .rejects.toThrow(PermissionError);
    }
  });

  it("lets a viewer read the statements, the exports and the audit file", async () => {
    for (const r of READ_ROUTES) {
      const decision = await check({ orgId: ORG2, userId: AISHA, permission: r.permission });
      expect(decision.allowed, `${r.route} — ${r.why}`).toBe(true);
    }
    // The export and the FTA audit file are the widest read in the product,
    // and a viewer can take both. That is what "read the books" means; there
    // is no narrower key, and withholding them would not withhold the figures.
    await requirePermission({ orgId: ORG2, userId: AISHA, permission: "ledger.read" });
  });

  it("stops a viewer changing the chart, opening the books or setting a budget", async () => {
    for (const r of WRITE_ROUTES) {
      await expect(
        requirePermission({ orgId: ORG2, userId: AISHA, permission: r.permission }),
        r.route,
      ).rejects.toThrow(PermissionError);
    }
    // And the refusal says what to do about it, rather than "forbidden".
    const decision = await check({ orgId: ORG2, userId: AISHA, permission: "chart.edit" });
    expect(decision.reason).toMatch(/somebody who can manage roles has to grant it/i);
  });

  it("lets the accountant edit the chart but not open the books", async () => {
    // POST /accounts and POST /dimensions are the accountant's work.
    const chart = await check({ orgId: ORG2, userId: RASHID, permission: "chart.edit" });
    expect(chart.allowed).toBe(true);
    // POST /setup, /opening and /exports are not: the shipped accountant role
    // does not hold setup.manage, and loading opening balances over a live
    // ledger is the one mistake nobody can post their way out of.
    await expect(requirePermission({ orgId: ORG2, userId: RASHID, permission: "setup.manage" }))
      .rejects.toThrow(PermissionError);
  });

  it("leaves a workspace that has configured no roles exactly as it was", async () => {
    // The state every existing workspace is in. Guarding nineteen routes must
    // cost it nothing at all — every key, for a member with no grant anywhere.
    for (const r of ROUTE_KEYS) {
      const decision = await check({
        orgId: "t-org-perm-routes-unconfigured", userId: SAM, permission: r.permission,
      });
      expect(decision.allowed, r.route).toBe(true);
      expect(decision.unconfigured, r.route).toBe(true);
    }
  });
});

describe("a refusal on the way out", () => {
  it("carries a 403, so a route that only calls handleError still answers one", async () => {
    // Half of these routes catch PermissionError themselves and half leave it
    // to handleError. Both have to end at 403: a 500 would read as a fault in
    // the product rather than as a permission somebody has to be granted.
    const { handleError } = await import("@/lib/server/http");
    const res = handleError(new PermissionError("Read the books is not part of the role you hold."));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Read the books is not part of the role you hold." });
  });
});

/* ------------------------------- the keys the trading routes guard with ---- */

/**
 * The sales, purchase, stock and cash routes, and what each of them asks for.
 *
 * Written out the same way and for the same reason as ROUTE_KEYS above: a
 * reader who wants to know whether a cashier can record a customer's cheque
 * should be able to read it here. Where one route file guards its actions
 * separately the action is named, because that is the whole point of guarding
 * them separately.
 */
const TRADING_KEYS: { route: string; permission: string; why: string }[] = [
  { route: "GET /api/ledger/ar/ageing", permission: "ledger.read", why: "who owes us, aged" },
  { route: "GET /api/ledger/ap/ageing", permission: "ledger.read", why: "what we owe, aged" },
  { route: "GET /api/ledger/counterparties", permission: "ledger.read", why: "the customer list, statements and the credit question" },
  { route: "GET /api/ledger/sales-orders", permission: "ledger.read", why: "the quotation and order book" },
  { route: "GET /api/ledger/deliveries", permission: "ledger.read", why: "the register and what is delivered unbilled" },
  { route: "GET /api/ledger/pricing", permission: "ledger.read", why: "what things sell for" },
  { route: "GET /api/ledger/procurement", permission: "ledger.read", why: "the order book and GRNI" },
  { route: "GET /api/ledger/inventory", permission: "ledger.read", why: "the stock valuation" },
  { route: "GET /api/ledger/landed-cost", permission: "ledger.read", why: "what freight added to cost" },
  { route: "GET /api/ledger/projects", permission: "ledger.read", why: "job costing, read down a dimension" },
  { route: "GET /api/ledger/revenue", permission: "ledger.read", why: "the contract register" },
  { route: "GET /api/ledger/subscriptions", permission: "ledger.read", why: "what falls due next" },
  { route: "GET /api/ledger/recurring", permission: "ledger.read", why: "the standing instructions" },
  { route: "GET /api/ledger/write-offs", permission: "ledger.read", why: "what could be written off, and what was" },
  { route: "GET /api/ledger/cheques", permission: "ledger.read", why: "the register and the diary" },
  { route: "GET /api/ledger/petty-cash", permission: "ledger.read", why: "whether each float reconciles" },
  { route: "POST /api/ledger/pricing (quote, variance)", permission: "ledger.read", why: "a question the screen asks on every keystroke" },
  { route: "POST /api/ledger/procurement (match)", permission: "ledger.read", why: "holding three documents up against each other" },
  { route: "POST /api/ledger/recurring (due)", permission: "ledger.read", why: "a preview of the month, stored nowhere" },

  { route: "POST /api/ledger/ar/post", permission: "ar.manage", why: "an invoice or a receipt into the books" },
  { route: "POST /api/ledger/counterparties (create, update, archive, restore)", permission: "ar.manage", why: "keeping the customer record" },
  { route: "POST /api/ledger/sales-orders", permission: "ar.manage", why: "quoting, ordering and invoicing" },
  { route: "POST /api/ledger/deliveries", permission: "ar.manage", why: "sending the goods out and taking them back" },
  { route: "POST /api/ledger/pricing (the rest)", permission: "ar.manage", why: "what a thing sells for" },
  { route: "POST /api/ledger/revenue", permission: "ar.manage", why: "contracts and recognising them" },
  { route: "POST /api/ledger/subscriptions", permission: "ar.manage", why: "invoicing on a schedule" },
  { route: "POST /api/ledger/write-offs (writeOff, reverse)", permission: "ar.manage", why: "derecognising a customer's debt" },
  { route: "POST /api/ledger/cheques (record RECEIVED, return/cancel a received cheque)", permission: "ar.manage", why: "settling and unsettling a receivable" },

  { route: "POST /api/ledger/counterparties (create on hold, hold, release)", permission: "ar.credit_hold", why: "stopping the next sale and letting it start again" },
  { route: "POST /api/ledger/sales-orders (credit override)", permission: "ar.credit_hold", why: "letting one sale past the stop" },

  { route: "POST /api/ledger/procurement (the rest)", permission: "ap.manage", why: "orders, goods receipts and matched invoices" },
  { route: "POST /api/ledger/landed-cost", permission: "ap.manage", why: "freight and duty on an import" },
  { route: "POST /api/ledger/inventory (receive)", permission: "ap.manage", why: "a goods receipt without an order" },
  { route: "POST /api/ledger/petty-cash (spend)", permission: "ap.manage", why: "a small purchase with input tax on it" },
  { route: "POST /api/ledger/cheques (record ISSUED, return/cancel an issued cheque)", permission: "ap.manage", why: "settling and unsettling a payable" },

  { route: "POST /api/ledger/inventory (the rest)", permission: "ledger.post", why: "issues, counts, write-downs and sweeps" },
  { route: "POST /api/ledger/recurring (the rest)", permission: "ledger.post", why: "the journal, written a month early" },

  { route: "POST /api/ledger/cheques (deposit, clear, bounce, represent)", permission: "bank.reconcile", why: "what the bank did with the paper" },
  { route: "POST /api/ledger/petty-cash (open, reimburse, return, close)", permission: "bank.reconcile", why: "money in and out of the bank" },

  { route: "POST /api/ledger/projects", permission: "chart.edit", why: "a value of the PROJECT dimension" },
  { route: "POST /api/ledger/write-offs (adjustVat)", permission: "tax.file", why: "Article 64(1) relief on the next return" },
];

const ORG3 = "t-org-perm-trading";
const LEILA = "u-leila";   // Bookkeeper.
const KHALID = "u-khalid"; // Approver.
const MAYA = "u-maya";     // Cashier.
const TARIQ = "u-tariq";   // A member with no role at all.

async function wipe3() {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "RoleAssignment" WHERE "orgId" = '${ORG3}'`),
    db.$executeRawUnsafe(`DELETE FROM "AccountingRole" WHERE "orgId" = '${ORG3}'`),
    db.$executeRawUnsafe(`DELETE FROM "Membership" WHERE "orgId" = '${ORG3}'`),
    db.$executeRawUnsafe(`DELETE FROM "User" WHERE id IN ('${LEILA}','${KHALID}','${MAYA}','${TARIQ}')`),
    db.$executeRawUnsafe(`DELETE FROM "Organization" WHERE id = '${ORG3}'`),
  ]);
}

d("the keys the trading routes guard themselves with", () => {
  beforeAll(async () => {
    await wipe3();
    await db.organization.create({ data: { id: ORG3, name: "Trading Guard LLC", slug: ORG3 } });
    for (const [id, name, email] of [
      [LEILA, "Leila", "leila@test.ae"],
      [KHALID, "Khalid", "khalid@test.ae"],
      [MAYA, "Maya", "maya@test.ae"],
      [TARIQ, "Tariq", "tariq@test.ae"],
    ] as const) {
      await db.user.create({ data: { id, name, email, passwordHash: "x" } });
      await db.membership.create({ data: { userId: id, orgId: ORG3, role: "MEMBER" } });
    }
    await seedBuiltInRoles({ orgId: ORG3 });
    await assignRole({ orgId: ORG3, userId: LEILA, roleCode: "BOOKKEEPER" });
    await assignRole({ orgId: ORG3, userId: KHALID, roleCode: "APPROVER" });
    await assignRole({ orgId: ORG3, userId: MAYA, roleCode: "CASHIER" });
    // Tariq is deliberately left with nothing.
  });
  afterAll(async () => { await wipe3(); });

  it("names a key the product actually has for every route", () => {
    const keys = new Set(PERMISSIONS.map((p) => p.key));
    for (const r of TRADING_KEYS) expect(keys.has(r.permission), `${r.route} asks for ${r.permission}`).toBe(true);
  });

  it("keeps stopping a sale apart from making one", async () => {
    // This is the separation the whole per-action split exists for. The
    // bookkeeper raises the invoices and cannot stop the customer; the approver
    // stops the customer and cannot raise an invoice. Guarding the customer
    // screen with one key would have collapsed the two.
    await requirePermission({ orgId: ORG3, userId: LEILA, permission: "ar.manage" });
    await expect(requirePermission({ orgId: ORG3, userId: LEILA, permission: "ar.credit_hold" }))
      .rejects.toThrow(PermissionError);

    await requirePermission({ orgId: ORG3, userId: KHALID, permission: "ar.credit_hold" });
    await expect(requirePermission({ orgId: ORG3, userId: KHALID, permission: "ar.manage" }))
      .rejects.toThrow(PermissionError);
  });

  it("stops the bookkeeper overriding a credit refusal on a sales order", async () => {
    // POST /sales-orders takes ar.manage for the sale and ar.credit_hold on
    // top when an overrideReason is present, because an override is the hold
    // being released for one sale, reached through "accept" instead.
    const sell = await check({ orgId: ORG3, userId: LEILA, permission: "ar.manage" });
    expect(sell.allowed).toBe(true);
    const override = await check({ orgId: ORG3, userId: LEILA, permission: "ar.credit_hold" });
    expect(override.allowed).toBe(false);
    expect(override.reason).toMatch(/credit hold/i);
  });

  it("lets the bookkeeper write a debt off but not claim the tax back", async () => {
    // The two halves of a bad debt are two decisions with two dates. Writing
    // it off is the sales ledger; taking the Article 64(1) relief lands on the
    // VAT return, so it takes the key that covers the return.
    await requirePermission({ orgId: ORG3, userId: LEILA, permission: "ar.manage" });
    await expect(requirePermission({ orgId: ORG3, userId: LEILA, permission: "tax.file" }))
      .rejects.toThrow(PermissionError);
  });

  it("lets the cashier bank a cheque and run the float without the sales ledger", async () => {
    // What the bank did with the paper, and money in and out of the tin.
    await requirePermission({ orgId: ORG3, userId: MAYA, permission: "bank.reconcile" });
    // But recording the cheque in the first place settles a receivable, and
    // that is not the cashier's to do.
    await expect(requirePermission({ orgId: ORG3, userId: MAYA, permission: "ar.manage" }))
      .rejects.toThrow(PermissionError);
    await expect(requirePermission({ orgId: ORG3, userId: MAYA, permission: "ledger.post" }))
      .rejects.toThrow(PermissionError);
  });

  it("keeps a project code out of the bookkeeper's hands, like any other coding change", async () => {
    // A project is a value of the PROJECT dimension, so it takes the same key
    // as the chart and the dimensions route — which the bookkeeper does not
    // hold, and the accountant does.
    await expect(requirePermission({ orgId: ORG3, userId: LEILA, permission: "chart.edit" }))
      .rejects.toThrow(PermissionError);
  });

  it("refuses a member with no role every one of these routes", async () => {
    for (const r of TRADING_KEYS) {
      const decision = await check({ orgId: ORG3, userId: TARIQ, permission: r.permission });
      expect(decision.allowed, r.route).toBe(false);
    }
  });

  it("costs a workspace with no roles configured nothing at all", async () => {
    // Sixteen more route files now ask before they act. A workspace that has
    // granted nothing must not notice — every key, for a member with no grant.
    for (const r of TRADING_KEYS) {
      const decision = await check({
        orgId: "t-org-perm-trading-unconfigured", userId: TARIQ, permission: r.permission,
      });
      expect(decision.allowed, r.route).toBe(true);
      expect(decision.unconfigured, r.route).toBe(true);
    }
  });
});
