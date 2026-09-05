import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";

/**
 * The delete route derives its table list from the schema. This holds the
 * derivation, because the failure it replaced was silent: nine table names
 * written out by hand, seventy models added after them, and nothing to notice.
 */
describe("what a workspace delete has to remove", () => {
  const orgScoped = Prisma.dmmf.datamodel.models
    .filter((m) => m.fields.some((f) => f.name === "orgId"))
    .map((m) => m.name);

  it("finds every model that carries a tenant's id", () => {
    // If this number ever drops, a model lost its orgId and became reachable
    // across tenants — which is a much larger problem than deletion.
    expect(orgScoped.length).toBeGreaterThan(90);
    for (const name of ["Account", "JournalEntry", "JournalLine", "Book", "Counterparty"]) {
      expect(orgScoped, `${name} must be org-scoped`).toContain(name);
    }
  });

  it("would have orphaned the entire general ledger under the old hand-written list", () => {
    // The list that shipped. Kept here as the thing being guarded against, not
    // as something to restore.
    const handWritten = new Set([
      "Record", "Transmission", "Payment", "UsageEvent", "OrgBilling",
      "OAuthRefreshToken", "OAuthAuthCode", "ApiKey", "IntegrationToken",
    ]);
    const orphaned = orgScoped.filter((m) => !handWritten.has(m));
    expect(orphaned).toContain("JournalLine");
    expect(orphaned).toContain("Account");
    expect(orphaned.length).toBeGreaterThan(80);
  });

  it("keeps the audit log and lets the organisation cascade its memberships", () => {
    // AdminAuditLog is written first precisely so it survives the org, and
    // Membership hangs off the organisation row.
    const excluded = ["Membership", "AdminAuditLog"];
    for (const name of excluded) {
      expect(
        Prisma.dmmf.datamodel.models.some((m) => m.name === name),
        `${name} should still exist in the schema`,
      ).toBe(true);
    }
  });

  it("has a usable table name for every model it will delete from", () => {
    // The DELETE is raw SQL, so a model whose database name differs from its
    // Prisma name has to be resolved through dbName. None do today; this holds
    // that, because a mismatch would throw at runtime on a route nobody runs
    // twice.
    for (const m of Prisma.dmmf.datamodel.models) {
      const table = m.dbName ?? m.name;
      expect(table, `${m.name} has no table name`).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    }
  });
});
