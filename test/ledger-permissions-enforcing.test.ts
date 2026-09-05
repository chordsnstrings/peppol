import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { seedBuiltInRoles, assignRole, check, rolesOverview } from "@/lib/server/ledger/permissions";
import { createClaim, submitClaim, type NewClaimLine } from "@/lib/server/ledger/expenses";

/**
 * A permission guard, executed in the state where it says no.
 *
 * `ledger-permissions.test.ts` proves the permission MODULE: what a role
 * grants, how two grants add up, what a refusal says. What nothing proved is
 * the guard as a route actually runs it — with a real body, a real session and
 * a workspace that has configured roles. The three harnesses that drive routes
 * (the two HTTP verifiers and the browser one) each register a single user and
 * grant nothing, and a workspace with no `RoleAssignment` rows short-circuits
 * to "allowed" by design. So every guard added to a route was exercised only in
 * the one state in which it can never refuse, and the two cross-entity holes
 * this file was written for — the expense route resolving org-wide on every
 * action but `create`, the attachment route believing the request about which
 * books the record is in — both passed every test in the repository.
 *
 * The routes are imported and called directly. There is no server: a route
 * handler is a function from a Request to a Response, and the only thing
 * standing between a test and one of them is the session, which is mocked to
 * whichever person the test is acting as. Everything else — the guard, the
 * lookups it does, the module underneath — is the real code.
 */

/**
 * Who is signed in. Hoisted because `vi.mock` is, and read on every call rather
 * than captured, so a test can change seats between two requests.
 */
const seat = vi.hoisted(() => ({ orgId: "", userId: "" }));

vi.mock("@/lib/server/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/session")>();
  return { ...actual, requireSession: async () => ({ orgId: seat.orgId, userId: seat.userId }) };
});

import { POST as expensesPost } from "@/app/api/ledger/expenses/route";
import { POST as attachmentsPost } from "@/app/api/ledger/attachments/route";

const db = new PrismaClient();
const d = process.env.DATABASE_URL ? describe : describe.skip;

const ORG = "t-org-enforce";
const ENT_A = "t-ent-enforce-a";
const ENT_B = "t-ent-enforce-b";

const SALIM = "u-salim";   // Approver, on entity A only.
const NADIA = "u-nadia";   // Bookkeeper, on entity A only.
const ZAKI = "u-zaki";     // A member of the workspace holding no role at all.
const RANIA = "u-rania";   // Bookkeeper and approver at once — both sides of a control.

/** A second workspace that has never configured a role, which is most of them. */
const ORG_OPEN = "t-org-enforce-open";
const ENT_OPEN = "t-ent-enforce-open";
const ZAHRA = "u-zahra";

const PEOPLE = [SALIM, NADIA, ZAKI, RANIA, ZAHRA];

async function wipe(orgId: string) {
  await db.$transaction([
    db.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    db.$executeRawUnsafe(`DELETE FROM "Attachment" WHERE "orgId" = '${orgId}'`),
    db.$executeRawUnsafe(`DELETE FROM "ExpenseClaimLine" WHERE "orgId" = '${orgId}'`),
    db.$executeRawUnsafe(`DELETE FROM "ExpenseClaim" WHERE "orgId" = '${orgId}'`),
    db.$executeRawUnsafe(`DELETE FROM "RoleAssignment" WHERE "orgId" = '${orgId}'`),
    db.$executeRawUnsafe(`DELETE FROM "AccountingRole" WHERE "orgId" = '${orgId}'`),
    db.$executeRawUnsafe(`DELETE FROM "Membership" WHERE "orgId" = '${orgId}'`),
    db.$executeRawUnsafe(`DELETE FROM "User" WHERE id IN (${PEOPLE.map((p) => `'${p}'`).join(",")})`),
    db.$executeRawUnsafe(`DELETE FROM "Organization" WHERE id = '${orgId}'`),
  ]);
}

/** Sign in as somebody. Every route call below is made by whoever this names. */
function as(userId: string, orgId = ORG) {
  seat.orgId = orgId;
  seat.userId = userId;
}

interface RouteResult {
  status: number;
  body: {
    error?: string;
    claim?: { id: string; status: string; approvedBy?: string | null };
    attachment?: { id: string; entityId: string | null; deduplicated: boolean };
  };
}

