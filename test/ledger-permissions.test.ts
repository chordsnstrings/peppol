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