async function post(
  handler: (req: Request) => Promise<Response>,
  path: string,
  body: unknown,
): Promise<RouteResult> {
  const res = await handler(new Request(`http://localhost${path}`, { method: "POST", body: JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as RouteResult["body"] };
}

const taxi: NewClaimLine = {
  spentOn: "2026-05-06", description: "Airport taxi", accountCode: "6400",
  netMinor: 100_000, vatMinor: 0, vatRecoverable: false, receiptRef: "R-1",
};

/** A claim somebody has handed to an approver — the state the guard matters in. */
async function submitted(orgId: string, entityId: string, reference: string) {
  const claim = await createClaim({
    orgId, entityId,
    claim: {
      reference, employeeCode: "E-100", employeeName: "Layla Haddad",
      claimedOn: "2026-05-10", lines: [taxi],
    },
  });
  return submitClaim({ orgId, claimId: claim.id });
}

/** A receipt to put behind a record: the smallest thing the module will accept. */
const receipt = {
  filename: "receipt.csv",
  mimeType: "text/csv",
  contentBase64: Buffer.from("date,amount\n2026-05-06,1000.00\n", "utf8").toString("base64"),
};

let claimA1 = "";
let claimA2 = "";
let claimB = "";
let claimOpen = "";

d("a permission guard on a route, in a workspace that has configured roles", () => {
  beforeAll(async () => {
    await wipe(ORG);
    await wipe(ORG_OPEN);

    await db.organization.create({ data: { id: ORG, name: "Enforcing LLC", slug: ORG } });
    await db.organization.create({ data: { id: ORG_OPEN, name: "Unconfigured LLC", slug: ORG_OPEN } });
    for (const [id, name, email, orgId] of [
      [SALIM, "Salim", "salim@test.ae", ORG],
      [NADIA, "Nadia", "nadia@test.ae", ORG],
      [ZAKI, "Zaki", "zaki@test.ae", ORG],
      [RANIA, "Rania", "rania@test.ae", ORG],
      [ZAHRA, "Zahra", "zahra@test.ae", ORG_OPEN],
    ] as const) {
      await db.user.create({ data: { id, name, email, passwordHash: "x" } });
      await db.membership.create({ data: { userId: id, orgId, role: "MEMBER" } });
    }

    await seedBuiltInRoles({ orgId: ORG });
    // Both grants are for one entity, because that is the arrangement the
    // cross-entity hole hides in: a person who is genuinely allowed the act,
    // somewhere, asking for it somewhere else.
    await assignRole({ orgId: ORG, userId: SALIM, roleCode: "APPROVER", entityId: ENT_A });
    await assignRole({ orgId: ORG, userId: NADIA, roleCode: "BOOKKEEPER", entityId: ENT_A });
    await assignRole({ orgId: ORG, userId: RANIA, roleCode: "BOOKKEEPER" });
    await assignRole({ orgId: ORG, userId: RANIA, roleCode: "APPROVER" });
    // Zaki is a member and holds nothing, which is not the same state as a
    // workspace that has configured nothing.

    // ORG_OPEN gets no roles at all — not even the shipped ones, because
    // seeding them is not what turns enforcement on. A grant is.

    claimA1 = (await submitted(ORG, ENT_A, "EXP-A1")).id;
    claimA2 = (await submitted(ORG, ENT_A, "EXP-A2")).id;
    claimB = (await submitted(ORG, ENT_B, "EXP-B1")).id;
    claimOpen = (await submitted(ORG_OPEN, ENT_OPEN, "EXP-OPEN")).id;
  });

  afterAll(async () => {
    await wipe(ORG);
    await wipe(ORG_OPEN);
    await db.$disconnect();
  });

  it("is actually enforcing, which is the whole point of this file", async () => {
    // If this ever fails, every refusal below becomes an allow and the suite
    // goes green while proving nothing — which is exactly what the harnesses
    // that drive routes have been doing.
    expect(await db.roleAssignment.count({ where: { orgId: ORG } })).toBeGreaterThan(0);
    const decision = await check({ orgId: ORG, userId: SALIM, entityId: ENT_A, permission: "expense.approve" });
    expect(decision.unconfigured).toBe(false);
  });

  /* ------------------------------------------- the act the role names ------ */

  it("lets the role that names the act do it, through the route that guards it", async () => {
    as(SALIM);
    const r = await post(expensesPost, "/api/ledger/expenses", { action: "approve", claimId: claimA1 });
    expect(r.status).toBe(200);
    expect(r.body.claim?.status).toBe("approved");
    // The approver is the session's, never the request's: the route passes
    // `userId` and there is no way to name somebody else.
    expect(r.body.claim?.approvedBy).toBe(SALIM);
  });

  it("refuses the same act to a role that does not name it, in the words the product means to show", async () => {
    as(NADIA);
    const r = await post(expensesPost, "/api/ledger/expenses", { action: "approve", claimId: claimA2 });
    expect(r.status).toBe(403);
    // Not "Forbidden": the refusal names the act, the role held and what to do
    // about it, and a screen shows it to a person word for word.
    expect(r.body.error).toMatch(/Approve expense claims is not part of the role you hold \(BOOKKEEPER\)/);
    expect(r.body.error).toMatch(/Somebody who can manage roles has to grant it/);

    // And the guard ran before the act, not beside it.
    const after = await db.expenseClaim.findUniqueOrThrow({ where: { id: claimA2 } });
    expect(after.status).toBe("submitted");
    expect(after.approvedBy).toBeNull();
  });

  it("refuses a member of the workspace who holds no role at all", async () => {
    as(ZAKI);
    const r = await post(expensesPost, "/api/ledger/expenses", { action: "approve", claimId: claimA2 });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/no role on this entity yet/i);
  });

  /* -------------------------------------- a grant on one entity only ------- */

  it("does not let a grant on one entity approve a claim in another", async () => {
    /* The defect this test exists for. The route guarded on `b.entityId`,
     * which only `create` sends — so approving, posting and paying asked the
     * org-wide question, and Salim, an approver on entity A alone, could
     * approve entity B's claims. The entity now comes off the claim. */
    as(SALIM);
    const r = await post(expensesPost, "/api/ledger/expenses", { action: "approve", claimId: claimB });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/no role on this entity yet/i);

    // Every action that names a claim by id goes through the one guard, so
    // rejecting, posting and paying are refused for the same reason and by the
    // same line. `reject` is the one of the three that needs no open books.
    const rejected = await post(expensesPost, "/api/ledger/expenses", {
      action: "reject", claimId: claimB, reason: "Not mine to decide on.",
    });
    expect(rejected.status).toBe(403);

    const after = await db.expenseClaim.findUniqueOrThrow({ where: { id: claimB } });
    expect(after.status).toBe("submitted");
  });

  it("is not fooled by a request that names the entity the caller does hold", async () => {
    // The interesting version of the same hole: a caller who knows which
    // entity they are allowed in says so in the body. The claim is still in
    // entity B, and the claim is what decides.
    as(SALIM);
    const r = await post(expensesPost, "/api/ledger/expenses", {
      action: "approve", claimId: claimB, entityId: ENT_A,
    });
    expect(r.status).toBe(403);
  });

  it("still checks the entity a claim is being raised in when there is no claim yet", async () => {
    // `create` is the one action whose entity genuinely comes from the request,
    // because the claim it names does not exist yet. Salim holds nothing on
    // entity B, so raising one there is refused — and raising one in entity A
    // is not.
    as(SALIM);
    const refused = await post(expensesPost, "/api/ledger/expenses", {
      action: "create", entityId: ENT_B,
      claim: { reference: "EXP-NEW-B", employeeCode: "E-200", employeeName: "Omar Said", claimedOn: "2026-05-11", lines: [taxi] },
    });
    expect(refused.status).toBe(403);
    expect(await db.expenseClaim.count({ where: { orgId: ORG, reference: "EXP-NEW-B" } })).toBe(0);

    const allowed = await post(expensesPost, "/api/ledger/expenses", {
      action: "create", entityId: ENT_A,
      claim: { reference: "EXP-NEW-A", employeeCode: "E-200", employeeName: "Omar Said", claimedOn: "2026-05-11", lines: [taxi] },
    });
    expect(allowed.status).toBe(200);
  });

  /* ------------------------------------------- evidence behind a record ---- */

  it("lets the role that may attach evidence attach it, and stamps the record's own entity on it", async () => {
    as(NADIA);
    // The body names entity B, which is a lie a client can tell for free. The
    // claim is in entity A, Nadia is a bookkeeper in entity A, and the row that
    // is written says entity A — which matters because the read and the removal
    // are both guarded on the entity the row carries.
    const r = await post(attachmentsPost, "/api/ledger/attachments", {
      entityId: ENT_B, subjectType: "EXPENSE_CLAIM", subjectId: claimA1, ...receipt,
    });
    expect(r.status).toBe(200);
    expect(r.body.attachment?.entityId).toBe(ENT_A);
  });

  it("does not let evidence be pushed onto another entity's record", async () => {
    /* The second defect. The POST guarded on the entity in the request while
     * the GET and the DELETE both read it off the row, so a bookkeeper in
     * entity A could name entity A, name entity B's claim as the subject, and
     * have the guard agree. */
    as(NADIA);
    const r = await post(attachmentsPost, "/api/ledger/attachments", {
      entityId: ENT_A, subjectType: "EXPENSE_CLAIM", subjectId: claimB, ...receipt,
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/no role on this entity yet/i);
    expect(await db.attachment.count({ where: { orgId: ORG, subjectId: claimB } })).toBe(0);
  });

  it("refuses a role that reads the books but was never given the evidence key", async () => {
    // The approver reads everything and writes nothing. Attaching is a write
    // into the record the books rest on, and `attachment.add` is what it takes.
    as(SALIM);
    const r = await post(attachmentsPost, "/api/ledger/attachments", {
      entityId: ENT_A, subjectType: "EXPENSE_CLAIM", subjectId: claimA1, ...receipt,
    });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/Attach evidence is not part of the role you hold \(APPROVER\)/);
  });

  /* ---------------------------------------- the escape hatch, held here ---- */

  it("leaves a workspace that has configured no roles able to do everything, through the routes", async () => {
    /* The one behaviour that must never change, asserted where it is felt
     * rather than where it is written. Zahra holds no role, her workspace has
     * no roles at all, and both routes behave exactly as they did before
     * permissions existed. A release that gets this wrong locks a business out
     * of its own books at a month end. */
    expect(await db.roleAssignment.count({ where: { orgId: ORG_OPEN } })).toBe(0);

    as(ZAHRA, ORG_OPEN);
    const approved = await post(expensesPost, "/api/ledger/expenses", { action: "approve", claimId: claimOpen });
    expect(approved.status).toBe(200);
    expect(approved.body.claim?.status).toBe("approved");

    const attached = await post(attachmentsPost, "/api/ledger/attachments", {
      subjectType: "EXPENSE_CLAIM", subjectId: claimOpen, ...receipt,
    });
    expect(attached.status).toBe(200);
    // Entity-scoped grants change nothing here either: there is nothing to
    // scope, and the row still records the books the claim is in.
    expect(attached.body.attachment?.entityId).toBe(ENT_OPEN);
  });

  /* ------------------------------------------ two hands, one person -------- */

  it("reports the separation of duties somebody now holds, and does not refuse it", async () => {
    /* Rania keeps the books and signs things off. Proposing a payment run and
     * approving it is the one separation a payment run exists for, and holding
     * both is reported — on her, on the screen — rather than refused, because
     * a business with one bookkeeper genuinely needs both and software that
     * says no gets worked around. The control that is not negotiable lives in
     * the database: a run's approver cannot be its preparer. */
    const overview = await rolesOverview({ orgId: ORG });
    const rania = overview.people.find((p) => p.userId === RANIA)!;

    const control = rania.conflicts.find((c) => c.a === "payment_run.propose" && c.b === "payment_run.approve");
    expect(control?.weight).toBe("control");
    expect(control?.why).toMatch(/one person who can do both/i);

    // And the weaker pair, which the shipped Bookkeeper holds on its own: the
    // rate a foreign bill is converted at sizes the approval band it falls in.
    const note = rania.conflicts.find((c) => c.a === "fx.rate" && c.b === "payment_run.propose");
    expect(note?.weight).toBe("note");

    // Reported, not blocked.
    const still = await check({ orgId: ORG, userId: RANIA, entityId: ENT_A, permission: "payment_run.approve" });
    expect(still.allowed).toBe(true);

    // Nobody else is dragged into it: Salim holds one side of the pair and is
    // reported nothing, which is what makes the report worth reading.
    const salim = overview.people.find((p) => p.userId === SALIM)!;
    expect(salim.conflicts).toEqual([]);
  });
});
